// server.js
import "dotenv/config";
import express from "express";
import OpenAI from "openai";

console.log("Starting doc-assist server...");

const app = express();
app.use(express.json());

// Health check / info
app.get("/", (req, res) => {
  res.send("Docs agent backend is running");
});

// Init OpenAI client with API key from env
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ====== IN-MEMORY CHAT HISTORY STORE ======
// docId -> [{ role: "user"|"assistant"|"system", content: string }, ... ]
const historyStore = new Map();
// max hány üzenetpárt tartsunk meg egy doksihoz (hogy ne nőjön végtelenre)
const MAX_TURNS_PER_DOC = 10;

/**
 * Helper: get history array for a docId
 */
function getHistoryForDoc(docId) {
  if (!historyStore.has(docId)) {
    historyStore.set(docId, []);
  }
  return historyStore.get(docId);
}

/**
 * Helper: push (role, content) to a doc's history, és limitáljuk a hosszát.
 */
function appendToHistory(docId, role, content) {
  const history = getHistoryForDoc(docId);
  history.push({ role, content });

  // Ha túl hosszú, vágjuk meg az elejéről
  const maxMessages = MAX_TURNS_PER_DOC * 2; // user+assistant per turn
  if (history.length > maxMessages) {
    const extra = history.length - maxMessages;
    history.splice(0, extra);
  }

  historyStore.set(docId, history);
}

/**
 * ONE-SHOT FUNCTION
 * Uses gpt-5.1 to process a given text with an instruction (existing flow).
 */
async function runDocsAgent(text, instruction) {
  const model = "gpt-5.1";

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: `
You are an AI assistant integrated into Google Docs for David.

Main tasks:
- Summarize selected text clearly and concisely.
- Rewrite text for clarity, structure, and style while preserving meaning.
- Translate between Hungarian and English in a professional tone.
- Extract bullet points, action items, and key arguments when asked.

Guidelines:
- If the user does not specify language, preserve the original language.
- Do not invent facts that are not present in the text.
- If you are unsure, say you are unsure instead of guessing.
- Preserve important technical terms and proper names.
- Never include system messages or internal reasoning in your answer.
      `.trim(),
      },
      {
        role: "user",
        content: `Context:\n${text}\n\nInstruction:\n${instruction}`,
      },
    ],
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error("No choices returned from model.");
  }

  const msg = response.choices[0].message;
  if (!msg || !msg.content) {
    throw new Error("No content in model response.");
  }

  return msg.content.trim();
}

/**
 * CHAT WITH DOCUMENT FUNCTION (server-side history)
 *
 * - docId: Google Docs document ID
 * - docText: full document text
 * - userMessage: current user question/instruction
 *
 * A history-t a szerver tartja `historyStore`-ban.
 */
async function runChatWithDoc(docId, docText, userMessage) {
  const model = "gpt-5.1";

  // 1) betöltjük a meglévő history-t
  const history = getHistoryForDoc(docId);

  // 2) összerakjuk a messages array-t:
  //    - system info
  //    - document content mint context
  //    - eddigi history (user+assistant)
  //    - mostani user message
  const messages = [
    {
      role: "system",
      content: `
You are an assistant helping David work with the content of a Google Docs document.

You receive:
- The full text of the current document,
- The conversation history so far between David (user) and you (assistant).

Your job:
- Answer the user's latest question or request.
- Base your answer primarily on the document content.
- If something is not in the document, say so clearly instead of hallucinating.
- You may reference earlier parts of the conversation if helpful.
- You may respond in Hungarian or English depending on the user's message.
      `.trim(),
    },
    {
      role: "system",
      content: `Here is the current document content:\n\n${docText}`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  // 3) hívjuk a modellt
  const response = await client.chat.completions.create({
    model,
    messages,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error("No choices returned from model.");
  }

  const msg = response.choices[0].message;
  if (!msg || !msg.content) {
    throw new Error("No content in model response.");
  }

  const reply = msg.content.trim();

  // 4) history frissítése a szerveren
  appendToHistory(docId, "user", userMessage);
  appendToHistory(docId, "assistant", reply);

  return reply;
}

/**
 * ROUTE: One-shot processing (existing behavior)
 * POST /docs-agent
 * body: { text: string, instruction: string }
 * reply: { resultText: string }
 */
app.post("/docs-agent", async (req, res) => {
  try {
    const { text, instruction } = req.body;

    if (!text || !instruction) {
      return res.status(400).json({
        error: "Missing 'text' or 'instruction' in body.",
      });
    }

    const resultText = await runDocsAgent(text, instruction);
    res.json({ resultText });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
});

/**
 * ROUTE: Chat with Document (server-side history)
 * POST /chat-docs
 * body: {
 *   docId: string,
 *   docText: string,
 *   userMessage: string
 * }
 * reply: { reply: string }
 */
app.post("/chat-docs", async (req, res) => {
  try {
    const { docId, docText, userMessage } = req.body;

    if (!docId || !docText || !userMessage) {
      return res.status(400).json({
        error: "Missing 'docId', 'docText' or 'userMessage' in body.",
      });
    }

    const answer = await runChatWithDoc(docId, docText, userMessage);
    res.json({ reply: answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Docs agent backend listening on port ${PORT}`);
});
