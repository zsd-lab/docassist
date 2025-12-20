#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import OpenAI from "openai";
import pkg from "pg";

const { Pool } = pkg;

function usage(exitCode = 0) {
  const cmd = path.basename(process.argv[1] || "export_openai_conversations.mjs");
  // eslint-disable-next-line no-console
  console.log(`
Export ALL DocAssist v2 conversations from OpenAI into a single .txt file.

This script:
- reads conversation IDs from Postgres table docs_sessions
- fetches conversation items from OpenAI (conversations.items.list)
- writes one combined text export

Usage:
  node scripts/${cmd} [--out <path>] [--databaseUrl <url>]

Environment:
  DATABASE_URL     Postgres connection string (used if --databaseUrl not provided)
  OPENAI_API_KEY   OpenAI API key

Examples:
  node scripts/${cmd} --out ./docassist-openai-chats.txt
`);
  process.exit(exitCode);
}

function getArg(name) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return argv[idx + 1] ?? "";
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function validateDatabaseUrlOrExit(databaseUrl) {
  const s = String(databaseUrl || "").trim();
  if (!s) {
    // eslint-disable-next-line no-console
    console.error("Missing DATABASE_URL (set env var or pass --databaseUrl)");
    process.exit(2);
  }

  if (/USER:PASSWORD@HOST/i.test(s) || /@HOST:/i.test(s)) {
    // eslint-disable-next-line no-console
    console.error(
      "DATABASE_URL looks like a placeholder. Paste a real Postgres URL (host/user/pass/db, and a numeric port)."
    );
    process.exit(2);
  }

  let url;
  try {
    url = new URL(s);
  } catch (_) {
    // eslint-disable-next-line no-console
    console.error(
      "Invalid DATABASE_URL. Expected e.g. postgres://user:pass@host:5432/db (or pass --databaseUrl)."
    );
    process.exit(2);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    // eslint-disable-next-line no-console
    console.error(`Invalid DATABASE_URL protocol: ${url.protocol}`);
    process.exit(2);
  }
}

function validateOpenAIKeyOrExit(apiKey) {
  const s = String(apiKey || "").trim();
  if (!s) {
    // eslint-disable-next-line no-console
    console.error("Missing OPENAI_API_KEY (set env var)");
    process.exit(2);
  }
}

function normalizeNewlines(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function contentPartsToText(contentParts) {
  const parts = Array.isArray(contentParts) ? contentParts : [];
  const out = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;

    // Common text-bearing shapes across input/output.
    if (typeof part.text === "string") {
      out.push(part.text);
      continue;
    }

    // Some parts may embed text in other keys.
    if (part.type === "output_text" && typeof part.text === "string") {
      out.push(part.text);
      continue;
    }

    if (part.type === "input_text" && typeof part.text === "string") {
      out.push(part.text);
      continue;
    }

    if (part.type === "summary_text" && typeof part.text === "string") {
      out.push(part.text);
      continue;
    }

    if (part.type === "reasoning_text" && typeof part.text === "string") {
      out.push(part.text);
      continue;
    }

    // Fallback: show a compact JSON snippet.
    try {
      out.push(JSON.stringify(part));
    } catch (_) {
      out.push(String(part));
    }
  }

  return normalizeNewlines(out.join("\n")).trim();
}

function formatMessageItem(item) {
  const role = String(item?.role || item?.type || "unknown").toUpperCase();
  const id = String(item?.id || "");

  if (item?.type === "message") {
    const text = contentPartsToText(item.content);
    return `\n[${role}]${id ? " (" + id + ")" : ""}\n${text || "(no text)"}\n`;
  }

  // Non-message items (tool calls, reasoning items, etc.)
  let payload = "";
  try {
    payload = JSON.stringify(item);
  } catch (_) {
    payload = String(item);
  }

  return `\n[ITEM:${role}]${id ? " (" + id + ")" : ""}\n${payload}\n`;
}

async function listAllItems(openai, conversationId) {
  const items = [];

  // The OpenAI SDK supports async iteration for pagination.
  // If the SDK implementation changes, fall back to a single page.
  try {
    // eslint-disable-next-line no-restricted-syntax
    for await (const item of openai.conversations.items.list(conversationId, { limit: 100 })) {
      items.push(item);
    }
    return items;
  } catch (e) {
    // Fallback attempt: single page.
    const page = await openai.conversations.items.list(conversationId, { limit: 100 });
    const data = page?.data;
    if (Array.isArray(data)) return data;
    throw e;
  }
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) usage(0);

  const databaseUrl = String(getArg("databaseUrl") || process.env.DATABASE_URL || "").trim();
  validateDatabaseUrlOrExit(databaseUrl);

  const apiKey = process.env.OPENAI_API_KEY;
  validateOpenAIKeyOrExit(apiKey);

  const defaultOut = path.resolve(process.cwd(), "docassist-openai-chats.txt");
  const outPath = path.resolve(process.cwd(), String(getArg("out") || defaultOut));

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  const openai = new OpenAI({ apiKey });

  try {
    const sessions = await pool.query(
      `
      SELECT doc_id, conversation_id, updated_at
      FROM docs_sessions
      ORDER BY updated_at DESC
      `
    );

    const rows = Array.isArray(sessions.rows) ? sessions.rows : [];
    if (!rows.length) {
      // eslint-disable-next-line no-console
      console.log("No rows found in docs_sessions (no v2 sessions to export).");
      return;
    }

    let text = "";
    text += "DocAssist OpenAI conversation export\n";
    text += `exportedAt: ${new Date().toISOString()}\n`;
    text += `conversations: ${rows.length}\n`;
    text += "\n";

    for (const row of rows) {
      const docId = String(row.doc_id || "");
      const conversationId = String(row.conversation_id || "");
      const updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : "";

      text += "\n";
      text += "=".repeat(80) + "\n";
      text += `docId: ${docId}\n`;
      text += `conversationId: ${conversationId}\n`;
      if (updatedAt) text += `sessionUpdatedAt: ${updatedAt}\n`;
      text += "=".repeat(80) + "\n";

      if (!conversationId) {
        text += "(missing conversation_id)\n";
        continue;
      }

      try {
        const items = await listAllItems(openai, conversationId);
        text += `items: ${items.length}\n`;

        for (const item of items) {
          text += formatMessageItem(item);
        }
      } catch (e) {
        text += `\n(ERROR fetching conversation items: ${e && e.message ? e.message : String(e)})\n`;
      }
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, text, "utf8");

    // eslint-disable-next-line no-console
    console.log(`Wrote OpenAI conversation export to ${outPath}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
