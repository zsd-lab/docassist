// server.js (bootstrap)
import "dotenv/config";
import OpenAI from "openai";
import pkg from "pg";
import { createApp } from "./app.js";

const { Pool } = pkg;

console.log("Starting doc-assist server...");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const { app, ensureTables, config } = createApp({
  pool,
  openaiClient,
});

await ensureTables();

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`DOCASSIST_BODY_LIMIT=${config.bodyLimit}`);
  console.log(`OPENAI_MODEL=${config.openaiModel}`);
  console.log(`DOCASSIST_MAX_OUTPUT_TOKENS=${config.maxOutputTokens}`);
  console.log(`DOCASSIST_TOKEN=${config.token ? "(set)" : "(not set)"}`);
});

export { createApp } from "./app.js";
