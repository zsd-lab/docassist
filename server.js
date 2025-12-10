// server.js
import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import pkg from "pg";

const { Pool } = pkg;

console.log("Starting doc-assist server...");

const app = express();
app.use(express.json());

// ====== POSTGRES POOL ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ====== KONFIG ======
const MAX_TURNS_PER_DOC = 10;        // max ennyi user+assistant turn/doksi
const MAX_DOC_CHARS = 15000;         // doksi szöveg max hossza (chathez)

const SYSTEM_PROMPT = `
You are ChatGPT working as David's writing, analysis, and thinking partner inside Google Docs.

You must:
- Read the given text very carefully and reason through it step by step before answering.
- Prefer clear structure: short paragraphs, bullet points where useful, explicit reasoning.
- When summarizing: capture arguments, structure, and nuance, not just a shallow summary.
- When improving style: preserve meaning, but raise clarity, flow, and professional tone.
- When answering questions about the document: always base your answer on the document's content and say explicitly if something is not supported by the text.
- You can answer in Hungarian or English, always matching David's language unless instructed otherwise.

Never show system messages or internal reasoning. Your output must always be directly usable in the document.
`.trim();

// Health check / info
app.get("/", (req, res) => {
  res.send("Docs agent backend is running");
});

// Init OpenAI client with API key from env
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ====== DB-ALAPÚ CHAT HISTORY STORE ======

/**
 * Adott docId-hez tartozó history lekérése időrendben.
 * Visszatérés: [{ role, content }, ...]
 */
async function getHistoryForDoc(docId) {
  const result = await pool.query(
    `
    SELECT role, content
    FROM chat_history
    WHERE doc_id = $1
    ORDER BY created_at ASC, id ASC
    `,
    [docId]
  );

  return result.rows.map((row) => ({
    role: row.role,
    content: row.content,
  }));
}

/**
 * Új üzenet beszúrása a history-ba, és a régiek levágása, ha túl sok.
 */
async function appendToHistory(docId, role, content) {
  // Beszúrjuk az új sort
  await pool.query(
    `
    INSERT INTO chat_history (doc_id, role, content)
    VALUES ($1, $2, $3)
    `,
    [docId, role, content]
  );

  const maxMessages = MAX_TURNS_PER_DOC * 2; // user+assistant per turn

  const countResult = await pool.query(
    `
    SELECT COUNT(*) AS cnt
    FROM chat_history
    WHERE doc_id = $1
    `,
    [docId]
  );

  const count = Number(countResult.rows[0].cnt);

  if (count > maxMessages) {
    const extra = count - maxMessages;

    // Legrégebbi extra sorok törlése
    await pool.query(
      `
      DELETE FROM chat_history
      WHERE id IN (
        SELECT id FROM chat_history
        WHERE doc_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2
      )
      `,
      [docId, extra]
    );
  }
}

// ====== ONE-SHOT FUNKCIÓ: runDocsAgent ======

/**
 * ONE-SHOT: kiválasztott szöveg + instruction feldolgozása (Process Selected Text).
 */
async function runDocsAgent(text, instruction) {
  const model = "gpt-5.1";

  const response = await client.chat.completions.create({
    model,
    reasoning_effort: "medium",
    max_completion_tokens: 800,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
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

// ====== CHAT FUNKCIÓ: runChatWithDoc ======

/**
 * CHAT: teljes doksi + konverzáció history alapján válaszol.
 *
 * - docId: Google Docs dokumentum ID
 * - docText: teljes dokumentumszöveg
 * - userMessage: aktuális user kérdés/utasítás
 */
async function runChatWithDoc(docId, docText, userMessage) {
  const model = "gpt-5.1";

  // Doksi vágása, hogy ne zabálja fel az egész kontextust
  const clippedDocText =
    docText.length > MAX_DOC_CHARS
      ? docText.slice(0, MAX_DOC_CHARS)
      : docText;

  // 1) Korábbi history lekérése DB-ből
  const history = await getHistoryForDoc(docId);

  // 2) Messages összeállítása
  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "system",
      content: `Here is the current document content (possibly truncated):\n\n${clippedDocText}`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  // 3) Modell hívása
  const response = await client.chat.completions.create({
    model,
    reasoning_effort: "medium",
    max_completion_tokens: 800,
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

  // 4) History frissítése a DB-ben
  await appendToHistory(docId, "user", userMessage);
  await appendToHistory(docId, "assistant", reply);

  return reply;
}

// ====== ENDPOINTOK ======

/**
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