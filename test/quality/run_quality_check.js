// Minimal regression harness for Doc Assist quality checks.
// Usage:
//   DOCASSIST_BASE_URL=http://localhost:3000 node test/quality/run_quality_check.js
//
// Optional env:
//   DOCASSIST_TOKEN=...   (if enabled)
//   DOCASSIST_FILE_ID=... (scope to a specific file)

import fs from "fs";
import path from "path";

if (process.env.DOCASSIST_RUN_QUALITY !== "1") {
  console.log("Skipping quality harness (set DOCASSIST_RUN_QUALITY=1 to run).");
  process.exit(0);
}

const baseUrl = process.env.DOCASSIST_BASE_URL || "http://localhost:3000";
const token = process.env.DOCASSIST_TOKEN || "";
const fileId = process.env.DOCASSIST_FILE_ID || "";

const questionsPath = path.resolve("test/quality/questions.json");
if (!fs.existsSync(questionsPath)) {
  console.error("Missing test/quality/questions.json");
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(questionsPath, "utf8"));
const docId = payload.docId;
const questions = Array.isArray(payload.questions) ? payload.questions : [];
if (!docId || !questions.length) {
  console.error("questions.json must include docId and a non-empty questions array");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
};
if (token) headers.Authorization = `Bearer ${token}`;

const results = [];
let pass = 0;
let fail = 0;

for (const q of questions) {
  const body = {
    docId,
    userMessage: q.text,
  };
  if (fileId) body.fileId = fileId;

  const res = await fetch(`${baseUrl}/v2/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  const sources = Array.isArray(json.sources) ? json.sources : [];
  const hasSources = sources.length > 0;
  const ok = q.expectSources ? hasSources : true;

  results.push({
    id: q.id,
    ok,
    status: res.status,
    hasSources,
    sourcesCount: sources.length,
  });

  if (ok) pass += 1; else fail += 1;
  process.stdout.write(ok ? "." : "F");
}

process.stdout.write("\n");
console.log(`Pass: ${pass}, Fail: ${fail}, Total: ${results.length}`);

const outPath = path.resolve("test/quality/last_run.json");
fs.writeFileSync(outPath, JSON.stringify({
  ts: new Date().toISOString(),
  baseUrl,
  docId,
  pass,
  fail,
  results,
}, null, 2));

console.log(`Wrote ${outPath}`);
