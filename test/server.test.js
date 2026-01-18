import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../app.js";

function makePoolMock({ sessionRow, queryHandler } = {}) {
  return {
    async query(sql, params) {
      if (typeof queryHandler === "function") {
        const handled = await queryHandler(sql, params);
        if (handled) return handled;
      }

      const q = String(sql);

      if (q.includes("INSERT INTO chat_history")) {
        return { rows: [], rowCount: 1 };
      }

      if (q.includes("SELECT COUNT(*) AS cnt") && q.includes("FROM chat_history")) {
        return { rows: [{ cnt: "0" }], rowCount: 1 };
      }

      if (q.includes("DELETE FROM chat_history") && q.includes("WHERE id IN")) {
        return { rows: [], rowCount: 0 };
      }

      if (q.includes("SELECT doc_id, conversation_id")) {
        return { rows: sessionRow ? [sessionRow] : [] };
      }

      // default empty result for other queries in tests
      return { rows: [], rowCount: 0 };
    },
  };
}

function makePoolThatMustNotBeCalled() {
  return {
    async query() {
      throw new Error("DB should not be called");
    },
  };
}

test("GET / returns health string", async () => {
  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app).get("/");
  assert.equal(res.status, 200);
  assert.match(res.text, /running/i);
});

test("POST /v2/init missing docId -> 400", async () => {
  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app).post("/v2/init").send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Missing 'docId'");
});

test("POST /v2/init docId too large -> 400 (no DB)", async () => {
  const { app } = createApp({
    pool: makePoolThatMustNotBeCalled(),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "", maxDocIdChars: 8 },
  });

  const res = await request(app).post("/v2/init").send({ docId: "123456789" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /docId/i);
});

test("POST /v2/chat missing fields -> 400", async () => {
  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app).post("/v2/chat").send({ docId: "x" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Missing 'docId' or 'userMessage'");
});

test("POST /v2/chat asked model -> local response without OpenAI call", async () => {
  const inserts = [];
  const { app } = createApp({
    pool: makePoolMock({
      sessionRow: {
        doc_id: "doc1",
        conversation_id: "c1",
        vector_store_id: "vs1",
        instructions: "",
        model: "test-model",
      },
      queryHandler: async (sql, params) => {
        const q = String(sql);
        if (q.includes("INSERT INTO chat_history")) {
          inserts.push(params);
          return { rows: [], rowCount: 1 };
        }
        if (q.includes("SELECT COUNT(*) AS cnt") && q.includes("FROM chat_history")) {
          return { rows: [{ cnt: "0" }], rowCount: 1 };
        }
        return null;
      },
    }),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app)
    .post("/v2/chat")
    .send({ docId: "doc1", userMessage: "which model are you using?" });

  assert.equal(res.status, 200);
  assert.equal(res.body.responseId, "local-model-info");
  assert.match(res.body.reply, /test-model/);

  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts[0], ["doc1", "user", "which model are you using?"]);
  assert.equal(inserts[1][0], "doc1");
  assert.equal(inserts[1][1], "assistant");
  assert.match(String(inserts[1][2]), /test-model/);
});

test("POST /v2/chat persists user+assistant turns (OpenAI path)", async () => {
  const calls = [];

  const openaiClient = {
    responses: {
      async create() {
        return { id: "r1", output_text: "Hello from OpenAI" };
      },
    },
  };

  const { app } = createApp({
    pool: makePoolMock({
      sessionRow: {
        doc_id: "doc1",
        conversation_id: "c1",
        vector_store_id: "vs1",
        instructions: "",
        model: "test-model",
      },
      queryHandler: async (sql, params) => {
        const q = String(sql);
        if (q.includes("INSERT INTO chat_history")) {
          calls.push({ type: "insert", params });
          return { rows: [], rowCount: 1 };
        }
        if (q.includes("SELECT COUNT(*) AS cnt") && q.includes("FROM chat_history")) {
          return { rows: [{ cnt: "0" }], rowCount: 1 };
        }
        return null;
      },
    }),
    openaiClient,
    config: { bodyLimit: "10kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app)
    .post("/v2/chat")
    .send({ docId: "doc1", userMessage: "hi" });

  assert.equal(res.status, 200);
  assert.equal(res.body.responseId, "r1");
  assert.equal(res.body.reply, "Hello from OpenAI");

  const inserts = calls.filter((c) => c.type === "insert").map((c) => c.params);
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts[0], ["doc1", "user", "hi"]);
  assert.deepEqual(inserts[1], ["doc1", "assistant", "Hello from OpenAI"]);
});

test("Oversized body returns JSON 413", async () => {
  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient: {},
    config: { bodyLimit: "1kb", token: "" },
  });

  const big = "a".repeat(5000);
  const res = await request(app).post("/docs-agent").send({ text: big, instruction: "x" });
  assert.equal(res.status, 413);
  assert.ok(res.body && typeof res.body.error === "string");
});

test("Rate limiting disabled by default", async () => {
  const { app } = createApp({
    pool: makePoolMock({
      sessionRow: {
        doc_id: "doc1",
        conversation_id: "c1",
        vector_store_id: "vs1",
        instructions: "",
        model: "test-model",
      },
    }),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "", openaiModel: "test-model" },
  });

  for (let i = 0; i < 5; i++) {
    const res = await request(app).post("/v2/init").send({ docId: "doc1" });
    assert.equal(res.status, 200);
  }
});

