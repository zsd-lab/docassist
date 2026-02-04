import express from "express";
import OpenAI, { toFile } from "openai";
import crypto from "crypto";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function createApp({
  pool,
  openaiClient,
  config,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("createApp: missing pool with query() method");
  }

  const cfg = {
    bodyLimit: config?.bodyLimit || process.env.DOCASSIST_BODY_LIMIT || "25mb",
    token: config?.token ?? process.env.DOCASSIST_TOKEN ?? "",
    resetCleanupOpenAI: (() => {
      const raw = config?.resetCleanupOpenAI ?? process.env.DOCASSIST_RESET_CLEANUP_OPENAI;
      if (raw == null) return false;
      const s = String(raw).trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    })(),
    maxTurnsPerDoc: config?.maxTurnsPerDoc ?? 25,
    maxDocChars: config?.maxDocChars ?? 50000,
    maxDocIdChars: config?.maxDocIdChars ?? 256,
    maxUserMessageChars: config?.maxUserMessageChars ?? 20000,
    maxInstructionsChars: config?.maxInstructionsChars ?? 20000,
    maxDocTitleChars: config?.maxDocTitleChars ?? 256,
    maxFilenameChars: config?.maxFilenameChars ?? 256,
    maxDocTextChars: config?.maxDocTextChars ?? 2_000_000,
    maxUploadBytes: config?.maxUploadBytes ?? 15 * 1024 * 1024,
    rateLimitEnabled: (() => {
      const raw = config?.rateLimitEnabled ?? process.env.DOCASSIST_RATE_LIMIT_ENABLED;
      if (raw == null) return false;
      const s = String(raw).trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    })(),
    rateLimitWindowMs: (() => {
      const raw = config?.rateLimitWindowMs ?? process.env.DOCASSIST_RATE_LIMIT_WINDOW_MS;
      if (raw == null || String(raw).trim() === "") return 60_000;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 ? n : 60_000;
    })(),
    rateLimitMax: (() => {
      const raw = config?.rateLimitMax ?? process.env.DOCASSIST_RATE_LIMIT_MAX;
      if (raw == null || String(raw).trim() === "") return 120;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 ? n : 120;
    })(),
    // Default model for all clients unless overridden via OPENAI_MODEL or explicit config.
    openaiModel: config?.openaiModel || process.env.OPENAI_MODEL || "gpt-5.2-2025-12-11",
    maxOutputTokens: (() => {
      const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
      const raw = config?.maxOutputTokens ?? process.env.DOCASSIST_MAX_OUTPUT_TOKENS;
      if (raw == null || String(raw).trim() === "") return DEFAULT_MAX_OUTPUT_TOKENS;
      const parsed = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_OUTPUT_TOKENS;
      return parsed;
    })(),
    // Override the default system prompt (can be passed from server.js or via env var).
    systemPrompt: config?.systemPrompt ?? process.env.DOCASSIST_SYSTEM_PROMPT,
    summaryEnabled: (() => {
      const raw = config?.summaryEnabled ?? process.env.DOCASSIST_SUMMARY_ENABLED;
      if (raw == null) return true;
      const s = String(raw).trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    })(),
    summaryMaxChars: (() => {
      const raw = config?.summaryMaxChars ?? process.env.DOCASSIST_SUMMARY_MAX_CHARS;
      if (raw == null || String(raw).trim() === "") return 1800;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 100 ? n : 1800;
    })(),
    summaryInputMaxChars: (() => {
      const raw = config?.summaryInputMaxChars ?? process.env.DOCASSIST_SUMMARY_INPUT_MAX_CHARS;
      if (raw == null || String(raw).trim() === "") return 20000;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 1000 ? n : 20000;
    })(),
    chunkingEnabled: (() => {
      const raw = config?.chunkingEnabled ?? process.env.DOCASSIST_CHUNKING_ENABLED;
      if (raw == null) return true;
      const s = String(raw).trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    })(),
    chunkMaxTokens: (() => {
      const raw = config?.chunkMaxTokens ?? process.env.DOCASSIST_CHUNK_MAX_TOKENS;
      if (raw == null || String(raw).trim() === "") return 700;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 100 ? n : 700;
    })(),
    chunkOverlapTokens: (() => {
      const raw = config?.chunkOverlapTokens ?? process.env.DOCASSIST_CHUNK_OVERLAP_TOKENS;
      if (raw == null || String(raw).trim() === "") return 150;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n >= 0 ? n : 150;
    })(),
    chatLogEnabled: (() => {
      const raw = config?.chatLogEnabled ?? process.env.DOCASSIST_CHAT_LOG_ENABLED;
      if (raw == null) return true;
      const s = String(raw).trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    })(),
    forceFileSearch: (() => {
      const raw = config?.forceFileSearch ?? process.env.DOCASSIST_FORCE_FILE_SEARCH;
      if (raw == null) return true;
      const s = String(raw).trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    })(),
    twoStepEnabled: (() => {
      const raw = config?.twoStepEnabled ?? process.env.DOCASSIST_TWO_STEP_ENABLED;
      if (raw == null) return false;
      const s = String(raw).trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    })(),
  };

  const client = openaiClient ||
    new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

  const DEFAULT_SYSTEM_PROMPT = `
You are a helpful, concise assistant. Ask clarifying questions when needed, be factual, and keep responses structured and actionable.
`.trim();

  const SYSTEM_PROMPT = String(cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT).trim();

  const app = express();

  app.use(express.json({ limit: cfg.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: cfg.bodyLimit }));

  // ====== REQUEST ID ======
  app.use((req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && incoming.trim() && incoming.length <= 128
        ? incoming.trim()
        : crypto.randomUUID();

    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    return next();
  });

  function jsonError(req, message, extra) {
    return {
      error: message,
      requestId: req?.requestId,
      ...(extra || {}),
    };
  }

  function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }

  function requireString(req, res, fieldName, value, { maxChars, allowEmpty = false } = {}) {
    if (value == null) {
      res.status(400).json(jsonError(req, `Missing '${fieldName}'`));
      return null;
    }

    if (typeof value !== "string") {
      res.status(400).json(jsonError(req, `Invalid '${fieldName}' (expected string)`));
      return null;
    }

    if (!allowEmpty && value.length === 0) {
      res.status(400).json(jsonError(req, `Missing '${fieldName}'`));
      return null;
    }

    if (typeof maxChars === "number" && value.length > maxChars) {
      res
        .status(400)
        .json(jsonError(req, `Field '${fieldName}' too large (max ${maxChars} chars)`));
      return null;
    }

    return value;
  }

  function requireNonEmptyTrimmedString(req, res, fieldName, value, { maxChars } = {}) {
    const str = requireString(req, res, fieldName, value, { maxChars, allowEmpty: true });
    if (str == null) return null;
    const trimmed = str.trim();
    if (!trimmed) {
      res.status(400).json(jsonError(req, `Missing '${fieldName}'`));
      return null;
    }
    return trimmed;
  }

  function estimateBase64BytesLen(base64String) {
    const s = String(base64String || "").trim();
    if (!s) return 0;
    const noWs = s.replace(/\s+/g, "");
    const padding = noWs.endsWith("==") ? 2 : noWs.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((noWs.length * 3) / 4) - padding);
  }

  // ====== AUTH (optional) ======
  app.use((req, res, next) => {
    if (!cfg.token) return next();
    if (req.method === "GET" && req.path === "/") return next();

    const auth = String(req.headers.authorization || "");
    const expected = `Bearer ${cfg.token}`;
    if (auth !== expected) {
      return res.status(401).json(jsonError(req, "Unauthorized"));
    }
    return next();
  });

  // ====== RATE LIMIT (optional, in-memory) ======
  // Note: intentionally simple (fixed window), enabled via DOCASSIST_RATE_LIMIT_ENABLED.
  if (cfg.rateLimitEnabled) {
    const buckets = new Map();

    const keyFor = (req) => {
      // If you're behind a proxy and want X-Forwarded-For, set app.set('trust proxy', 1) at the proxy layer.
      return String(req.ip || req.socket?.remoteAddress || "unknown");
    };

    const exempt = (req) => {
      // Keep health check always available.
      return req.method === "GET" && req.path === "/";
    };

    app.use((req, res, next) => {
      if (exempt(req)) return next();

      const now = Date.now();
      const key = keyFor(req);
      const entry = buckets.get(key);

      if (!entry || now >= entry.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + cfg.rateLimitWindowMs });
        return next();
      }

      entry.count += 1;
      if (entry.count <= cfg.rateLimitMax) {
        return next();
      }

      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json(
        jsonError(req, "Rate limit exceeded", {
          retryAfterSeconds: retryAfterSec,
        })
      );
    });
  }

  function buildInstructions(customInstructions, docSummary) {
    const custom = String(customInstructions || "").trim();
    const summary = String(docSummary || "").trim();

    if (!custom && !summary) return SYSTEM_PROMPT;

    const parts = [SYSTEM_PROMPT];
    if (summary) {
      parts.push(`Project memory (auto-summary):\n${summary}`);
    }
    if (custom) {
      parts.push(`Project instructions (user-provided):\n${custom}`);
    }

    return parts.join("\n\n---\n").trim();
  }

  function normalizeStructuredText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function estimateTokens(text) {
    // Rough heuristic: ~4 chars per token for English/HU mix.
    return Math.max(1, Math.ceil(String(text || "").length / 4));
  }

  function slugifyForFilename(value, maxLen = 60) {
    const s = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const trimmed = s || "section";
    return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
  }

  function splitStructuredTextToSections(text) {
    const lines = String(text || "").split("\n");
    const sections = [];
    let path = [];
    let current = { path: [], lines: [] };

    const pushCurrent = () => {
      if (!current.lines.length) return;
      sections.push({
        path: current.path.slice(),
        text: current.lines.join("\n").trim(),
      });
      current = { path: path.slice(), lines: [] };
    };

    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        pushCurrent();
        const level = m[1].length;
        const title = m[2].trim();
        path = path.slice(0, level - 1);
        path[level - 1] = title;
        current = { path: path.slice(), lines: [line] };
        continue;
      }

      current.lines.push(line);
    }

    pushCurrent();

    if (!sections.length && String(text || "").trim()) {
      sections.push({ path: [], text: String(text || "").trim() });
    }

    return sections;
  }

  function buildChunksFromStructuredText(text, { maxTokens, overlapTokens }) {
    const normalized = normalizeStructuredText(text);
    if (!normalized) return [];

    const sections = splitStructuredTextToSections(normalized);
    const chunks = [];
    const overlapChars = Math.max(0, Number(overlapTokens || 0)) * 4;

    for (const section of sections) {
      const sectionPath = (section.path || []).join(" > ");
      const header = sectionPath ? `Section: ${sectionPath}` : "Section: (no heading)";
      const sectionText = String(section.text || "").trim();
      if (!sectionText) continue;

      const paragraphs = sectionText.split(/\n{2,}/);
      let buffer = "";
      const flush = () => {
        if (!buffer.trim()) return;
        const payload = `${header}\n\n${buffer.trim()}`;
        chunks.push({ sectionPath, text: payload });
        buffer = "";
      };

      for (const p of paragraphs) {
        const candidate = buffer ? `${buffer}\n\n${p}` : p;
        if (estimateTokens(candidate) <= maxTokens) {
          buffer = candidate;
          continue;
        }

        if (buffer) {
          flush();
          if (overlapChars > 0) {
            const tail = candidate.slice(-overlapChars);
            buffer = tail;
          }
        }

        if (estimateTokens(p) > maxTokens) {
          // Hard split long paragraph.
          let start = 0;
          const chunkChars = maxTokens * 4;
          while (start < p.length) {
            const part = p.slice(start, start + chunkChars);
            const payload = `${header}\n\n${part.trim()}`;
            if (part.trim()) chunks.push({ sectionPath, text: payload });
            start += chunkChars - overlapChars;
            if (start < 0) start = 0;
          }
          buffer = "";
          continue;
        }

        buffer = p;
      }

      flush();
    }

    return chunks;
  }

  function isLikelyTextMime(mimeType, filename) {
    const mt = String(mimeType || "").toLowerCase();
    if (mt.startsWith("text/")) return true;
    if (mt.includes("json") || mt.includes("xml") || mt.includes("yaml") || mt.includes("csv")) return true;
    const name = String(filename || "").toLowerCase();
    return Boolean(name.match(/\.(txt|md|markdown|csv|tsv|json|yaml|yml|xml)$/));
  }

  function shouldForceFileSearch(msg) {
    const s = String(msg || "").toLowerCase();
    return /\b(doc|document|file|tab|section|chapter|above|below|in this|in the doc|in the file|from the doc)\b/i.test(s);
  }

  function isComplexPrompt(msg) {
    const s = String(msg || "");
    if (s.length > 400) return true;
    return /\b(compare|options|trade-?off|design|architecture|root cause|strategy|plan|proposal|alternatives|risk|mitigation)\b/i.test(s);
  }

  function extractSourcesFromResponse_(response) {
    const sources = [];
    const output = response && Array.isArray(response.output) ? response.output : [];

    for (const item of output) {
      const content = item && Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        const annotations = c && Array.isArray(c.annotations) ? c.annotations : [];
        for (const ann of annotations) {
          const fileId = ann.file_id || ann.fileId || ann?.file?.id;
          if (!fileId) continue;
          const quote = ann.quote || ann.text || c.text || "";
          sources.push({ fileId: String(fileId), quote: String(quote || "") });
        }
      }

      // Tool-result best-effort (file_search output may include file ids/text)
      if (item && item.type === "tool_result" && item.name === "file_search") {
        const results = item.output || item.results || [];
        if (Array.isArray(results)) {
          for (const r of results) {
            const fileId = r.file_id || r.fileId || r?.file?.id;
            if (!fileId) continue;
            const quote = r.text || r.snippet || "";
            sources.push({ fileId: String(fileId), quote: String(quote || "") });
          }
        }
      }
    }

    // Deduplicate by fileId + quote prefix
    const dedup = new Map();
    for (const s of sources) {
      const key = `${s.fileId}::${String(s.quote || "").slice(0, 80)}`;
      if (!dedup.has(key)) dedup.set(key, s);
    }

    return Array.from(dedup.values());
  }

  async function resolveSourceMetadata_(docId, fileIds) {
    const ids = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [];
    if (!ids.length) return new Map();

    const result = await pool.query(
      `
        SELECT vector_store_file_id, filename, kind
        FROM docs_files
        WHERE doc_id = $1 AND vector_store_file_id = ANY($2::text[])
      `,
      [String(docId), ids]
    );

    const map = new Map();
    for (const row of result.rows || []) {
      map.set(String(row.vector_store_file_id), {
        filename: row.filename,
        kind: row.kind,
      });
    }
    return map;
  }

  function extractSectionFromQuote_(quote) {
    const m = String(quote || "").match(/Section:\s*(.+)/i);
    return m ? String(m[1]).trim() : "";
  }

  function clipSnippet(text, maxLen = 240) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + "…";
  }

  function logChatEvent_(payload) {
    if (!cfg.chatLogEnabled) return;
    const safe = {
      ts: new Date().toISOString(),
      event: "v2.chat",
      ...payload,
    };
    try {
      if (typeof logger.info === "function") logger.info(JSON.stringify(safe));
      else logger.log(JSON.stringify(safe));
    } catch (_) {
      // ignore logging errors
    }
  }

  function extractPassagesFromPlan_(text) {
    const lines = String(text || "").split("\n");
    const passages = [];
    for (const line of lines) {
      const m = line.match(/^-\s+(.+)/);
      if (m && m[1]) passages.push(m[1].trim());
    }
    return passages.filter(Boolean).slice(0, 6);
  }

  async function recordVectorStoreChunkFile(
    docId,
    kind,
    filename,
    sha256,
    vectorStoreFileId,
    { fileVectorStoreId = null, fileVectorStoreFileId = null } = {}
  ) {
    await pool.query(
      `
        INSERT INTO docs_files (
          doc_id,
          kind,
          filename,
          sha256,
          vector_store_file_id,
          file_vector_store_id,
          file_vector_store_file_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (doc_id, kind, sha256)
        DO UPDATE SET
          filename = EXCLUDED.filename,
          vector_store_file_id = COALESCE(docs_files.vector_store_file_id, EXCLUDED.vector_store_file_id),
          file_vector_store_id = EXCLUDED.file_vector_store_id,
          file_vector_store_file_id = EXCLUDED.file_vector_store_file_id
      `,
      [docId, kind, filename, sha256, vectorStoreFileId, fileVectorStoreId, fileVectorStoreFileId]
    );
  }

  async function updateDocSummary_({ docId, title, kind, text, previousSummary }) {
    if (!cfg.summaryEnabled) return null;
    if (!client?.responses || typeof client.responses.create !== "function") return null;
    const raw = String(text || "").trim();
    if (!raw) return null;

    const clipped = raw.slice(0, cfg.summaryInputMaxChars);
    const prev = String(previousSummary || "").trim();
    const instruction = `You summarize project content for future Q&A.\n\nReturn a concise summary (max ${cfg.summaryMaxChars} chars) covering: goals, key facts, decisions, open questions. Use short paragraphs or bullets. Do NOT include sensitive data.`;

    const input = prev
      ? `Previous summary:\n${prev}\n\nNew content (${kind || "doc"}${title ? `: ${title}` : ""}):\n${clipped}`
      : `Content (${kind || "doc"}${title ? `: ${title}` : ""}):\n${clipped}`;

    const response = await client.responses.create({
      model: cfg.openaiModel,
      instructions: instruction,
      input,
      max_output_tokens: Math.min(600, cfg.maxOutputTokens),
    });

    const summary = String(response.output_text || "").trim().slice(0, cfg.summaryMaxChars);
    if (!summary) return null;

    await pool.query(
      `UPDATE docs_sessions SET doc_summary = $2, doc_summary_updated_at = NOW(), updated_at = NOW() WHERE doc_id = $1`,
      [String(docId), summary]
    );

    return summary;
  }

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id SERIAL PRIMARY KEY,
        doc_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS docs_sessions (
        doc_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        vector_store_id TEXT NOT NULL,
        instructions TEXT,
        model TEXT,
        doc_summary TEXT,
        doc_summary_updated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS docs_files (
        id SERIAL PRIMARY KEY,
        doc_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        vector_store_file_id TEXT NOT NULL,
        file_vector_store_id TEXT,
        file_vector_store_file_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Legacy installs: add new columns if they don't exist.
    await pool.query(`ALTER TABLE docs_files ADD COLUMN IF NOT EXISTS file_vector_store_id TEXT;`);
    await pool.query(`ALTER TABLE docs_files ADD COLUMN IF NOT EXISTS file_vector_store_file_id TEXT;`);
    await pool.query(`ALTER TABLE docs_sessions ADD COLUMN IF NOT EXISTS doc_summary TEXT;`);
    await pool.query(`ALTER TABLE docs_sessions ADD COLUMN IF NOT EXISTS doc_summary_updated_at TIMESTAMPTZ;`);

    // ----- Indexes & constraints (idempotent) -----
    // 1) Dedupe any legacy duplicates before adding unique index.
    await pool.query(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY doc_id, kind, sha256
            ORDER BY created_at DESC, id DESC
          ) AS rn
        FROM docs_files
      )
      DELETE FROM docs_files
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
    `);

    // 2) Prevent duplicates going forward.
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_files_doc_id_kind_sha256_uidx ON docs_files (doc_id, kind, sha256);`
    );

    // 3) Query performance.
    await pool.query(
      `CREATE INDEX IF NOT EXISTS docs_files_doc_id_idx ON docs_files (doc_id);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS chat_history_doc_id_created_at_idx ON chat_history (doc_id, created_at);`
    );
  }

  async function recordVectorStoreFile(
    docId,
    kind,
    filename,
    sha256,
    vectorStoreFileId,
    { fileVectorStoreId = null, fileVectorStoreFileId = null } = {}
  ) {
    await pool.query(
      `
        INSERT INTO docs_files (
          doc_id,
          kind,
          filename,
          sha256,
          vector_store_file_id,
          file_vector_store_id,
          file_vector_store_file_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (doc_id, kind, sha256) DO NOTHING
      `,
      [docId, kind, filename, sha256, vectorStoreFileId, fileVectorStoreId, fileVectorStoreFileId]
    );
  }

  async function findExistingVectorStoreFile(docId, kind, sha256) {
    const result = await pool.query(
      `
        SELECT vector_store_file_id
        FROM docs_files
        WHERE doc_id = $1 AND kind = $2 AND sha256 = $3
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [docId, kind, sha256]
    );
    return result.rows?.[0]?.vector_store_file_id || null;
  }

  async function findExistingDocsFileByHash_(docId, kind, sha256) {
    const result = await pool.query(
      `
        SELECT
          id,
          vector_store_file_id,
          file_vector_store_id,
          file_vector_store_file_id
        FROM docs_files
        WHERE doc_id = $1 AND kind = $2 AND sha256 = $3
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [docId, kind, sha256]
    );
    return result.rows?.[0] || null;
  }

  async function bestEffortDeleteOpenAIResources_({ conversationId, vectorStoreId }) {
    try {
      if (vectorStoreId && client?.vectorStores) {
        const vsApi = client.vectorStores;
        if (typeof vsApi.del === "function") {
          await vsApi.del(vectorStoreId);
        } else if (typeof vsApi.delete === "function") {
          await vsApi.delete(vectorStoreId);
        }
      }
    } catch (_) {
      // best-effort
    }

    try {
      if (conversationId && client?.conversations) {
        const cApi = client.conversations;
        if (typeof cApi.del === "function") {
          await cApi.del(conversationId);
        } else if (typeof cApi.delete === "function") {
          await cApi.delete(conversationId);
        }
      }
    } catch (_) {
      // best-effort
    }
  }

  async function bestEffortDeleteVectorStoreFilesByIds_({ vectorStoreId, fileIds }) {
    const ids = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [];
    if (!vectorStoreId || !ids.length) return { attempted: 0, deleted: 0, failed: 0, deletedIds: [] };

    let deleted = 0;
    let failed = 0;
    const deletedIds = [];

    for (const fileId of ids) {
      try {
        const filesApi = client?.vectorStores?.files;
        if (!filesApi) {
          failed++;
          continue;
        }

        if (typeof filesApi.del === "function") {
          await filesApi.del(vectorStoreId, fileId);
        } else if (typeof filesApi.delete === "function") {
          await filesApi.delete(vectorStoreId, fileId);
        } else {
          failed++;
          continue;
        }

        deleted++;
        deletedIds.push(fileId);
      } catch (_) {
        failed++;
      }
    }

    return { attempted: ids.length, deleted, failed, deletedIds };
  }

  async function bestEffortCleanupOpenAIForDoc_({ docId }) {
    const result = {
      docId: String(docId),
      deleted: {
        docVectorStoreFiles: 0,
        fileVectorStoreFiles: 0,
        fileVectorStores: 0,
        docVectorStore: 0,
        conversation: 0,
      },
      attempted: {
        docVectorStoreFiles: 0,
        fileVectorStoreFiles: 0,
        fileVectorStores: 0,
      },
    };

    const s = await pool.query(
      `SELECT conversation_id, vector_store_id FROM docs_sessions WHERE doc_id = $1`,
      [String(docId)]
    );
    const row = s.rows?.[0];

    const f = await pool.query(
      `SELECT vector_store_file_id, file_vector_store_id, file_vector_store_file_id FROM docs_files WHERE doc_id = $1 ORDER BY created_at DESC, id DESC`,
      [String(docId)]
    );
    const docVsFileIds = (f.rows || []).map((r) => r.vector_store_file_id).filter(Boolean);
    const fileVsIds = Array.from(
      new Set((f.rows || []).map((r) => r.file_vector_store_id).filter(Boolean))
    );
    const fileVsFileIdsByStore = new Map();
    for (const row of f.rows || []) {
      const vsId = row.file_vector_store_id;
      const vsFileId = row.file_vector_store_file_id;
      if (!vsId || !vsFileId) continue;
      const arr = fileVsFileIdsByStore.get(vsId) || [];
      arr.push(vsFileId);
      fileVsFileIdsByStore.set(vsId, arr);
    }

    const conversationId = row?.conversation_id;
    const vectorStoreId = row?.vector_store_id;

    // Delete vector store files in the doc store.
    if (vectorStoreId && client?.vectorStores?.files) {
      result.attempted.docVectorStoreFiles = docVsFileIds.length;
      for (const fileId of docVsFileIds) {
        try {
          const filesApi = client.vectorStores.files;
          if (typeof filesApi.del === "function") {
            await filesApi.del(vectorStoreId, fileId);
            result.deleted.docVectorStoreFiles += 1;
          } else if (typeof filesApi.delete === "function") {
            await filesApi.delete(vectorStoreId, fileId);
            result.deleted.docVectorStoreFiles += 1;
          }
        } catch (_) {
          // best-effort
        }
      }
    }

    // Delete file-scoped vector stores (and their files).
    if (client?.vectorStores) {
      for (const vsId of fileVsIds) {
        const vsFileIds = fileVsFileIdsByStore.get(vsId) || [];
        result.attempted.fileVectorStoreFiles += vsFileIds.length;
        if (vsFileIds.length && client?.vectorStores?.files) {
          for (const fileId of vsFileIds) {
            try {
              const filesApi = client.vectorStores.files;
              if (typeof filesApi.del === "function") {
                await filesApi.del(vsId, fileId);
                result.deleted.fileVectorStoreFiles += 1;
              } else if (typeof filesApi.delete === "function") {
                await filesApi.delete(vsId, fileId);
                result.deleted.fileVectorStoreFiles += 1;
              }
            } catch (_) {
              // best-effort
            }
          }
        }

        try {
          if (typeof client.vectorStores.del === "function") {
            await client.vectorStores.del(vsId);
            result.deleted.fileVectorStores += 1;
          } else if (typeof client.vectorStores.delete === "function") {
            await client.vectorStores.delete(vsId);
            result.deleted.fileVectorStores += 1;
          }
        } catch (_) {
          // best-effort
        }
      }
      result.attempted.fileVectorStores = fileVsIds.length;
    }

    // Delete doc vector store container.
    if (vectorStoreId && client?.vectorStores) {
      try {
        if (typeof client.vectorStores.del === "function") {
          await client.vectorStores.del(vectorStoreId);
          result.deleted.docVectorStore += 1;
        } else if (typeof client.vectorStores.delete === "function") {
          await client.vectorStores.delete(vectorStoreId);
          result.deleted.docVectorStore += 1;
        }
      } catch (_) {
        // best-effort
      }
    }

    // Delete conversation.
    if (conversationId && client?.conversations) {
      try {
        if (typeof client.conversations.del === "function") {
          await client.conversations.del(conversationId);
          result.deleted.conversation += 1;
        } else if (typeof client.conversations.delete === "function") {
          await client.conversations.delete(conversationId);
          result.deleted.conversation += 1;
        }
      } catch (_) {
        // best-effort
      }
    }

    return result;
  }

  async function bestEffortReplaceKnowledgeForDoc_({ docId, vectorStoreId }) {
    // Delete prior vector store files we know about for this doc, then delete corresponding rows.
    // Note: if older files exist in the vector store but aren't present in docs_files, we can't remove them here.
    const f = await pool.query(
      `SELECT vector_store_file_id FROM docs_files WHERE doc_id = $1 ORDER BY created_at DESC, id DESC`,
      [docId]
    );
    const fileIds = (f.rows || []).map((r) => r.vector_store_file_id).filter(Boolean);

    const delRes = await bestEffortDeleteVectorStoreFilesByIds_({ vectorStoreId, fileIds });

    if (delRes.deletedIds.length) {
      await pool.query(
        `DELETE FROM docs_files WHERE doc_id = $1 AND vector_store_file_id = ANY($2::text[])`,
        [docId, delRes.deletedIds]
      );
    }

    return delRes;
  }

  async function getOrCreateSession(docId, maybeInstructions) {
    const incoming = typeof maybeInstructions === "string" ? maybeInstructions : "";

    const fetchAndMaybeUpdate_ = async (db) => {
      const existing = await db.query(
        `SELECT doc_id, conversation_id, vector_store_id, instructions, model, doc_summary, doc_summary_updated_at FROM docs_sessions WHERE doc_id = $1`,
        [docId]
      );

      if (existing.rows.length === 0) return null;

      const row = existing.rows[0];

      if (incoming && incoming.trim() !== String(row.instructions || "").trim()) {
        await db.query(`UPDATE docs_sessions SET instructions = $2, updated_at = NOW() WHERE doc_id = $1`, [
          docId,
          incoming,
        ]);
        row.instructions = incoming;
      }

      if (!row.model || row.model !== cfg.openaiModel) {
        await db.query(`UPDATE docs_sessions SET model = $2, updated_at = NOW() WHERE doc_id = $1`, [
          docId,
          cfg.openaiModel,
        ]);
        row.model = cfg.openaiModel;
      }

      return row;
    };

    // Fast path (no lock): if it exists, return quickly.
    const fast = await fetchAndMaybeUpdate_(pool);
    if (fast) return fast;

    // Create path: serialize by docId via an advisory lock inside a transaction.
    // This avoids two concurrent calls creating duplicate OpenAI resources.
    if (typeof pool.connect !== "function") {
      // Fallback (tests/mocks): keep behavior, but still cleanup on failure.
      let conversationId;
      let vectorStoreId;
      try {
        const conv = await client.conversations.create({ metadata: { doc_id: docId } });
        conversationId = conv?.id;
        const vectorStore = await client.vectorStores.create({
          name: `docassist-${docId}`,
          metadata: { doc_id: docId },
        });
        vectorStoreId = vectorStore?.id;

        await pool.query(
          `INSERT INTO docs_sessions (doc_id, conversation_id, vector_store_id, instructions, model)
           VALUES ($1, $2, $3, $4, $5)`,
          [docId, conversationId, vectorStoreId, incoming, cfg.openaiModel]
        );

        return {
          doc_id: docId,
          conversation_id: conversationId,
          vector_store_id: vectorStoreId,
          instructions: incoming,
          model: cfg.openaiModel,
        };
      } catch (err) {
        await bestEffortDeleteOpenAIResources_({ conversationId, vectorStoreId });
        throw err;
      }
    }

    const db = await pool.connect();
    let createdConversationId;
    let createdVectorStoreId;
    let committed = false;

    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [docId]);

      const existingAfterLock = await fetchAndMaybeUpdate_(db);
      if (existingAfterLock) {
        await db.query("COMMIT");
        committed = true;
        return existingAfterLock;
      }

      const conv = await client.conversations.create({ metadata: { doc_id: docId } });
      createdConversationId = conv?.id;

      const vectorStore = await client.vectorStores.create({
        name: `docassist-${docId}`,
        metadata: { doc_id: docId },
      });
      createdVectorStoreId = vectorStore?.id;

      await db.query(
        `INSERT INTO docs_sessions (doc_id, conversation_id, vector_store_id, instructions, model)
         VALUES ($1, $2, $3, $4, $5)`,
        [docId, createdConversationId, createdVectorStoreId, incoming, cfg.openaiModel]
      );

      await db.query("COMMIT");
      committed = true;

      return {
        doc_id: docId,
        conversation_id: createdConversationId,
        vector_store_id: createdVectorStoreId,
        instructions: incoming,
        model: cfg.openaiModel,
      };
    } catch (err) {
      if (!committed) {
        try {
          await db.query("ROLLBACK");
        } catch (_) {
          // best-effort
        }
      }

      await bestEffortDeleteOpenAIResources_({
        conversationId: createdConversationId,
        vectorStoreId: createdVectorStoreId,
      });

      throw err;
    } finally {
      try {
        db.release();
      } catch (_) {
        // best-effort
      }
    }
  }

  // ====== DB-ALAPÚ CHAT HISTORY STORE ======
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

  async function appendToHistory(docId, role, content) {
    await pool.query(
      `
      INSERT INTO chat_history (doc_id, role, content)
      VALUES ($1, $2, $3)
      `,
      [docId, role, content]
    );

    const maxMessages = cfg.maxTurnsPerDoc * 2;

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

  async function runDocsAgent(text, instruction) {
    const response = await client.chat.completions.create({
      model: cfg.openaiModel,
      reasoning_effort: "high",
      max_completion_tokens: cfg.maxOutputTokens,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Context:\n${text}\n\nInstruction:\n${instruction}` },
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

  async function runChatWithDoc(docId, docText, userMessage) {
    const clippedDocText =
      docText.length > cfg.maxDocChars ? docText.slice(0, cfg.maxDocChars) : docText;

    const history = await getHistoryForDoc(docId);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: `Here is the current document content (possibly truncated):\n\n${clippedDocText}`,
      },
      ...history,
      { role: "user", content: userMessage },
    ];

    const response = await client.chat.completions.create({
      model: cfg.openaiModel,
      reasoning_effort: "high",
      max_completion_tokens: cfg.maxOutputTokens,
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

    await appendToHistory(docId, "user", userMessage);
    await appendToHistory(docId, "assistant", reply);

    return reply;
  }

  // Health check
  app.get("/", (req, res) => {
    res.send("Docs agent backend is running");
  });

  // ====== V2 INFO ======
  app.get("/v2/info", (req, res) => {
    return res.json({
      service: "doc-assist-server",
      serverTime: new Date().toISOString(),
      config: {
        model: cfg.openaiModel,
        maxOutputTokens: cfg.maxOutputTokens,
        bodyLimit: cfg.bodyLimit,
        rateLimit: {
          enabled: cfg.rateLimitEnabled,
          windowMs: cfg.rateLimitWindowMs,
          max: cfg.rateLimitMax,
        },
        limits: {
          maxDocIdChars: cfg.maxDocIdChars,
          maxUserMessageChars: cfg.maxUserMessageChars,
          maxInstructionsChars: cfg.maxInstructionsChars,
          maxDocTitleChars: cfg.maxDocTitleChars,
          maxFilenameChars: cfg.maxFilenameChars,
          maxDocTextChars: cfg.maxDocTextChars,
          maxUploadBytes: cfg.maxUploadBytes,
        },
      },
    });
  });

  // ====== V2 RESET DOC ======
  // Deletes server-side session + history for a doc.
  app.post("/v2/reset-doc", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json(jsonError(req, "Invalid JSON body"));
      }

      const docId = requireString(req, res, "docId", req.body.docId, {
        maxChars: cfg.maxDocIdChars,
      });
      if (!docId) return;

      const cleanupOpenAI = (() => {
        if (req.body.cleanupOpenAI == null) return cfg.resetCleanupOpenAI;
        const v = req.body.cleanupOpenAI;
        if (typeof v === "boolean") return v;
        const s = String(v).trim().toLowerCase();
        return s === "1" || s === "true" || s === "yes" || s === "on";
      })();

      // Optional best-effort OpenAI cleanup (off by default).
      if (cleanupOpenAI) {
        try {
          await bestEffortCleanupOpenAIForDoc_({ docId: String(docId) });
        } catch (_) {
          // best-effort
        }
      }

      const d1 = await pool.query(`DELETE FROM chat_history WHERE doc_id = $1`, [docId]);
      const d2 = await pool.query(`DELETE FROM docs_files WHERE doc_id = $1`, [docId]);
      const d3 = await pool.query(`DELETE FROM docs_sessions WHERE doc_id = $1`, [docId]);

      return res.json({
        ok: true,
        docId,
        deleted: {
          chatHistory: d1.rowCount ?? 0,
          docsFiles: d2.rowCount ?? 0,
          docsSessions: d3.rowCount ?? 0,
        },
        openaiCleanup: {
          enabled: cleanupOpenAI,
        },
      });
    } catch (err) {
      logger.error(err);
      return res.status(500).json(jsonError(req, "Server error"));
    }
  });

  // ====== V2 LIST FILES ======
  // Returns known uploaded/synced files for a doc.
  app.get("/v2/list-files", async (req, res) => {
    try {
      const docId = requireNonEmptyTrimmedString(req, res, "docId", req.query?.docId, {
        maxChars: cfg.maxDocIdChars,
      });
      if (docId == null) return;

      const result = await pool.query(
        `
          SELECT
            id,
            kind,
            filename,
            sha256,
            created_at,
            file_vector_store_id
          FROM docs_files
          WHERE doc_id = $1
            AND kind NOT IN ('doc_chunk', 'tab_chunk', 'upload_chunk')
          ORDER BY created_at DESC, id DESC
        `,
        [String(docId)]
      );

      return res.json({
        ok: true,
        docId: String(docId),
        files: (result.rows || []).map((r) => ({
          id: r.id,
          kind: r.kind,
          filename: r.filename,
          sha256: r.sha256,
          createdAt: r.created_at,
          hasFileScope: Boolean(r.file_vector_store_id),
        })),
      });
    } catch (err) {
      logger.error(err);
      return res.status(500).json(jsonError(req, "Server error"));
    }
  });

  // ====== V2 CLEANUP OPENAI ======
  // Deletes OpenAI vector stores/files and conversation for a doc (best-effort), without deleting DB rows.
  app.post("/v2/cleanup-openai", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json(jsonError(req, "Invalid JSON body"));
      }

      const docId = requireNonEmptyTrimmedString(req, res, "docId", req.body.docId, {
        maxChars: cfg.maxDocIdChars,
      });
      if (docId == null) return;

      const result = await bestEffortCleanupOpenAIForDoc_({ docId: String(docId) });
      return res.json({ ok: true, ...result });
    } catch (err) {
      logger.error(err);
      return res.status(500).json(jsonError(req, "Server error"));
    }
  });

  // ====== ENDPOINTOK ======
  app.post("/docs-agent", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json(jsonError(req, "Invalid JSON body"));
      }

      const text = requireString(req, res, "text", req.body.text, {
        maxChars: cfg.maxDocTextChars,
        allowEmpty: false,
      });
      if (text == null) return;

      const instruction = requireNonEmptyTrimmedString(req, res, "instruction", req.body.instruction, {
        maxChars: cfg.maxUserMessageChars,
      });
      if (instruction == null) return;

      const resultText = await runDocsAgent(text, instruction);
      return res.json({ resultText });
    } catch (err) {
      logger.error(err);
      return res
        .status(500)
        .json(jsonError(req, err.message || "Internal server error"));
    }
  });

  app.post("/chat-docs", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json(jsonError(req, "Invalid JSON body"));
      }

      const docId = requireNonEmptyTrimmedString(req, res, "docId", req.body.docId, {
        maxChars: cfg.maxDocIdChars,
      });
      if (docId == null) return;

      // Keep legacy semantics: require non-empty docText.
      const docText = requireString(req, res, "docText", req.body.docText, {
        maxChars: cfg.maxDocTextChars,
        allowEmpty: false,
      });
      if (docText == null) return;

      const userMessage = requireNonEmptyTrimmedString(req, res, "userMessage", req.body.userMessage, {
        maxChars: cfg.maxUserMessageChars,
      });
      if (userMessage == null) return;

      const answer = await runChatWithDoc(docId, docText, userMessage);
      return res.json({ reply: answer });
    } catch (err) {
      logger.error(err);
      return res
        .status(500)
        .json(jsonError(req, err.message || "Internal server error"));
    }
  });

  // ====== V2 ======
  app.post("/v2/init", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json(jsonError(req, "Invalid JSON body"));
      }

      const docId = requireNonEmptyTrimmedString(req, res, "docId", req.body.docId, {
        maxChars: cfg.maxDocIdChars,
      });
      if (docId == null) return;

      const instructions =
        typeof req.body.instructions === "undefined"
          ? ""
          : requireString(req, res, "instructions", req.body.instructions, {
              maxChars: cfg.maxInstructionsChars,
              allowEmpty: true,
            });
      if (instructions == null) return;

      const session = await getOrCreateSession(
        String(docId),
        typeof instructions === "string" ? instructions : ""
      );

      return res.json({
        docId: session.doc_id,
        conversationId: session.conversation_id,
        vectorStoreId: session.vector_store_id,
        model: session.model || cfg.openaiModel,
      });
    } catch (err) {
      logger.error(err);
      return res
        .status(500)
        .json(jsonError(req, err.message || "Internal server error"));
    }
  });

  app.post("/v2/sync-doc", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json(jsonError(req, "Invalid JSON body"));
      }

      const docId = requireNonEmptyTrimmedString(req, res, "docId", req.body.docId, {
        maxChars: cfg.maxDocIdChars,
      });
      if (docId == null) return;

      const docText = requireString(req, res, "docText", req.body.docText, {
        maxChars: cfg.maxDocTextChars,
        allowEmpty: true,
      });
      if (docText == null) return;

      const docTitle =
        typeof req.body.docTitle === "undefined"
          ? ""
          : requireString(req, res, "docTitle", req.body.docTitle, {
              maxChars: cfg.maxDocTitleChars,
              allowEmpty: true,
            });
      if (docTitle == null) return;

      const instructions =
        typeof req.body.instructions === "undefined"
          ? ""
          : requireString(req, res, "instructions", req.body.instructions, {
              maxChars: cfg.maxInstructionsChars,
              allowEmpty: true,
            });
      if (instructions == null) return;

      const replaceKnowledge = (() => {
        if (req.body.replaceKnowledge == null) return false;
        const v = req.body.replaceKnowledge;
        if (typeof v === "boolean") return v;
        const s = String(v).trim().toLowerCase();
        return s === "1" || s === "true" || s === "yes" || s === "on";
      })();

      const fileScopeEnabled = (() => {
        if (req.body.fileScope == null) return true;
        const v = req.body.fileScope;
        if (typeof v === "boolean") return v;
        const s = String(v).trim().toLowerCase();
        return !(s === "0" || s === "false" || s === "no" || s === "off");
      })();

      const session = await getOrCreateSession(
        String(docId),
        typeof instructions === "string" ? instructions : ""
      );

      if (replaceKnowledge) {
        await bestEffortReplaceKnowledgeForDoc_({
          docId: String(docId),
          vectorStoreId: session.vector_store_id,
        });
      }

      const safeTitle = String(docTitle || "document").replace(/[^a-zA-Z0-9._-]+/g, "_");
      const docEntryFilename = `${safeTitle || "document"}_${String(docId).slice(0, 8)}.txt`;
      const formatted = normalizeStructuredText(docText);
      if (!formatted) {
        throw new Error("This tab is empty.");
      }

      const docHash = sha256Hex(Buffer.from(formatted, "utf8"));
      if (!replaceKnowledge) {
        const existingDoc = await findExistingDocsFileByHash_(String(docId), "doc", docHash);
        if (existingDoc?.vector_store_file_id) {
          return res.json({
            vectorStoreFileId: existingDoc.vector_store_file_id,
            docsFileId: existingDoc.id,
            reused: true,
            hasFileScope: Boolean(existingDoc.file_vector_store_id),
          });
        }
      }

      // Create a per-file vector store for file-scoped chat.
      let fileVectorStoreId = null;
      if (fileScopeEnabled) {
        const fileVectorStore = await client.vectorStores.create({
          name: `docassist-${String(docId)}-doc-${docHash.slice(0, 12)}`,
          metadata: { doc_id: String(docId), kind: "doc", sha256: docHash },
        });
        fileVectorStoreId = fileVectorStore?.id;
      }

      const chunks = cfg.chunkingEnabled
        ? buildChunksFromStructuredText(formatted, {
            maxTokens: cfg.chunkMaxTokens,
            overlapTokens: cfg.chunkOverlapTokens,
          })
        : [{ sectionPath: "", text: formatted }];

      if (!chunks.length) {
        throw new Error("No content to sync.");
      }

      let firstDocVsfId = null;
      let firstFileScopeVsfId = null;

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const chunkText = String(chunk.text || "").trim();
        if (!chunkText) continue;

        const chunkHash = sha256Hex(Buffer.from(chunkText, "utf8"));
        const chunkKind = "doc_chunk";
        const sectionSlug = slugifyForFilename(chunk.sectionPath || `part-${i + 1}`);
        let chunkFilename = `${safeTitle || "document"}_${String(docId).slice(0, 8)}__${sectionSlug}__part-${i + 1}.txt`;
        if (chunkFilename.length > cfg.maxFilenameChars) {
          chunkFilename = chunkFilename.slice(0, cfg.maxFilenameChars);
        }

        let docVsfId = null;
        if (!replaceKnowledge) {
          const existingChunk = await findExistingDocsFileByHash_(String(docId), chunkKind, chunkHash);
          docVsfId = existingChunk?.vector_store_file_id || null;
        }

        if (!docVsfId) {
          const uploadableChunk = await toFile(Buffer.from(chunkText, "utf8"), chunkFilename, {
            type: "text/plain",
          });
          const vsFile = await client.vectorStores.files.uploadAndPoll(
            session.vector_store_id,
            uploadableChunk
          );
          docVsfId = vsFile.id;
        }

        let fileScopeVsf = null;
        if (fileScopeEnabled && fileVectorStoreId) {
          const uploadableFileScope = await toFile(Buffer.from(chunkText, "utf8"), chunkFilename, {
            type: "text/plain",
          });
          fileScopeVsf = await client.vectorStores.files.uploadAndPoll(
            fileVectorStoreId,
            uploadableFileScope
          );
        }

        await recordVectorStoreChunkFile(String(docId), chunkKind, chunkFilename, chunkHash, docVsfId, {
          fileVectorStoreId: fileVectorStoreId,
          fileVectorStoreFileId: fileScopeVsf?.id || null,
        });

        if (!firstDocVsfId) {
          firstDocVsfId = docVsfId;
          firstFileScopeVsfId = fileScopeVsf?.id || null;
        }
      }

      if (!firstDocVsfId) {
        throw new Error("No content to sync.");
      }

      await recordVectorStoreFile(String(docId), "doc", docEntryFilename, docHash, firstDocVsfId, {
        fileVectorStoreId: fileVectorStoreId,
        fileVectorStoreFileId: firstFileScopeVsfId,
      });

      try {
        await updateDocSummary_({
          docId: String(docId),
          title: String(docTitle || ""),
          kind: "doc",
          text: formatted,
          previousSummary: session.doc_summary,
        });
      } catch (e) {
        logger.error(e);
      }

      // Best-effort: fetch docs_files id for UI convenience.
      const created = await findExistingDocsFileByHash_(String(docId), "doc", docHash);
      return res.json({
        vectorStoreFileId: firstDocVsfId,
        docsFileId: created?.id,
        fileVectorStoreId,
        reused: false,
      });
    } catch (err) {
      logger.error(err);
      return res
        .status(500)
        .json(jsonError(req, err.message || "Internal server error"));
    }
  });

  app.post("/v2/sync-tab", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json(jsonError(req, "Invalid JSON body"));
      }

      const docId = requireNonEmptyTrimmedString(req, res, "docId", req.body.docId, {
        maxChars: cfg.maxDocIdChars,
      });
      if (docId == null) return;

      const tabId = requireNonEmptyTrimmedString(req, res, "tabId", req.body.tabId, {
        maxChars: 256,
      });
      if (tabId == null) return;

      const tabText = requireString(req, res, "tabText", req.body.tabText, {
        maxChars: cfg.maxDocTextChars,
        allowEmpty: true,
      });
      if (tabText == null) return;

      const tabTitle =
        typeof req.body.tabTitle === "undefined"
          ? ""
          : requireString(req, res, "tabTitle", req.body.tabTitle, {
              maxChars: cfg.maxDocTitleChars,
              allowEmpty: true,
            });
      if (tabTitle == null) return;

      const instructions =
        typeof req.body.instructions === "undefined"
          ? ""
          : requireString(req, res, "instructions", req.body.instructions, {
              maxChars: cfg.maxInstructionsChars,
              allowEmpty: true,
            });
      if (instructions == null) return;

      const replaceKnowledge = (() => {
        if (req.body.replaceKnowledge == null) return false;
        const v = req.body.replaceKnowledge;
        if (typeof v === "boolean") return v;
        const s = String(v).trim().toLowerCase();
        return s === "1" || s === "true" || s === "yes" || s === "on";
      })();

      const fileScopeEnabled = (() => {
        if (req.body.fileScope == null) return true;
        const v = req.body.fileScope;
        if (typeof v === "boolean") return v;
        const s = String(v).trim().toLowerCase();
        return !(s === "0" || s === "false" || s === "no" || s === "off");
      })();

      const session = await getOrCreateSession(
        String(docId),
        typeof instructions === "string" ? instructions : ""
      );

      if (replaceKnowledge) {
        await bestEffortReplaceKnowledgeForDoc_({
          docId: String(docId),
          vectorStoreId: session.vector_store_id,
        });
      }

      const safeTabTitle = String(tabTitle || "tab").replace(/[^a-zA-Z0-9._-]+/g, "_");
      const safeTabId = String(tabId).replace(/[^a-zA-Z0-9._-]+/g, "_");
      const safeDocPrefix = String(docId).slice(0, 8);
      let tabEntryFilename = `tab_${safeTabTitle || "tab"}_${safeTabId}_${safeDocPrefix}.txt`;
      if (tabEntryFilename.length > cfg.maxFilenameChars) {
        tabEntryFilename = tabEntryFilename.slice(0, cfg.maxFilenameChars);
      }

      const formatted = normalizeStructuredText(tabText);
      if (!formatted) {
        throw new Error("This tab is empty.");
      }

      // Hash includes tabId to avoid cross-tab dedupe collisions.
      const tabHash = sha256Hex(Buffer.from(`${String(tabId)}\n\n${formatted}`, "utf8"));

      if (!replaceKnowledge) {
        const existingTab = await findExistingDocsFileByHash_(String(docId), "tab", tabHash);
        if (existingTab?.vector_store_file_id) {
          return res.json({
            vectorStoreFileId: existingTab.vector_store_file_id,
            docsFileId: existingTab.id,
            reused: true,
            hasFileScope: Boolean(existingTab.file_vector_store_id),
          });
        }
      }

      let fileVectorStoreId = null;
      if (fileScopeEnabled) {
        const fileVectorStore = await client.vectorStores.create({
          name: `docassist-${String(docId)}-tab-${tabHash.slice(0, 12)}`,
          metadata: { doc_id: String(docId), kind: "tab", tab_id: String(tabId), sha256: tabHash },
        });
        fileVectorStoreId = fileVectorStore?.id;
      }

      const chunks = cfg.chunkingEnabled
        ? buildChunksFromStructuredText(formatted, {
            maxTokens: cfg.chunkMaxTokens,
            overlapTokens: cfg.chunkOverlapTokens,
          })
        : [{ sectionPath: "", text: formatted }];

      if (!chunks.length) {
        throw new Error("No content to sync.");
      }

      let firstDocVsfId = null;
      let firstFileScopeVsfId = null;

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const chunkText = String(chunk.text || "").trim();
        if (!chunkText) continue;

        const chunkHash = sha256Hex(Buffer.from(`${String(tabId)}\n\n${chunkText}`, "utf8"));
        const chunkKind = "tab_chunk";
        const sectionSlug = slugifyForFilename(chunk.sectionPath || `part-${i + 1}`);
        let chunkFilename = `tab_${safeTabTitle || "tab"}_${safeTabId}_${sectionSlug}__part-${i + 1}.txt`;
        if (chunkFilename.length > cfg.maxFilenameChars) {
          chunkFilename = chunkFilename.slice(0, cfg.maxFilenameChars);
        }

        let docVsfId = null;
        if (!replaceKnowledge) {
          const existingChunk = await findExistingDocsFileByHash_(String(docId), chunkKind, chunkHash);
          docVsfId = existingChunk?.vector_store_file_id || null;
        }

        if (!docVsfId) {
          const uploadableChunk = await toFile(Buffer.from(chunkText, "utf8"), chunkFilename, {
            type: "text/plain",
          });
          const vsFile = await client.vectorStores.files.uploadAndPoll(
            session.vector_store_id,
            uploadableChunk
          );
          docVsfId = vsFile.id;
        }

        let fileScopeVsf = null;
        if (fileScopeEnabled && fileVectorStoreId) {
          const uploadableFileScope = await toFile(Buffer.from(chunkText, "utf8"), chunkFilename, {
            type: "text/plain",
          });
          fileScopeVsf = await client.vectorStores.files.uploadAndPoll(
            fileVectorStoreId,
            uploadableFileScope
          );
        }

        await recordVectorStoreChunkFile(String(docId), chunkKind, chunkFilename, chunkHash, docVsfId, {
          fileVectorStoreId: fileVectorStoreId,
          fileVectorStoreFileId: fileScopeVsf?.id || null,
        });

        if (!firstDocVsfId) {
          firstDocVsfId = docVsfId;
          firstFileScopeVsfId = fileScopeVsf?.id || null;
        }
      }

      if (!firstDocVsfId) {
        throw new Error("No content to sync.");
      }

      await recordVectorStoreFile(String(docId), "tab", tabEntryFilename, tabHash, firstDocVsfId, {
        fileVectorStoreId: fileVectorStoreId,
        fileVectorStoreFileId: firstFileScopeVsfId,
      });

      try {
        await updateDocSummary_({
          docId: String(docId),
          title: String(tabTitle || ""),
          kind: "tab",
          text: formatted,
          previousSummary: session.doc_summary,
        });
      } catch (e) {
        logger.error(e);
      }

      // Best-effort: fetch docs_files id for UI convenience.
      const created = await findExistingDocsFileByHash_(String(docId), "tab", tabHash);
      return res.json({
        vectorStoreFileId: firstDocVsfId,
        docsFileId: created?.id,
        fileVectorStoreId,
        reused: false,
      });
    } catch (err) {
      logger.error(err);
      return res
        .status(500)
        .json(jsonError(req, err.message || "Internal server error"));
    }
  });

  app.post("/v2/upload-file", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json(jsonError(req, "Invalid JSON body"));
      }

      const docId = requireNonEmptyTrimmedString(req, res, "docId", req.body.docId, {
        maxChars: cfg.maxDocIdChars,
      });
      if (docId == null) return;

      const filename = requireNonEmptyTrimmedString(req, res, "filename", req.body.filename, {
        maxChars: cfg.maxFilenameChars,
      });
      if (filename == null) return;

      const contentBase64 = requireNonEmptyTrimmedString(
        req,
        res,
        "contentBase64",
        req.body.contentBase64,
        { maxChars: cfg.maxUploadBytes * 2 }
      );
      if (contentBase64 == null) return;

      const estimatedBytes = estimateBase64BytesLen(contentBase64);
      if (estimatedBytes <= 0) {
        return res.status(400).json(jsonError(req, "Invalid 'contentBase64'"));
      }
      if (estimatedBytes > cfg.maxUploadBytes) {
        return res
          .status(400)
          .json(jsonError(req, `File too large (max ${cfg.maxUploadBytes} bytes)`));
      }

      const mimeType =
        typeof req.body.mimeType === "undefined"
          ? ""
          : requireString(req, res, "mimeType", req.body.mimeType, {
              maxChars: 256,
              allowEmpty: true,
            });
      if (mimeType == null) return;

      const instructions =
        typeof req.body.instructions === "undefined"
          ? ""
          : requireString(req, res, "instructions", req.body.instructions, {
              maxChars: cfg.maxInstructionsChars,
              allowEmpty: true,
            });
      if (instructions == null) return;

      const replaceKnowledge = (() => {
        if (req.body.replaceKnowledge == null) return false;
        const v = req.body.replaceKnowledge;
        if (typeof v === "boolean") return v;
        const s = String(v).trim().toLowerCase();
        return s === "1" || s === "true" || s === "yes" || s === "on";
      })();

      const session = await getOrCreateSession(
        String(docId),
        typeof instructions === "string" ? instructions : ""
      );

      if (replaceKnowledge) {
        await bestEffortReplaceKnowledgeForDoc_({
          docId: String(docId),
          vectorStoreId: session.vector_store_id,
        });
      }

      let buf;
      try {
        buf = Buffer.from(String(contentBase64), "base64");
      } catch {
        return res.status(400).json(jsonError(req, "Invalid 'contentBase64'"));
      }

      if (!buf || buf.length === 0) {
        return res.status(400).json(jsonError(req, "Invalid 'contentBase64'"));
      }

      const hash = sha256Hex(buf);
      const safeName = String(filename).replace(/[^a-zA-Z0-9._-]+/g, "_");

      const existing = await findExistingDocsFileByHash_(String(docId), "upload", hash);
      if (existing?.vector_store_file_id) {
        return res.json({
          vectorStoreFileId: existing.vector_store_file_id,
          docsFileId: existing.id,
          reused: true,
          hasFileScope: Boolean(existing.file_vector_store_id),
        });
      }

      // Create a per-file vector store for file-scoped chat.
      const fileVectorStore = await client.vectorStores.create({
        name: `docassist-${String(docId)}-upload-${hash.slice(0, 12)}`,
        metadata: { doc_id: String(docId), kind: "upload", sha256: hash, filename: safeName },
      });
      const fileVectorStoreId = fileVectorStore?.id;

      const uploadableDoc = await toFile(buf, safeName, {
        type: String(mimeType || "application/octet-stream"),
      });
      const vsFile = await client.vectorStores.files.uploadAndPoll(session.vector_store_id, uploadableDoc);

      const uploadableFileScope = await toFile(buf, safeName, {
        type: String(mimeType || "application/octet-stream"),
      });
      const fileScopeVsf = await client.vectorStores.files.uploadAndPoll(
        fileVectorStoreId,
        uploadableFileScope
      );

      await recordVectorStoreFile(String(docId), "upload", safeName, hash, vsFile.id, {
        fileVectorStoreId,
        fileVectorStoreFileId: fileScopeVsf?.id || null,
      });

      if (isLikelyTextMime(mimeType, safeName)) {
        try {
          const text = buf.toString("utf8");
          await updateDocSummary_({
            docId: String(docId),
            title: String(filename || ""),
            kind: "upload",
            text,
            previousSummary: session.doc_summary,
          });
        } catch (e) {
          logger.error(e);
        }
      }

      const created = await findExistingDocsFileByHash_(String(docId), "upload", hash);

      return res.json({
        vectorStoreFileId: vsFile.id,
        docsFileId: created?.id,
        fileVectorStoreId,
        reused: false,
      });
    } catch (err) {
      logger.error(err);
      return res
        .status(500)
        .json(jsonError(req, err.message || "Internal server error"));
    }
  });

  app.post("/v2/chat", async (req, res) => {
    try {
      const started = Date.now();
      if (!isPlainObject(req.body)) {
        return res.status(400).json(jsonError(req, "Invalid JSON body"));
      }

      // Preserve legacy error string for missing required fields.
      if (req.body.docId == null || req.body.userMessage == null) {
        return res
          .status(400)
          .json(jsonError(req, "Missing 'docId' or 'userMessage'"));
      }

      const docId = requireNonEmptyTrimmedString(req, res, "docId", req.body.docId, {
        maxChars: cfg.maxDocIdChars,
      });
      if (docId == null) return;

      const userMessage = requireNonEmptyTrimmedString(req, res, "userMessage", req.body.userMessage, {
        maxChars: cfg.maxUserMessageChars,
      });
      if (userMessage == null) return;

      const instructions =
        typeof req.body.instructions === "undefined"
          ? ""
          : requireString(req, res, "instructions", req.body.instructions, {
              maxChars: cfg.maxInstructionsChars,
              allowEmpty: true,
            });
      if (instructions == null) return;

      const session = await getOrCreateSession(
        String(docId),
        typeof instructions === "string" ? instructions : ""
      );

      let scopedVectorStoreId = null;
      let scopedFileId = null;
      if (req.body.fileId != null && String(req.body.fileId).trim() !== "") {
        const n = Number.parseInt(String(req.body.fileId), 10);
        if (Number.isFinite(n) && n > 0) {
          scopedFileId = n;
          try {
            const f = await pool.query(
              `
                SELECT file_vector_store_id
                FROM docs_files
                WHERE doc_id = $1 AND id = $2
                LIMIT 1
              `,
              [String(docId), scopedFileId]
            );
            scopedVectorStoreId = f.rows?.[0]?.file_vector_store_id || null;
          } catch (_) {
            // best-effort: fall back to doc vector store
            scopedVectorStoreId = null;
          }
        }
      }

      const msgStr = String(userMessage || "");
      const askedModel = /(\bmelyik\b|\bwhich\b).*(\bmodel\b|\bopenai\b)/i.test(msgStr);
      if (askedModel) {
        const replyText = `A backend szerint ezzel a modellel hívlak: ${session.model || cfg.openaiModel}`;

        try {
          await appendToHistory(String(docId), "user", msgStr);
          await appendToHistory(String(docId), "assistant", replyText);
        } catch (e) {
          logger.error(e);
        }

        return res.json({
          reply: replyText,
          responseId: "local-model-info",
        });
      }

      const forceSearch = cfg.forceFileSearch && shouldForceFileSearch(msgStr);
      const baseRequest = {
        model: session.model || cfg.openaiModel,
        conversation: session.conversation_id,
        instructions: buildInstructions(session.instructions, session.doc_summary),
        tools: [
          {
            type: "file_search",
            vector_store_ids: [scopedVectorStoreId || session.vector_store_id],
          },
        ],
        input: msgStr,
        max_output_tokens: cfg.maxOutputTokens,
      };
      if (forceSearch) {
        baseRequest.tool_choice = { type: "file_search" };
      }

      let response;
      let usedSources = [];

      if (cfg.twoStepEnabled && isComplexPrompt(msgStr)) {
        const planInput =
          "You must use file_search. Return a brief plan and 3-6 quoted passages.\n" +
          "Format:\nPLAN: <2-5 bullets>\nPASSAGES:\n- <quote>\n- <quote>\n" +
          `\nQuestion: ${msgStr}`;

        const planResponse = await client.responses.create({
          ...baseRequest,
          input: planInput,
        });

        usedSources = extractSourcesFromResponse_(planResponse);
        const passages = extractPassagesFromPlan_(String(planResponse.output_text || ""));
        const passageBlock = passages.length ? passages.join("\n") : "(no passages returned)";

        const step2Input =
          "Answer the question using ONLY the passages below. If information is missing, say so.\n\n" +
          `PASSAGES:\n${passageBlock}\n\nQUESTION:\n${msgStr}`;

        response = await client.responses.create({
          model: session.model || cfg.openaiModel,
          conversation: session.conversation_id,
          instructions: buildInstructions(session.instructions, session.doc_summary),
          input: step2Input,
          max_output_tokens: cfg.maxOutputTokens,
        });
      } else {
        response = await client.responses.create(baseRequest);
        usedSources = extractSourcesFromResponse_(response);
      }

      const replyText = String(response.output_text || "").trim();
      const sourceFileIds = usedSources.map((s) => s.fileId).filter(Boolean);
      const fileMeta = await resolveSourceMetadata_(String(docId), sourceFileIds);
      const sources = usedSources.map((s) => {
        const meta = fileMeta.get(String(s.fileId)) || {};
        const section = extractSectionFromQuote_(s.quote);
        return {
          fileId: s.fileId,
          filename: meta.filename,
          kind: meta.kind,
          section,
          snippet: clipSnippet(s.quote),
        };
      });

      try {
        await appendToHistory(String(docId), "user", msgStr);
        await appendToHistory(String(docId), "assistant", replyText);
      } catch (e) {
        logger.error(e);
      }

      const usage = response?.usage || {};
      logChatEvent_({
        docId: String(docId),
        scope: scopedVectorStoreId ? "file" : "all",
        fileId: scopedFileId || null,
        model: session.model || cfg.openaiModel,
        forceSearch: Boolean(forceSearch),
        twoStep: Boolean(cfg.twoStepEnabled && isComplexPrompt(msgStr)),
        usedSources: sources.length,
        usage,
        latencyMs: Date.now() - started,
      });

      return res.json({
        reply: replyText,
        responseId: response.id,
        sources,
        scope: scopedVectorStoreId
          ? { type: "file", fileId: scopedFileId }
          : { type: "all" },
      });
    } catch (err) {
      logger.error(err);
      return res
        .status(500)
        .json(jsonError(req, err.message || "Internal server error"));
    }
  });

  // ====== ERROR HANDLING ======
  app.use((err, req, res, next) => {
    const isTooLarge = err && (err.type === "entity.too.large" || err.status === 413);
    if (isTooLarge) {
      return res.status(413).json({
        ...jsonError(
          req,
          `Payload Too Large. Increase DOCASSIST_BODY_LIMIT (current: ${cfg.bodyLimit}).`
        ),
      });
    }
    return next(err);
  });

  // Fallback JSON error (keeps Apps Script happy)
  app.use((err, req, res, next) => {
    if (!err) return next();
    logger.error(err);
    const status = Number(err.status) || 500;
    return res.status(status).json(jsonError(req, err.message || "Internal server error"));
  });

  return {
    app,
    ensureTables,
    config: cfg,
  };
}
