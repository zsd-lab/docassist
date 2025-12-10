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

// Init OpenAI client with API key from env (Render: set OPENAI_API_KEY in dashboard)
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * ONE-SHOT FUNCTION
 * Uses gpt-5.1 to process a given text with an instruction (your existing flow).
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
 * CHAT WITH DOCUMENT FUNCTION
 * Receives:
 * - docId: Google Docs document ID (for logging / future use)
 * - docText: full document text
 * - history: [{role: "user"|"assistant", content: string}, ...]
 * Returns a reply that continues the conversation and uses the document as context.
 */
async function runChatWithDoc(docId, docText, history) {
  const model = "gpt-5.1";

  // We inject document content as system context, plus the conversation history
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
    // Then the conversation history (user + assistant turns)
    ...history,
  ];

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

  return msg.content.trim();
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
 * ROUTE: Chat with Document
 * POST /chat-docs
 * body: {
 *   docId: string,
 *   docText: string,
 *   history: [{ role: "user"|"assistant", content: string }]
 * }
 * reply: { reply: string }
 */
app.post("/chat-docs", async (req, res) => {
  try {
    const { docId, docText, history } = req.body;

    if (!docText || !Array.isArray(history)) {
      return res.status(400).json({
        error: "Missing 'docText' or 'history' (Array) in body.",
      });
    }

    const answer = await runChatWithDoc(docId, docText, history);
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
