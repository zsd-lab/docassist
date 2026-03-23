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

  const res = await request(app)
    .post("/v2/chat")
    .send({ docId: "doc1", userMessage: "which model are you using?" });

  assert.equal(res.status, 200);
  assert.equal(res.body.responseId, "local-model-info");
  assert.match(res.body.reply, /test-model/);
});

test("POST /v2/chat replies without persisting duplicate local doc turns", async () => {
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
});

test("POST /v2/chat returns generated spreadsheet files", async () => {
  const openaiClient = {
    responses: {
      async create() {
        return {
          id: "r_gen",
          output_text: "I created the workbook.",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "I created the workbook.",
                  annotations: [
                    {
                      type: "container_file_citation",
                      container_id: "cont_1",
                      file_id: "file_1",
                      filename: "report.xlsx",
                    },
                  ],
                },
              ],
            },
          ],
        };
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
    }),
    openaiClient,
    config: { bodyLimit: "10kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app)
    .post("/v2/chat")
    .send({ docId: "doc1", userMessage: "Create an Excel workbook with the totals." });

  assert.equal(res.status, 200);
  assert.equal(res.body.reply, "I created the workbook.");
  assert.deepEqual(res.body.generatedFiles, [
    {
      containerId: "cont_1",
      fileId: "file_1",
      filename: "report.xlsx",
      isSpreadsheet: true,
      downloadPath: "/v2/generated-files/cont_1/file_1?filename=report.xlsx",
    },
  ]);
});

test("GET /v2/generated-files streams container file downloads", async () => {
  const openaiClient = {
    containers: {
      files: {
        content: {
          async retrieve(fileId, options) {
            assert.equal(fileId, "file_1");
            assert.deepEqual(options, { container_id: "cont_1" });
            return new Response(Buffer.from("a,b\n1,2\n"), {
              headers: { "content-type": "text/csv; charset=utf-8" },
            });
          },
        },
      },
    },
  };

  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient,
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app)
    .get("/v2/generated-files/cont_1/file_1")
    .query({ filename: "report.csv" });

  assert.equal(res.status, 200);
  assert.equal(res.text, "a,b\n1,2\n");
  assert.match(res.headers["content-disposition"], /report\.csv/);
  assert.match(res.headers["content-type"], /text\/csv/i);
});