test("Rate limiting returns 429 when enabled", async () => {
  const { app } = createApp({
    pool: makePoolMock({
      sessionRow: {
        doc_id: "doc1",
        conversation_id: "c1",
        vector_store_id: "vs1",
        instructions: "",
        model: "test-model",
      },
    }),
    openaiClient: {},
    config: {
      bodyLimit: "10kb",
      token: "",
      openaiModel: "test-model",
      rateLimitEnabled: true,
      rateLimitWindowMs: 1000,
      rateLimitMax: 2,
    },
  });

  const r1 = await request(app).post("/v2/init").send({ docId: "doc1" });
  const r2 = await request(app).post("/v2/init").send({ docId: "doc1" });
  const r3 = await request(app).post("/v2/init").send({ docId: "doc1" });

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
  assert.match(r3.body.error, /rate limit/i);
  assert.ok(r3.headers["retry-after"]);
});

test("GET /v2/info returns config", async () => {
  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient: {},
    config: {
      bodyLimit: "10kb",
      token: "",
      openaiModel: "test-model",
      maxOutputTokens: 321,
      rateLimitEnabled: true,
      rateLimitWindowMs: 1234,
      rateLimitMax: 5,
    },
  });

  const res = await request(app).get("/v2/info");
  assert.equal(res.status, 200);
  assert.equal(res.body.service, "doc-assist-server");
  assert.equal(res.body.config.model, "test-model");
  assert.equal(res.body.config.maxOutputTokens, 321);
  assert.equal(res.body.config.bodyLimit, "10kb");
  assert.equal(res.body.config.rateLimit.enabled, true);
  assert.equal(res.body.config.rateLimit.windowMs, 1234);
  assert.equal(res.body.config.rateLimit.max, 5);
  assert.ok(res.headers["x-request-id"]);
});

test("GET /v2/list-files missing docId -> 400", async () => {
  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app).get("/v2/list-files");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /docId/i);
});

