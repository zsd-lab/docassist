#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import process from "node:process";
import pkg from "pg";

const { Pool } = pkg;

function usage(exitCode = 0) {
  const cmd = path.basename(process.argv[1] || "list_chat_history.mjs");
  // eslint-disable-next-line no-console
  console.log(`
List DocAssist chat history currently stored in Postgres (table: chat_history).

Usage:
  node scripts/${cmd} [--limit <n>] [--databaseUrl <url>]

Environment:
  DATABASE_URL   Postgres connection string (used if --databaseUrl not provided)

Examples:
  node scripts/${cmd}
  node scripts/${cmd} --limit 50
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

function parseLimit(value) {
  if (value == null || value === "") return 100;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(n, 2000);
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) usage(0);

  const databaseUrl = String(getArg("databaseUrl") || process.env.DATABASE_URL || "").trim();
  validateDatabaseUrlOrExit(databaseUrl);

  const limit = parseLimit(getArg("limit"));

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const result = await pool.query(
      `
      SELECT
        doc_id,
        COUNT(*)::int AS messages,
        MIN(created_at) AS first_message_at,
        MAX(created_at) AS last_message_at
      FROM chat_history
      GROUP BY doc_id
      ORDER BY last_message_at DESC
      LIMIT $1
      `,
      [limit]
    );

    const rows = Array.isArray(result.rows) ? result.rows : [];

    if (!rows.length) {
      // eslint-disable-next-line no-console
      console.log("No chat history rows found in chat_history.");
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`Found ${rows.length} docId(s) with chat history (showing up to ${limit}).`);

    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.doc_id}\n  messages=${r.messages} | first=${new Date(r.first_message_at).toISOString()} | last=${new Date(r.last_message_at).toISOString()}`
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
