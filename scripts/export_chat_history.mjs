#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pkg from "pg";

const { Pool } = pkg;

function usage(exitCode = 0) {
  const cmd = path.basename(process.argv[1] || "export_chat_history.mjs");
  // Keep this plain-text so it’s readable in terminals.
  // eslint-disable-next-line no-console
  console.log(`
Export DocAssist chat history from Postgres into a .txt file.

Usage:
  node scripts/${cmd} --docId <GOOGLE_DOC_ID> [--out <path>] [--databaseUrl <url>]

Environment:
  DATABASE_URL   Postgres connection string (used if --databaseUrl not provided)

Examples:
  node scripts/${cmd} --docId 1AbC... --out ./chat.txt
  DATABASE_URL=postgres://... node scripts/${cmd} --docId 1AbC...
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

function requireNonEmpty(name, value) {
  const s = String(value ?? "").trim();
  if (!s) {
    // eslint-disable-next-line no-console
    console.error(`Missing required --${name}`);
    usage(2);
  }
  return s;
}

function safeFilenamePart(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 80);
}

function formatLine(ts, role, content) {
  const time = ts ? new Date(ts).toISOString() : "";
  const r = String(role || "").toUpperCase();
  const body = String(content || "").replace(/\r\n/g, "\n");
  return `\n[${time}] ${r}\n${body}\n`;
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

async function main() {
  if (hasFlag("help") || hasFlag("h")) usage(0);

  const docId = requireNonEmpty("docId", getArg("docId"));
  const databaseUrl = String(getArg("databaseUrl") || process.env.DATABASE_URL || "").trim();

  validateDatabaseUrlOrExit(databaseUrl);

  const defaultOut = path.resolve(
    process.cwd(),
    `docassist-chat-${safeFilenamePart(docId)}.txt`
  );
  const outPath = path.resolve(process.cwd(), String(getArg("out") || defaultOut));

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const result = await pool.query(
      `
      SELECT role, content, created_at
      FROM chat_history
      WHERE doc_id = $1
      ORDER BY created_at ASC, id ASC
      `,
      [docId]
    );

    const rows = Array.isArray(result.rows) ? result.rows : [];

    let text = "";
    text += `docId: ${docId}\n`;
    text += `exportedAt: ${new Date().toISOString()}\n`;
    text += `messages: ${rows.length}\n`;
    text += "\n";

    for (const row of rows) {
      text += formatLine(row.created_at, row.role, row.content);
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, text, "utf8");

    // eslint-disable-next-line no-console
    console.log(`Wrote ${rows.length} messages to ${outPath}`);

    if (rows.length === 0) {
      // eslint-disable-next-line no-console
      console.log(
        "No rows found. If you used only the v2 sidebar chat previously, note: v2 chat turns are not persisted in chat_history by this server version."
      );
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