test("GET /v2/list-files returns files", async () => {
  const { app } = createApp({
    pool: makePoolMock({
      queryHandler: async (sql, params) => {
        const q = String(sql);
        if (q.includes("FROM docs_files") && q.includes("WHERE doc_id")) {
          assert.deepEqual(params, ["doc1"]);
          return {
            rows: [
              {
                id: 12,
                kind: "upload",
                filename: "a.txt",
                sha256: "h1",
                created_at: "2025-01-01T00:00:00.000Z",
                file_vector_store_id: "fvs1",
              },
              {
                id: 11,
                kind: "doc",
                filename: "doc.txt",
                sha256: "h2",
                created_at: "2025-01-01T00:00:00.000Z",
                file_vector_store_id: null,
              },
            ],
            rowCount: 2,
          };
        }
        return null;
      },
    }),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app).get("/v2/list-files").query({ docId: "doc1" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.docId, "doc1");
  assert.equal(Array.isArray(res.body.files), true);
  assert.deepEqual(res.body.files[0], {
    id: 12,
    kind: "upload",
    filename: "a.txt",
    sha256: "h1",
    createdAt: "2025-01-01T00:00:00.000Z",
    hasFileScope: true,
  });
  assert.equal(res.body.files[1].hasFileScope, false);
});

test("POST /v2/chat with fileId uses file-scoped vector store", async () => {
  const openaiCalls = [];
  const openaiClient = {
    responses: {
      async create(payload) {
        openaiCalls.push(payload);
        return { id: "r2", output_text: "Scoped" };
      },
    },
  };

  const { app } = createApp({
    pool: makePoolMock({
      sessionRow: {
        doc_id: "doc1",
        conversation_id: "c1",
        vector_store_id: "vs_doc",
        instructions: "",
        model: "test-model",
      },
      queryHandler: async (sql, params) => {
        const q = String(sql);
        if (q.includes("SELECT file_vector_store_id") && q.includes("FROM docs_files")) {
          assert.deepEqual(params, ["doc1", 12]);
          return { rows: [{ file_vector_store_id: "vs_file" }], rowCount: 1 };
        }
        if (q.includes("INSERT INTO chat_history")) {
          return { rows: [], rowCount: 1 };
        }
        if (q.includes("SELECT COUNT(*) AS cnt") && q.includes("FROM chat_history")) {
          return { rows: [{ cnt: "0" }], rowCount: 1 };
        }
        return null;
      },
    }),
    openaiClient,
    config: { bodyLimit: "10kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app)
    .post("/v2/chat")
    .send({ docId: "doc1", userMessage: "hi", fileId: 12 });

  assert.equal(res.status, 200);
  assert.equal(res.body.reply, "Scoped");
  assert.deepEqual(res.body.scope, { type: "file", fileId: 12 });

  assert.equal(openaiCalls.length, 1);
  assert.deepEqual(openaiCalls[0].tools[0].vector_store_ids, ["vs_file"]);
});

test("POST /v2/reset-doc missing docId -> 400", async () => {
  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app).post("/v2/reset-doc").send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Missing 'docId'");
});

test("POST /v2/reset-doc deletes DB state", async () => {
  const calls = [];
  const { app } = createApp({
    pool: makePoolMock({
      queryHandler: async (sql, params) => {
        calls.push({ sql: String(sql), params });
        const q = String(sql);
        if (q.includes("DELETE FROM chat_history")) return { rows: [], rowCount: 7 };
        if (q.includes("DELETE FROM docs_files")) return { rows: [], rowCount: 2 };
        if (q.includes("DELETE FROM docs_sessions")) return { rows: [], rowCount: 1 };
        return null;
      },
    }),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app).post("/v2/reset-doc").send({ docId: "doc1" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.docId, "doc1");
  assert.deepEqual(res.body.deleted, {
    chatHistory: 7,
    docsFiles: 2,
    docsSessions: 1,
  });
  assert.ok(res.headers["x-request-id"]);
  assert.ok(calls.length >= 3);
});

test("POST /v2/reset-doc cleanupOpenAI=true attempts OpenAI deletes (best-effort)", async () => {
  const openaiCalls = [];
  const openaiClient = {
    vectorStores: {
      files: {
        del: async (vectorStoreId, fileId) => {
          openaiCalls.push({ op: "vs.files.del", vectorStoreId, fileId });
        },
      },
      del: async (vectorStoreId) => {
        openaiCalls.push({ op: "vs.del", vectorStoreId });
      },
    },
    conversations: {
      del: async (conversationId) => {
        openaiCalls.push({ op: "conv.del", conversationId });
      },
    },
  };

  const { app } = createApp({
    pool: makePoolMock({
      queryHandler: async (sql, params) => {
        const q = String(sql);
        if (q.includes("SELECT conversation_id, vector_store_id")) {
          return { rows: [{ conversation_id: "c1", vector_store_id: "vs1" }], rowCount: 1 };
        }
        if (q.includes("SELECT vector_store_file_id")) {
          return { rows: [{ vector_store_file_id: "f1" }, { vector_store_file_id: "f2" }], rowCount: 2 };
        }
        if (q.includes("DELETE FROM chat_history")) return { rows: [], rowCount: 0 };
        if (q.includes("DELETE FROM docs_files")) return { rows: [], rowCount: 2 };
        if (q.includes("DELETE FROM docs_sessions")) return { rows: [], rowCount: 1 };
        return null;
      },
    }),
    openaiClient,
    config: { bodyLimit: "10kb", token: "", resetCleanupOpenAI: false },
  });

  const res = await request(app)
    .post("/v2/reset-doc")
    .send({ docId: "doc1", cleanupOpenAI: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.openaiCleanup.enabled, true);
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.del" && c.fileId === "f1"));
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.del" && c.fileId === "f2"));
  assert.ok(openaiCalls.find((c) => c.op === "vs.del"));
  assert.ok(openaiCalls.find((c) => c.op === "conv.del"));
});

test("POST /v2/init cleans up OpenAI resources if DB insert fails", async () => {
  const openaiCalls = [];
  const openaiClient = {
    conversations: {
      create: async () => ({ id: "c_new" }),
      del: async (conversationId) => {
        openaiCalls.push({ op: "conv.del", conversationId });
      },
    },
    vectorStores: {
      create: async () => ({ id: "vs_new" }),
      del: async (vectorStoreId) => {
        openaiCalls.push({ op: "vs.del", vectorStoreId });
      },
    },
  };

  const txClient = {
    async query(sql, params) {
      const q = String(sql);
      if (q === "BEGIN") return { rows: [], rowCount: 0 };
      if (q === "COMMIT") return { rows: [], rowCount: 0 };
      if (q === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (q.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
      if (q.includes("SELECT doc_id, conversation_id")) return { rows: [], rowCount: 0 };
      if (q.includes("INSERT INTO docs_sessions")) {
        throw new Error("db insert failed");
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const pool = {
    async query(sql) {
      const q = String(sql);
      if (q.includes("SELECT doc_id, conversation_id")) return { rows: [], rowCount: 0 };
      // Should not run updates/inserts on pool directly once we go to the transactional path.
      throw new Error("Unexpected pool.query call: " + q);
    },
    async connect() {
      return txClient;
    },
  };

  const { app } = createApp({
    pool,
    openaiClient,
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app).post("/v2/init").send({ docId: "doc1" });
  assert.equal(res.status, 500);
  assert.ok(openaiCalls.find((c) => c.op === "vs.del" && c.vectorStoreId === "vs_new"));
  assert.ok(openaiCalls.find((c) => c.op === "conv.del" && c.conversationId === "c_new"));
});

test("POST /v2/sync-doc replaceKnowledge=true deletes old files before upload", async () => {
  const openaiCalls = [];
  let createdVs = 0;
  let uploadCalls = 0;
  const openaiClient = {
    vectorStores: {
      create: async () => {
        createdVs += 1;
        const id = `vs_file_${createdVs}`;
        openaiCalls.push({ op: "vs.create", id });
        return { id };
      },
      files: {
        del: async (vectorStoreId, fileId) => {
          openaiCalls.push({ op: "vs.files.del", vectorStoreId, fileId });
        },
        uploadAndPoll: async (vectorStoreId) => {
          openaiCalls.push({ op: "vs.files.uploadAndPoll", vectorStoreId });
          uploadCalls += 1;
          return { id: uploadCalls === 1 ? "new_file" : "new_file_scoped" };
        },
      },
    },
  };

  const pool = makePoolMock({
    sessionRow: {
      doc_id: "doc1",
      conversation_id: "c1",
      vector_store_id: "vs1",
      instructions: "",
      model: "test-model",
    },
    queryHandler: async (sql) => {
      const q = String(sql);

      // replaceKnowledge: list all file ids for doc
      if (q.includes("SELECT vector_store_file_id") && q.includes("FROM docs_files") && q.includes("WHERE doc_id")) {
        return {
          rows: [
            { vector_store_file_id: "f1", file_vector_store_id: null, file_vector_store_file_id: null },
            { vector_store_file_id: "f2", file_vector_store_id: null, file_vector_store_file_id: null },
          ],
          rowCount: 2,
        };
      }

      if (q.includes("DELETE FROM docs_files WHERE doc_id")) {
        return { rows: [], rowCount: 2 };
      }

      // dedupe check during sync
      if (q.includes("FROM docs_files") && q.includes("AND kind") && q.includes("AND sha256")) {
        return { rows: [], rowCount: 0 };
      }

      // recordVectorStoreFile insert
      if (q.includes("INSERT INTO docs_files")) {
        return { rows: [], rowCount: 1 };
      }

      return null;
    },
  });

  const { app } = createApp({
    pool,
    openaiClient,
    config: { bodyLimit: "50kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app)
    .post("/v2/sync-doc")
    .send({ docId: "doc1", docTitle: "t", docText: "hello", replaceKnowledge: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.reused, false);
  assert.equal(res.body.vectorStoreFileId, "new_file");

  // Old files deleted
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.del" && c.fileId === "f1"));
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.del" && c.fileId === "f2"));

  // New upload occurs
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.uploadAndPoll"));
  assert.ok(openaiCalls.find((c) => c.op === "vs.create"));
});

test("POST /v2/sync-tab missing fields -> 400", async () => {
  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "" },
  });

  const r1 = await request(app).post("/v2/sync-tab").send({});
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /docId/i);

  const r2 = await request(app).post("/v2/sync-tab").send({ docId: "d" });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /tabId/i);

  const r3 = await request(app).post("/v2/sync-tab").send({ docId: "d", tabId: "t" });
  assert.equal(r3.status, 400);
  assert.match(r3.body.error, /tabText/i);
});

test("POST /v2/sync-tab uploads and records a tab entry", async () => {
  const openaiCalls = [];
  let createdVs = 0;
  let uploadCalls = 0;

  const openaiClient = {
    conversations: {
      create: async () => ({ id: "c1" }),
    },
    vectorStores: {
      create: async (payload) => {
        createdVs += 1;
        const id = `vs_file_${createdVs}`;
        openaiCalls.push({ op: "vs.create", id, payload });
        return { id };
      },
      files: {
        uploadAndPoll: async (vectorStoreId) => {
          uploadCalls += 1;
          openaiCalls.push({ op: "vs.files.uploadAndPoll", vectorStoreId });
          return { id: uploadCalls === 1 ? "vsf_doc" : "vsf_tab" };
        },
      },
    },
  };

  const inserts = [];
  let docsFilesInserted = 0;
  const pool = makePoolMock({
    sessionRow: {
      doc_id: "doc1",
      conversation_id: "c1",
      vector_store_id: "vs_doc",
      instructions: "",
      model: "test-model",
    },
    queryHandler: async (sql, params) => {
      const q = String(sql);

      // dedupe check during sync
      if (q.includes("FROM docs_files") && q.includes("AND kind") && q.includes("AND sha256")) {
        if (docsFilesInserted > 0) {
          return {
            rows: [
              {
                id: 99,
                vector_store_file_id: "vsf_doc",
                file_vector_store_id: "vs_file_1",
                file_vector_store_file_id: "vsf_tab",
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // recordVectorStoreFile insert
      if (q.includes("INSERT INTO docs_files")) {
        inserts.push({ sql: q, params });
        docsFilesInserted += 1;
        return { rows: [], rowCount: 1 };
      }

      return null;
    },
  });

  const { app } = createApp({
    pool,
    openaiClient,
    config: { bodyLimit: "50kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app).post("/v2/sync-tab").send({
    docId: "doc1",
    tabId: "tab_123",
    tabTitle: "Overview",
    tabText: "Hello tab",
    replaceKnowledge: false,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.reused, false);
  assert.equal(res.body.vectorStoreFileId, "vsf_doc");
  assert.equal(res.body.docsFileId, 99);
  assert.equal(res.body.fileVectorStoreId, "vs_file_1");

  assert.ok(openaiCalls.find((c) => c.op === "vs.create"));
  assert.equal(openaiCalls.filter((c) => c.op === "vs.files.uploadAndPoll").length, 2);

  // Ensure we inserted with kind='tab'
  assert.ok(inserts.length >= 1);
  assert.equal(inserts[0].params[1], "tab");
});

test("POST /v2/upload-file replaceKnowledge=true deletes old files before upload", async () => {
  const openaiCalls = [];
  let createdVs = 0;
  let uploadCalls = 0;
  const openaiClient = {
    vectorStores: {
      create: async () => {
        createdVs += 1;
        const id = `vs_file_${createdVs}`;
        openaiCalls.push({ op: "vs.create", id });
        return { id };
      },
      files: {
        del: async (vectorStoreId, fileId) => {
          openaiCalls.push({ op: "vs.files.del", vectorStoreId, fileId });
        },
        uploadAndPoll: async (vectorStoreId) => {
          openaiCalls.push({ op: "vs.files.uploadAndPoll", vectorStoreId });
          uploadCalls += 1;
          return { id: uploadCalls === 1 ? "new_upload" : "new_upload_scoped" };
        },
      },
    },
  };

  const pool = makePoolMock({
    sessionRow: {
      doc_id: "doc1",
      conversation_id: "c1",
      vector_store_id: "vs1",
      instructions: "",
      model: "test-model",
    },
    queryHandler: async (sql) => {
      const q = String(sql);

      if (q.includes("SELECT vector_store_file_id") && q.includes("FROM docs_files") && q.includes("WHERE doc_id")) {
        return {
          rows: [
            { vector_store_file_id: "f1", file_vector_store_id: null, file_vector_store_file_id: null },
            { vector_store_file_id: "f2", file_vector_store_id: null, file_vector_store_file_id: null },
          ],
          rowCount: 2,
        };
      }

      if (q.includes("DELETE FROM docs_files WHERE doc_id")) {
        return { rows: [], rowCount: 2 };
      }

      if (q.includes("FROM docs_files") && q.includes("AND kind") && q.includes("AND sha256")) {
        return { rows: [], rowCount: 0 };
      }

      if (q.includes("INSERT INTO docs_files")) {
        return { rows: [], rowCount: 1 };
      }

      return null;
    },
  });

  const { app } = createApp({
    pool,
    openaiClient,
    config: { bodyLimit: "50kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app).post("/v2/upload-file").send({
    docId: "doc1",
    filename: "a.txt",
    mimeType: "text/plain",
    contentBase64: "aGVsbG8=",
    replaceKnowledge: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.reused, false);
  assert.equal(res.body.vectorStoreFileId, "new_upload");

  assert.ok(openaiCalls.find((c) => c.op === "vs.files.del" && c.fileId === "f1"));
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.del" && c.fileId === "f2"));
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.uploadAndPoll"));
  assert.ok(openaiCalls.find((c) => c.op === "vs.create"));
});
