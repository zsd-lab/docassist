// server.js (bootstrap)
import "dotenv/config";
import OpenAI from "openai";
import pkg from "pg";
import { createApp } from "./app.js";

const { Pool } = pkg;

console.log("Starting doc-assist server...");

const parseBool = (value, defaultValue) => {
  if (value == null || value === "") return defaultValue;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
};

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const requireToken = parseBool(process.env.DOCASSIST_REQUIRE_TOKEN, isProd);

if (isProd && !process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY (required in production)");
}

if (isProd && requireToken && !process.env.DOCASSIST_TOKEN) {
  throw new Error(
    "Missing DOCASSIST_TOKEN (required in production when DOCASSIST_REQUIRE_TOKEN is enabled)"
  );
}

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