test("POST /v2/chats/:chatId/send persists generated file metadata", async () => {
  const insertedMessages = [];
  const openaiClient = {
    responses: {
      async create(payload) {
        assert.ok(Array.isArray(payload.tools));
        assert.ok(payload.tools.some((tool) => tool.type === "code_interpreter"));
        return {
          id: "r_thread",
          output_text: "Done.",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Done.",
                  annotations: [
                    {
                      type: "container_file_citation",
                      container_id: "cont_thread",
                      file_id: "file_thread",
                      filename: "thread.xlsx",
                    },
                  ],
                },
              ],
            },
          ],
        };
      },
    },
  };

  const { app } = createApp({
    pool: makePoolMock({
      queryHandler: async (sql, params) => {
        const q = String(sql);
        if (q.includes("FROM chats") && q.includes("WHERE id = $1 AND user_id = $2")) {
          return {
            rows: [
              {
                id: "chat1",
                user_id: "user1",
                title: "New chat",
                openai_conversation_id: "conv1",
                archived_at: null,
                created_at: "2025-01-01T00:00:00.000Z",
                updated_at: "2025-01-01T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }
        if (q.includes("INSERT INTO chat_messages")) {
          insertedMessages.push(params);
          return { rows: [], rowCount: 1 };
        }
        if (q.includes("UPDATE chats SET title = $2")) {
          return { rows: [], rowCount: 1 };
        }
        if (q.includes("UPDATE chats SET updated_at = NOW()")) {
          return { rows: [], rowCount: 1 };
        }
        return null;
      },
    }),
    openaiClient,
    config: { bodyLimit: "10kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app)
    .post("/v2/chats/chat1/send")
    .send({ userId: "user1", userMessage: "Create an Excel export for me." });

  assert.equal(res.status, 200);
  assert.equal(res.body.reply, "Done.");
  assert.equal(insertedMessages.length, 2);
  assert.equal(insertedMessages[0][1], "user");
  assert.equal(insertedMessages[1][1], "assistant");
  assert.deepEqual(insertedMessages[1][3], {
    generatedFiles: [
      {
        containerId: "cont_thread",
        fileId: "file_thread",
        filename: "thread.xlsx",
        isSpreadsheet: true,
        downloadPath: "/v2/generated-files/cont_thread/file_thread?filename=thread.xlsx",
      },
    ],
  });
});

test("GET /v2/chats/:chatId/messages returns generated files from metadata", async () => {
  const { app } = createApp({
    pool: makePoolMock({
      queryHandler: async (sql, params) => {
        const q = String(sql);
        if (q.includes("FROM chats") && q.includes("WHERE id = $1 AND user_id = $2")) {
          assert.deepEqual(params, ["chat1", "user1"]);
          return {
            rows: [
              {
                id: "chat1",
                user_id: "user1",
                title: "Budget chat",
                openai_conversation_id: "conv1",
                archived_at: null,
                created_at: "2025-01-01T00:00:00.000Z",
                updated_at: "2025-01-01T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }
        if (q.includes("FROM chat_messages")) {
          assert.deepEqual(params, ["chat1", 200]);
          return {
            rows: [
              {
                id: 10,
                role: "assistant",
                content: "Here is the file.",
                metadata: {
                  generatedFiles: [
                    {
                      containerId: "cont_saved",
                      fileId: "file_saved",
                      filename: "saved.xlsx",
                      isSpreadsheet: true,
                      downloadPath: "/v2/generated-files/cont_saved/file_saved?filename=saved.xlsx",
                    },
                  ],
                },
                created_at: "2025-01-01T00:00:01.000Z",
              },
            ],
            rowCount: 1,
          };
        }
        return null;
      },
    }),
    openaiClient: {},
    config: { bodyLimit: "10kb", token: "" },
  });

  const res = await request(app)
    .get("/v2/chats/chat1/messages")
    .query({ userId: "user1" });

  assert.equal(res.status, 200);
  assert.equal(res.body.messages.length, 1);
  assert.deepEqual(res.body.messages[0].generatedFiles, [
    {
      containerId: "cont_saved",
      fileId: "file_saved",
      filename: "saved.xlsx",
      isSpreadsheet: true,
      downloadPath: "/v2/generated-files/cont_saved/file_saved?filename=saved.xlsx",
    },
  ]);
});

test("Oversized body returns JSON 413", async () => {
  const { app } = createApp({
    pool: makePoolMock(),
    openaiClient: {},
    config: { bodyLimit: "1kb", token: "" },
  });

  const big = "a".repeat(5000);
  const res = await request(app).post("/v2/chat").send({ docId: "doc1", userMessage: big });
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
    fileScopeStatus: "ready",
  });
  assert.equal(res.body.files[1].hasFileScope, false);
  assert.equal(res.body.files[1].fileScopeStatus, "lazy");
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
        if (q.includes("FROM docs_files") && q.includes("WHERE doc_id = $1 AND id = $2")) {
          assert.deepEqual(params, ["doc1", 12]);
          return {
            rows: [
              {
                id: 12,
                doc_id: "doc1",
                kind: "upload",
                filename: "a.txt",
                sha256: "h1",
                vector_store_file_id: "vsf_doc",
                file_vector_store_id: "vs_file",
                file_vector_store_file_id: "vsf_file",
                vector_store_file_file_id: "file_doc",
                file_vector_store_file_file_id: "file_doc",
                source_parent_kind: null,
                source_parent_sha256: null,
              },
            ],
            rowCount: 1,
          };
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

test("POST /v2/chat with fileId lazily materializes file-scoped vector store", async () => {
  const openaiCalls = [];
  const updates = [];
  let attachCount = 0;

  const openaiClient = {
    vectorStores: {
      create: async (payload) => {
        openaiCalls.push({ op: "vs.create", payload });
        return { id: "vs_file_lazy" };
      },
      files: {
        createAndPoll: async (vectorStoreId, body) => {
          attachCount += 1;
          openaiCalls.push({ op: "vs.files.createAndPoll", vectorStoreId, body });
          return { id: `vsf_attach_${attachCount}`, file_id: body.file_id };
        },
      },
    },
    responses: {
      async create(payload) {
        openaiCalls.push({ op: "responses.create", payload });
        return { id: "r_lazy", output_text: "Lazy scoped" };
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

        if (q.includes("FROM docs_files") && q.includes("WHERE doc_id = $1 AND id = $2")) {
          assert.deepEqual(params, ["doc1", 12]);
          return {
            rows: [
              {
                id: 12,
                doc_id: "doc1",
                kind: "tab",
                filename: "tab_Overview.txt",
                sha256: "tabhash",
                vector_store_file_id: "vsf_doc_root",
                file_vector_store_id: null,
                file_vector_store_file_id: null,
                vector_store_file_file_id: "file_chunk_1",
                file_vector_store_file_file_id: null,
                source_parent_kind: null,
                source_parent_sha256: null,
              },
            ],
            rowCount: 1,
          };
        }

        if (q.includes("AND source_parent_kind = $3") && q.includes("AND source_parent_sha256 = $4")) {
          assert.deepEqual(params, ["doc1", "tab_chunk", "tab", "tabhash"]);
          return {
            rows: [
              { id: 101, filename: "chunk1.txt", vector_store_file_file_id: "file_chunk_1" },
              { id: 102, filename: "chunk2.txt", vector_store_file_file_id: "file_chunk_2" },
            ],
            rowCount: 2,
          };
        }

        if (q.includes("UPDATE docs_files") && q.includes("file_vector_store_id = $2")) {
          updates.push(params);
          return { rows: [], rowCount: 1 };
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
  assert.equal(res.body.reply, "Lazy scoped");
  assert.deepEqual(res.body.scope, { type: "file", fileId: 12 });
  assert.ok(openaiCalls.find((c) => c.op === "vs.create"));
  assert.equal(openaiCalls.filter((c) => c.op === "vs.files.createAndPoll").length, 2);
  assert.deepEqual(
    openaiCalls.find((c) => c.op === "responses.create").payload.tools[0].vector_store_ids,
    ["vs_file_lazy"]
  );
  assert.equal(updates.length, 3);
});

test("POST /v2/chat with multiple fileIds searches across selected scopes", async () => {
  const openaiCalls = [];
  const openaiClient = {
    responses: {
      async create(payload) {
        openaiCalls.push(payload);
        return { id: "r_multi", output_text: "Multi scoped" };
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
        if (q.includes("FROM docs_files") && q.includes("WHERE doc_id = $1 AND id = $2")) {
          if (params[1] === 12) {
            return {
              rows: [
                {
                  id: 12,
                  doc_id: "doc1",
                  kind: "upload",
                  filename: "budget.csv",
                  sha256: "h12",
                  vector_store_file_id: "vsf_doc_12",
                  file_vector_store_id: "vs_file_12",
                  file_vector_store_file_id: "vsf_file_12",
                  vector_store_file_file_id: "file_upload_12",
                  file_vector_store_file_file_id: "file_upload_12",
                  source_parent_kind: null,
                  source_parent_sha256: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (params[1] === 13) {
            return {
              rows: [
                {
                  id: 13,
                  doc_id: "doc1",
                  kind: "tab",
                  filename: "tab_Overview.txt",
                  sha256: "h13",
                  vector_store_file_id: "vsf_doc_13",
                  file_vector_store_id: "vs_file_13",
                  file_vector_store_file_id: "vsf_file_13",
                  vector_store_file_file_id: "file_tab_13",
                  file_vector_store_file_file_id: "file_tab_13",
                  source_parent_kind: null,
                  source_parent_sha256: null,
                },
              ],
              rowCount: 1,
            };
          }
        }
        return null;
      },
    }),
    openaiClient,
    config: { bodyLimit: "10kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app)
    .post("/v2/chat")
    .send({ docId: "doc1", userMessage: "Create an Excel summary from these selected files.", fileIds: [12, 13] });

  assert.equal(res.status, 200);
  assert.equal(res.body.reply, "Multi scoped");
  assert.deepEqual(res.body.scope, { type: "file", fileIds: [12, 13] });
  assert.equal(openaiCalls.length, 1);
  assert.deepEqual(openaiCalls[0].tools[0].vector_store_ids, ["vs_file_12", "vs_file_13"]);
  assert.deepEqual(openaiCalls[0].tools[1].container.file_ids, ["file_upload_12"]);
});

test("POST /v2/chats/:chatId/send with multiple fileIds searches selected scopes", async () => {
  const openaiCalls = [];
  const openaiClient = {
    responses: {
      async create(payload) {
        openaiCalls.push(payload);
        return { id: "r_chat_multi", output_text: "Thread multi scoped" };
      },
    },
  };

  const { app } = createApp({
    pool: makePoolMock({
      queryHandler: async (sql, params) => {
        const q = String(sql);
        if (q.includes("FROM chats") && q.includes("WHERE id = $1 AND user_id = $2")) {
          return {
            rows: [
              {
                id: "chat1",
                user_id: "user1",
                title: "New chat",
                openai_conversation_id: "conv1",
                archived_at: null,
                created_at: "2025-01-01T00:00:00.000Z",
                updated_at: "2025-01-01T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }
        if (q.includes("SELECT doc_id, conversation_id")) {
          return {
            rows: [
              {
                doc_id: "doc1",
                conversation_id: "c1",
                vector_store_id: "vs_doc",
                instructions: "",
                model: "test-model",
              },
            ],
            rowCount: 1,
          };
        }
        if (q.includes("INSERT INTO chat_messages") || q.includes("UPDATE chats SET updated_at = NOW()") || q.includes("UPDATE chats SET title = $2")) {
          return { rows: [], rowCount: 1 };
        }
        if (q.includes("FROM docs_files") && q.includes("WHERE doc_id = $1 AND id = $2")) {
          if (params[1] === 12) {
            return {
              rows: [
                {
                  id: 12,
                  doc_id: "doc1",
                  kind: "upload",
                  filename: "budget.csv",
                  sha256: "h12",
                  vector_store_file_id: "vsf_doc_12",
                  file_vector_store_id: "vs_file_12",
                  file_vector_store_file_id: "vsf_file_12",
                  vector_store_file_file_id: "file_upload_12",
                  file_vector_store_file_file_id: "file_upload_12",
                  source_parent_kind: null,
                  source_parent_sha256: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (params[1] === 13) {
            return {
              rows: [
                {
                  id: 13,
                  doc_id: "doc1",
                  kind: "tab",
                  filename: "tab_Overview.txt",
                  sha256: "h13",
                  vector_store_file_id: "vsf_doc_13",
                  file_vector_store_id: "vs_file_13",
                  file_vector_store_file_id: "vsf_file_13",
                  vector_store_file_file_id: "file_tab_13",
                  file_vector_store_file_file_id: "file_tab_13",
                  source_parent_kind: null,
                  source_parent_sha256: null,
                },
              ],
              rowCount: 1,
            };
          }
        }
        return null;
      },
    }),
    openaiClient,
    config: { bodyLimit: "10kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app)
    .post("/v2/chats/chat1/send")
    .send({ userId: "user1", docId: "doc1", userMessage: "Create an Excel summary from these selected files.", fileIds: [12, 13] });

  assert.equal(res.status, 200);
  assert.equal(res.body.reply, "Thread multi scoped");
  assert.equal(openaiCalls.length, 1);
  assert.deepEqual(openaiCalls[0].tools[0].vector_store_ids, ["vs_file_12", "vs_file_13"]);
  assert.deepEqual(openaiCalls[0].tools[1].container.file_ids, ["file_upload_12"]);
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
    chatHistory: 0,
    docsFiles: 2,
    docsSessions: 1,
  });
  assert.ok(res.headers["x-request-id"]);
  assert.ok(calls.length >= 2);
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
  let attachCalls = 0;
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
          return { id: uploadCalls === 1 ? "new_file" : "new_file_scoped", file_id: `file_${uploadCalls}` };
        },
        createAndPoll: async (vectorStoreId, body) => {
          attachCalls += 1;
          openaiCalls.push({ op: "vs.files.createAndPoll", vectorStoreId, body });
          return { id: `attached_${attachCalls}`, file_id: body.file_id };
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
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.createAndPoll" && c.body.file_id === "file_1"));
  assert.ok(openaiCalls.find((c) => c.op === "vs.create"));
});

test("POST /v2/sync-doc bounds concurrent chunk uploads", async () => {
  let uploadCalls = 0;
  let activeUploads = 0;
  let maxActiveUploads = 0;
  let docsFileIdSeq = 1;
  const storedDocsFiles = new Map();

  const openaiClient = {
    vectorStores: {
      files: {
        uploadAndPoll: async () => {
          uploadCalls += 1;
          activeUploads += 1;
          maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
          await new Promise((resolve) => setTimeout(resolve, 15));
          activeUploads -= 1;
          return { id: `vsf_${uploadCalls}`, file_id: `file_${uploadCalls}` };
        },
      },
    },
  };

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

      if (q.includes("FROM docs_files") && q.includes("WHERE doc_id = $1 AND kind = $2 AND sha256 = $3")) {
        const key = `${params[1]}::${params[2]}`;
        const row = storedDocsFiles.get(key);
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      if (q.includes("INSERT INTO docs_files")) {
        const row = {
          id: docsFileIdSeq,
          filename: params[2],
          sha256: params[3],
          vector_store_file_id: params[4],
          file_vector_store_id: params[5],
          file_vector_store_file_id: params[6],
          vector_store_file_file_id: params[7],
          file_vector_store_file_file_id: params[8],
        };
        docsFileIdSeq += 1;
        storedDocsFiles.set(`${params[1]}::${params[3]}`, row);
        return { rows: [], rowCount: 1 };
      }

      return null;
    },
  });

  const { app } = createApp({
    pool,
    openaiClient,
    config: {
      bodyLimit: "200kb",
      token: "",
      openaiModel: "test-model",
      summaryEnabled: false,
      chunkMaxTokens: 101,
      chunkOverlapTokens: 0,
      chunkUploadConcurrency: 2,
    },
  });

  const res = await request(app)
    .post("/v2/sync-doc")
    .send({
      docId: "doc1",
      docTitle: "Big Doc",
      docText: `# Heading\n\n${"A".repeat(2600)}`,
      replaceKnowledge: false,
      fileScope: false,
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.reused, false);
  assert.ok(uploadCalls > 2);
  assert.ok(maxActiveUploads > 1);
  assert.ok(maxActiveUploads <= 2);
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
  let attachCalls = 0;

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
          return { id: uploadCalls === 1 ? "vsf_doc" : "vsf_tab", file_id: `file_${uploadCalls}` };
        },
        createAndPoll: async (vectorStoreId, body) => {
          attachCalls += 1;
          openaiCalls.push({ op: "vs.files.createAndPoll", vectorStoreId, body });
          return { id: attachCalls === 1 ? "vsf_tab" : `vsf_tab_${attachCalls}`, file_id: body.file_id };
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

  const jobId = res.body && res.body.jobId ? String(res.body.jobId) : "";
  assert.ok(jobId);

  // Poll job result (sync-tab runs async server-side).
  let job = null;
  for (let i = 0; i < 50; i += 1) {
    const jr = await request(app).get(`/v2/jobs/${jobId}`);
    assert.equal(jr.status, 200);
    if (jr.body.status === "succeeded") {
      job = jr.body;
      break;
    }
    if (jr.body.status === "failed") {
      assert.fail(String(jr.body.error || "Job failed"));
    }
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.ok(job && job.result);
  assert.equal(job.result.reused, false);
  assert.equal(job.result.vectorStoreFileId, "vsf_doc");
  assert.equal(job.result.docsFileId, 99);
  assert.equal(job.result.fileVectorStoreId, "vs_file_1");

  assert.ok(openaiCalls.find((c) => c.op === "vs.create"));
  assert.equal(openaiCalls.filter((c) => c.op === "vs.files.uploadAndPoll").length, 1);
  assert.equal(openaiCalls.filter((c) => c.op === "vs.files.createAndPoll").length, 1);

  // Ensure we inserted a tab entry (and chunk entries may exist)
  assert.ok(inserts.length >= 1);
  assert.ok(inserts.find((i) => i.params[1] === "tab"));
});

test("POST /v2/sync-tab upgrades stale tab entries to selectable file-scope items", async () => {
  const openaiCalls = [];
  let upgradedTab = {
    id: 99,
    kind: "tab",
    filename: "tab_Overview_tab_123_doc1.txt",
    sha256: "tabhash",
    created_at: "2025-01-01T00:00:00.000Z",
    vector_store_file_id: "vsf_doc_existing",
    file_vector_store_id: null,
    vector_store_file_file_id: "file_doc_existing",
    file_vector_store_file_id: null,
    file_vector_store_file_file_id: null,
  };

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

      if (q.includes("FROM docs_files") && q.includes("WHERE doc_id = $1 AND kind = $2 AND sha256 = $3")) {
        const kind = params[1];
        if (kind === "tab") return { rows: [upgradedTab], rowCount: 1 };
        if (kind === "tab_chunk") {
          return {
            rows: [
              {
                id: 101,
                vector_store_file_id: "vsf_chunk_existing",
                vector_store_file_file_id: "file_chunk_existing",
              },
            ],
            rowCount: 1,
          };
        }
      }

      if (q.includes("INSERT INTO docs_files")) {
        upgradedTab = {
          ...upgradedTab,
          filename: params[2],
          sha256: params[3],
          vector_store_file_id: params[4],
          file_vector_store_id: params[5],
          file_vector_store_file_id: params[6],
          vector_store_file_file_id: params[7],
          file_vector_store_file_file_id: params[8],
        };
        return { rows: [], rowCount: 1 };
      }

      if (q.includes("SELECT") && q.includes("FROM docs_files") && q.includes("kind NOT IN ('doc_chunk', 'tab_chunk', 'upload_chunk')")) {
        return {
          rows: [
            {
              id: upgradedTab.id,
              kind: upgradedTab.kind,
              filename: upgradedTab.filename,
              sha256: upgradedTab.sha256,
              created_at: upgradedTab.created_at,
              file_vector_store_id: upgradedTab.file_vector_store_id,
            },
          ],
          rowCount: 1,
        };
      }

      return null;
    },
  });

  const openaiClient = {
    vectorStores: {
      create: async () => {
        openaiCalls.push({ op: "vs.create", id: "vs_file_1" });
        return { id: "vs_file_1" };
      },
      files: {
        createAndPoll: async (vectorStoreId, body) => {
          openaiCalls.push({ op: "vs.files.createAndPoll", vectorStoreId, body });
          return { id: "vsf_file_scope_1", file_id: body.file_id };
        },
      },
    },
  };

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
    fileScope: true,
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.jobId);

  let job = null;
  for (let i = 0; i < 50; i += 1) {
    const jr = await request(app).get(`/v2/jobs/${res.body.jobId}`);
    assert.equal(jr.status, 200);
    if (jr.body.status === "succeeded") {
      job = jr.body;
      break;
    }
    if (jr.body.status === "failed") {
      assert.fail(String(jr.body.error || "Job failed"));
    }
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.ok(job && job.result);
  assert.equal(job.result.reused, false);
  assert.equal(job.result.vectorStoreFileId, "vsf_doc_existing");
  assert.equal(job.result.fileVectorStoreId, "vs_file_1");
  assert.equal(openaiCalls.filter((c) => c.op === "vs.create").length, 1);
  assert.equal(openaiCalls.filter((c) => c.op === "vs.files.createAndPoll").length, 1);
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.createAndPoll" && c.body.file_id === "file_chunk_existing"));

  const filesRes = await request(app).get("/v2/list-files").query({ docId: "doc1" });
  assert.equal(filesRes.status, 200);
  assert.equal(filesRes.body.files[0].hasFileScope, true);
});

test("POST /v2/sync-tab refreshes picker label when a tab is renamed", async () => {
  let storedTab = {
    id: 77,
    kind: "tab",
    filename: "tab_Old_Title_tab_123_doc1.txt",
    sha256: "tabhash",
    created_at: "2025-01-01T00:00:00.000Z",
    vector_store_file_id: "vsf_doc_existing",
    file_vector_store_id: "vs_file_existing",
    file_vector_store_file_id: "vsf_file_existing",
    vector_store_file_file_id: "file_doc_existing",
    file_vector_store_file_file_id: "file_scope_existing",
  };

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

      if (q.includes("WHERE doc_id = $1 AND kind = $2 AND sha256 = $3")) {
        return { rows: [storedTab], rowCount: 1 };
      }

      if (q.includes("INSERT INTO docs_files")) {
        storedTab = {
          ...storedTab,
          filename: params[2],
          sha256: params[3],
          vector_store_file_id: params[4],
          file_vector_store_id: params[5],
          file_vector_store_file_id: params[6],
          vector_store_file_file_id: params[7],
          file_vector_store_file_file_id: params[8],
        };
        return { rows: [], rowCount: 1 };
      }

      if (q.includes("kind NOT IN ('doc_chunk', 'tab_chunk', 'upload_chunk')")) {
        return {
          rows: [
            {
              id: storedTab.id,
              kind: storedTab.kind,
              filename: storedTab.filename,
              sha256: storedTab.sha256,
              created_at: storedTab.created_at,
              file_vector_store_id: storedTab.file_vector_store_id,
            },
          ],
          rowCount: 1,
        };
      }

      return null;
    },
  });

  const { app } = createApp({
    pool,
    openaiClient: { vectorStores: { create: async () => { throw new Error("Should not upload"); } } },
    config: { bodyLimit: "50kb", token: "", openaiModel: "test-model" },
  });

  const res = await request(app).post("/v2/sync-tab").send({
    docId: "doc1",
    tabId: "tab_123",
    tabTitle: "New Title",
    tabText: "Hello tab",
    replaceKnowledge: false,
    fileScope: true,
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.jobId);

  let job = null;
  for (let i = 0; i < 50; i += 1) {
    const jr = await request(app).get(`/v2/jobs/${res.body.jobId}`);
    assert.equal(jr.status, 200);
    if (jr.body.status === "succeeded") {
      job = jr.body;
      break;
    }
    if (jr.body.status === "failed") {
      assert.fail(String(jr.body.error || "Job failed"));
    }
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.ok(job && job.result);
  assert.equal(job.result.reused, true);
  assert.equal(storedTab.filename, "tab_New_Title_tab_123_doc1.txt");

  const filesRes = await request(app).get("/v2/list-files").query({ docId: "doc1" });
  assert.equal(filesRes.status, 200);
  assert.equal(filesRes.body.files[0].filename, "tab_New_Title_tab_123_doc1.txt");
  assert.equal(filesRes.body.files[0].hasFileScope, true);
});

test("POST /v2/upload-file replaceKnowledge=true deletes old files before upload", async () => {
  const openaiCalls = [];
  let createdVs = 0;
  let uploadCalls = 0;
  let attachCalls = 0;
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
          return { id: uploadCalls === 1 ? "new_upload" : "new_upload_scoped", file_id: `file_${uploadCalls}` };
        },
        createAndPoll: async (vectorStoreId, body) => {
          attachCalls += 1;
          openaiCalls.push({ op: "vs.files.createAndPoll", vectorStoreId, body });
          return { id: `attached_upload_${attachCalls}`, file_id: body.file_id };
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
  assert.ok(openaiCalls.find((c) => c.op === "vs.files.createAndPoll" && c.body.file_id === "file_1"));
  assert.ok(openaiCalls.find((c) => c.op === "vs.create"));
});
