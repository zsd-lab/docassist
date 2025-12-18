import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../app.js";

function makePoolMock({ sessionRow } = {}) {
  return {
    async query(sql, params) {
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
