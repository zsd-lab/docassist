// server.js
import "dotenv/config";
import express from "express";
import OpenAI from "openai";

console.log("Starting doc-assist server...");

const app = express();
app.use(express.json());

// Init OpenAI client with API key from .env
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Simple helper that calls gpt-5.1 directly for now
async function runDocsAgent(text, instruction) {
  const model = "gpt-5.1";

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: `
You are an AI assistant integrated into Google Docs for David.

Your main tasks:
- Summarize long texts clearly and concisely.
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

// POST /docs-agent { text, instruction } -> { resultText }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Docs agent backend listening on http://localhost:${PORT}`);
});
