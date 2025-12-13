// server.js
import "dotenv/config";
import express from "express";
import OpenAI, { toFile } from "openai";
import pkg from "pg";
import crypto from "crypto";

const { Pool } = pkg;

console.log("Starting doc-assist server...");

const app = express();
const BODY_LIMIT = process.env.DOCASSIST_BODY_LIMIT || "25mb";
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// ====== AUTH (optional) ======
// If DOCASSIST_TOKEN is set, require: Authorization: Bearer <token>
const DOCASSIST_TOKEN = process.env.DOCASSIST_TOKEN || "";
app.use((req, res, next) => {
  if (!DOCASSIST_TOKEN) return next();
  if (req.method === "GET" && req.path === "/") return next();

  const auth = String(req.headers.authorization || "");
  const expected = `Bearer ${DOCASSIST_TOKEN}`;
  if (auth !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
});

// ====== POSTGRES POOL ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// ====== KONFIG ======
const MAX_TURNS_PER_DOC = 25;        // max ennyi user+assistant turn/doksi
const MAX_DOC_CHARS = 50000;         // doksi szöveg max hossza (chathez)

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2-2025-12-11";

const SYSTEM_PROMPT = `
SYSTEM PROMPT (kiegészített): “Agilis Coach Power & Impact – Erste (Daily Banking + Enterprise Influence)”
Te egy szervezetfejlesztési (OD) szakértő, IT/agilis transzformációs tanácsadó, business coach és executive-asszisztens szerepben működő AI ügynök vagy. A felhasználód Zsigó Dávid (Agile Coach, Erste Bank Magyarország, Agile Center of Excellence; Daily Banking Tribe dedikált coach).
1) Küldetés
A feladatod, hogy Dávid befolyását és formális hatalmát a lehető legrövidebb időn belül  az alábbi csatornákon:
* Daily Banking Tribe üzleti és delivery eredmények gyorsítása,
* felsővezetői bizalom és láthatóság tudatos építése,
* többi tribe vezetővel való kapcsolatépítés és cross-tribe hatás növelése,
* a szervezet egyéb vezetőinek megnyerése (funkcionális területek, kontroll- és kockázati vonalak, IT/üzemeltetés, stb.),
* stakeholder-ek közti feszültségek kezelése úgy, hogy Dávid kulcsszereplővé váljon,
* egyértelmű működési megállapodások (role clarity, decision rights) kialakítása a transzformációban.
2) Etikai és működési korlátok (nem alkuképes)
* A “megnyerés” nálad értékteremtés + integritás + kiszámíthatóság és szövetség kötés
* Minden javaslatnak reputáció- és compliance-szempontból is védhetőnek kell lennie.
3) Kontextus és szereplők (forrás: projekt-információk)
Dávid
* Erste Bank HU, Agile Center of Excellence tag.
* Daily Banking Tribe agilis coach-ja; a tribe ~2 éve agilisodik.
Közvetlen vezető: Hérics Nándi
* Operatív agilis transzformációért felel; 5 Agile Coach tartozik hozzá (Attila, Kati, Gergő, Péter és Dávid)
* Cél: felsővezetői elégedettség – egyszerre “látható kontroll” és minimális zavarás.
Tribe vezető: Beck Balla Laci
* Befolyásos középvezető
* Cél: Daily Banking üzleti célok maximalizálása, “legjobb tribe” státusz.
* Igény Dávid felé: “tribe-first”, erős fókusz a squadokra és SM minőségre (SM-ek, Ádám) 
Daily Banking Tribe – squad vezetők és fókuszok
* Gémes Zita – Elsődleges Banki Kapcsolatok
* Hanák Bálint – Onboarding & ügyfélkapcsolat
* Sóti András – Fizetésforgalom
* Czikora Emese – Bankkártya üzleti
* Bese Bálint – Mindennapi biztosítások
* Artemis Foulidou – Perszonalizált lakossági ügyfélkezelés
* Horváth Ádám – Fiókhálózati digitalizáció
* Lőrincz Sándor – Tribe technológiai vezetői központ
* Antal Alex – Fejlesztői és tesztaut. szakértői központ
* Sáfrányos Attila – George platform support szakértői központ
Kiterjesztett környezet
* Többi tribe vezető (Dávid CoE-s “peer customer” köre): erőforrás-verseny, összehasonlítási nyomás, eltérő üzleti fókuszok.
* Szervezet egyéb vezetői: funkcionális és kontroll-területek (pl. IT governance, üzemeltetés, kockázat/compliance, pénzügy, HR), akik gyakran függőségeket és korlátokat jelentenek a tribe-ok számára.
4) Stratégiai célmodell (minden javaslat ezekhez igazodik)
1. Delivery és üzleti outcome (Daily Bankingben, majd cross-tribe skálán).
2. Bizalom és kiszámíthatóság (meglepetésmentes működés).
3. Mandátum és döntési jogkör (scope, governance, módszertani irány).
4. Enterprise kapcsolati tőke (tribe vezetők + funkcionális vezetők).
5) Enterprise kapcsolatépítési rendszer (kötelező komponens)
A feladatod nem csak a Daily Banking “belső” sikere, hanem Dávid szervezeti szintű koalíciójának felépítése.
5.1. “Tribe Leader Alliance” cél
Dávid legyen:
* a tribe vezetők szemében üzletet gyorsító és függőségeket oldó partner,
* Nándi és a CoE szemében skálázható, összehasonlítható működés letéteményese,
* a felsővezetés szemében alacsony kockázatú, nagy hatású transzformációs ember.
5.2. Kapcsolati portfólió (kiket kell “megnyerni”)
Te mindig kezeld Dávid stakeholder-listáját három kosárban, és javasolj heti/havi célokat:
* A: Power sponsors (döntéshozók, előléptetést / mandátumot adók)
* B: Business champions (tribe vezetők, domain vezetők, akik eredményesség alapján legitimálnak)
* C: System gatekeepers (funkcionális/kontroll vezetők: risk/compliance/ops/IT governance, akik blokkolni vagy feloldani tudnak)
5.3. Standard “value offer” üzenetek (mindig business-nyelven)
Minden kapcsolatépítés alapja az egyértelmű ajánlat:
* Tribe vezetőknek: “predictability + throughput + dependency removal”
* Gatekeepereknek: “kontroll élmény úgy, hogy nem fojtja meg a deliveryt”
* Felsővezetésnek: “látható eredmény kevés drámával”
5.4. Kapcsolatépítési ritmus (operációs minimum)
Te automatikusan így tervezel:
* Heti egy-két rövid (huszonöt perces) “value check-in” kulcsszereplőkkel,
* Havi 1 cross-tribe “blocking issues review” (Dávid moderál, nem birtokol),
* Negyedéves 1 “Executive-ready impact review” (1 oldal / 3 slide, outcome-központú).
6) Cross-tribe hatásmechanizmusok (amit tőled elvárunk)
A javaslataid tartalmazzanak olyan eszközöket, amik Dávidat enterprise-szinten láthatóvá teszik:
1. Dependency & Flow leadership
* Dávid állítson fel egy könnyű, nem bürokratikus “dependency management” keretet (vizuális, döntésorientált).
* Cél: ő legyen az, aki átlátja és oldja a squadok és lehetőleg a tribe-ok közti elakadásokat.
1. Pattern library (ismétlődő problémák katalógusa)
* Azonosítsd a visszatérő szervezeti akadályokat (pl. release governance, risk review, ops handover, vendor/procurement).
* Adj “standard kezelési mintákat” (nem szabályzat-gyártás, hanem döntési sablonok).
1. Executive translation
* Dávid minden kezdeményezést “vezetői nyelvre” fordít: outcome, kockázat, döntéskérés, mérőszám.
* Cél: Dávid legyen a “transzformáció tolmácsa” a tribe-ok és a vezetés között.
1. Coalition building through service
* Dávid ne “kérjen” szívességet, hanem előbb adjon: elemzés, döntési előkészítés, facilitálás, gyorsítás.
* Ezzel épül a reputáció és a későbbi mandátum.
7) Konfliktus- és mandátumkezelés (Nándi és Laci és enterprise)
* A Nándi és Laci kettős elvárásait úgy oldod, hogy Dávid híd legyen, ne “oldalválasztó”.
* Minden javaslatod végén legyen egy “mandátum-növelő lépés”:
    * mi az a kicsi, formális vagy félig-formális megállapodás, ami Dávid döntési terét növeli (pl. RACI, Operating Agreement, havi governance slot vezetése, cross-tribe fórum moderálása).
8) Konkrét outputok (default)
Ha Dávid helyzetet ad vagy kérdez, te alapból adsz:
* Stakeholder térkép (A/B/C kosarakkal) + következő 2 hét kapcsolati akcióterv
* Tribe leader meeting prep (cél, agenda, 3 üzenet, döntéskérés, kockázat)
* Gatekeeper-megnyerési terv (mi fáj nekik, mitől félnek, mi az “igen” ára)
* 1 oldalas executive update vázlat (outcome, metrikák, blokkok, döntéskérés)
A cél: Dávid ne csak a Daily Bankingben legyen erős, hanem enterprise-szinten is “keresett” és megkerülhetetlen szereplővé váljon, mért eredményekkel és stabil kapcsolati tőkével, etikus keretek között.
`.trim();

// Health check / info
app.get("/", (req, res) => {
  res.send("Docs agent backend is running");
});

// Init OpenAI client with API key from env
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ====== DB BOOTSTRAP (keep old chat_history + add v2 session tables) ======
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function buildInstructions(customInstructions) {
  const custom = String(customInstructions || "").trim();
  if (!custom) return SYSTEM_PROMPT;

  return `${SYSTEM_PROMPT}\n\n---\nProject instructions (user-provided):\n${custom}`.trim();
}

async function getOrCreateSession(docId, maybeInstructions) {
  const existing = await pool.query(
    `SELECT doc_id, conversation_id, vector_store_id, instructions, model FROM docs_sessions WHERE doc_id = $1`,
    [docId]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const incoming = typeof maybeInstructions === "string" ? maybeInstructions : "";

    if (incoming && incoming.trim() !== String(row.instructions || "").trim()) {
      await pool.query(
        `UPDATE docs_sessions SET instructions = $2, updated_at = NOW() WHERE doc_id = $1`,
        [docId, incoming]
      );
      row.instructions = incoming;
    }

    // Keep stored session model aligned with current env config.
    if (!row.model || row.model !== OPENAI_MODEL) {
      await pool.query(
        `UPDATE docs_sessions SET model = $2, updated_at = NOW() WHERE doc_id = $1`,
        [docId, OPENAI_MODEL]
      );
      row.model = OPENAI_MODEL;
    }
    return row;
  }

  const conv = await client.conversations.create({
    metadata: { doc_id: docId },
  });

  const vectorStore = await client.vectorStores.create({
    name: `docassist-${docId}`,
    metadata: { doc_id: docId },
  });

  const instructions = typeof maybeInstructions === "string" ? maybeInstructions : "";

  await pool.query(
    `
      INSERT INTO docs_sessions (doc_id, conversation_id, vector_store_id, instructions, model)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [docId, conv.id, vectorStore.id, instructions, OPENAI_MODEL]
  );

  return {
    doc_id: docId,
    conversation_id: conv.id,
    vector_store_id: vectorStore.id,
    instructions,
    model: OPENAI_MODEL,
  };
}

async function recordVectorStoreFile(docId, kind, filename, sha256, vectorStoreFileId) {
  await pool.query(
    `
      INSERT INTO docs_files (doc_id, kind, filename, sha256, vector_store_file_id)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [docId, kind, filename, sha256, vectorStoreFileId]
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
  return result.rows[0]?.vector_store_file_id || null;
}

// ====== DB-ALAPÚ CHAT HISTORY STORE ======

/**
 * Adott docId-hez tartozó history lekérése időrendben.
 * Visszatérés: [{ role, content }, ...]
 */
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

/**
 * Új üzenet beszúrása a history-ba, és a régiek levágása, ha túl sok.
 */
async function appendToHistory(docId, role, content) {
  // Beszúrjuk az új sort
  await pool.query(
    `
    INSERT INTO chat_history (doc_id, role, content)
    VALUES ($1, $2, $3)
    `,
    [docId, role, content]
  );

  const maxMessages = MAX_TURNS_PER_DOC * 2; // user+assistant per turn

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

    // Legrégebbi extra sorok törlése
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

// ====== ONE-SHOT FUNKCIÓ: runDocsAgent ======

/**
 * ONE-SHOT: kiválasztott szöveg + instruction feldolgozása (Process Selected Text).
 */
async function runDocsAgent(text, instruction) {
  const model = OPENAI_MODEL;

  const response = await client.chat.completions.create({
    model,
    reasoning_effort: "high",
    max_completion_tokens: 1200,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: `Context:\n${text}\n\nInstruction:\n${instruction}`,
      },
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

// ====== CHAT FUNKCIÓ: runChatWithDoc ======

/**
 * CHAT: teljes doksi + konverzáció history alapján válaszol.
 *
 * - docId: Google Docs dokumentum ID
 * - docText: teljes dokumentumszöveg
 * - userMessage: aktuális user kérdés/utasítás
 */
async function runChatWithDoc(docId, docText, userMessage) {
  const model = OPENAI_MODEL;

  // Doksi vágása, hogy ne zabálja fel az egész kontextust
  const clippedDocText =
    docText.length > MAX_DOC_CHARS
      ? docText.slice(0, MAX_DOC_CHARS)
      : docText;

  // 1) Korábbi history lekérése DB-ből
  const history = await getHistoryForDoc(docId);

  // 2) Messages összeállítása
  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "system",
      content: `Here is the current document content (possibly truncated):\n\n${clippedDocText}`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  // 3) Modell hívása
  const response = await client.chat.completions.create({
    model,
    reasoning_effort: "high",
    max_completion_tokens: 1200,
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

  // 4) History frissítése a DB-ben
  await appendToHistory(docId, "user", userMessage);
  await appendToHistory(docId, "assistant", reply);

  return reply;
}

// ====== ENDPOINTOK ======

/**
 * POST /docs-agent
 * body: { text: string, instruction: string }
 * reply: { resultText: string }
 */
app.post("/docs-agent", async (req, res) => {
  try {
    const { text, instruction } = req.body;

    if (!text || !instruction) {
      return res.status(400).json({
        error: "Missing 'text' or 'instruction' in body.",
      });
    }

    const resultText = await runDocsAgent(text, instruction);
    res.json({ resultText });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
});

/**
 * POST /chat-docs
 * body: {
 *   docId: string,
 *   docText: string,
 *   userMessage: string
 * }
 * reply: { reply: string }
 */
app.post("/chat-docs", async (req, res) => {
  try {
    const { docId, docText, userMessage } = req.body;

    if (!docId || !docText || !userMessage) {
      return res.status(400).json({
        error: "Missing 'docId', 'docText' or 'userMessage' in body.",
      });
    }

    const answer = await runChatWithDoc(docId, docText, userMessage);
    res.json({ reply: answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
});

// ====== V2 (ChatGPT-like): Responses + Conversations + Vector Store ======

/**
 * POST /v2/init
 * body: { docId: string, instructions?: string }
 * reply: { docId, conversationId, vectorStoreId, model }
 */
app.post("/v2/init", async (req, res) => {
  try {
    const { docId, instructions } = req.body || {};
    if (!docId) {
      return res.status(400).json({ error: "Missing 'docId'" });
    }

    const session = await getOrCreateSession(String(docId), typeof instructions === "string" ? instructions : "");
    return res.json({
      docId: session.doc_id,
      conversationId: session.conversation_id,
      vectorStoreId: session.vector_store_id,
      model: session.model || OPENAI_MODEL,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

/**
 * POST /v2/sync-doc
 * body: { docId: string, docTitle?: string, docText: string, instructions?: string }
 * reply: { vectorStoreFileId: string, reused: boolean }
 */
app.post("/v2/sync-doc", async (req, res) => {
  try {
    const { docId, docTitle, docText, instructions } = req.body || {};
    if (!docId || typeof docText !== "string") {
      return res.status(400).json({ error: "Missing 'docId' or 'docText'" });
    }

    const session = await getOrCreateSession(String(docId), typeof instructions === "string" ? instructions : "");

    const title = String(docTitle || "document").replace(/[^a-zA-Z0-9._-]+/g, "_");
    const filename = `${title || "document"}_${String(docId).slice(0, 8)}.txt`;
    const buf = Buffer.from(docText, "utf8");
    const hash = sha256Hex(buf);

    const existingVsf = await findExistingVectorStoreFile(String(docId), "doc", hash);
    if (existingVsf) {
      return res.json({ vectorStoreFileId: existingVsf, reused: true });
    }

    const uploadable = await toFile(buf, filename, { type: "text/plain" });
    const vsFile = await client.vectorStores.files.uploadAndPoll(session.vector_store_id, uploadable);

    await recordVectorStoreFile(String(docId), "doc", filename, hash, vsFile.id);
    return res.json({ vectorStoreFileId: vsFile.id, reused: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

/**
 * POST /v2/upload-file
 * body: { docId: string, filename: string, mimeType?: string, contentBase64: string, instructions?: string }
 * reply: { vectorStoreFileId: string, reused: boolean }
 */
app.post("/v2/upload-file", async (req, res) => {
  try {
    const { docId, filename, mimeType, contentBase64, instructions } = req.body || {};
    if (!docId || !filename || !contentBase64) {
      return res.status(400).json({ error: "Missing 'docId', 'filename', or 'contentBase64'" });
    }

    const session = await getOrCreateSession(String(docId), typeof instructions === "string" ? instructions : "");

    const buf = Buffer.from(String(contentBase64), "base64");
    const hash = sha256Hex(buf);
    const safeName = String(filename).replace(/[^a-zA-Z0-9._-]+/g, "_");

    const existingVsf = await findExistingVectorStoreFile(String(docId), "upload", hash);
    if (existingVsf) {
      return res.json({ vectorStoreFileId: existingVsf, reused: true });
    }

    const uploadable = await toFile(buf, safeName, { type: String(mimeType || "application/octet-stream") });
    const vsFile = await client.vectorStores.files.uploadAndPoll(session.vector_store_id, uploadable);
    await recordVectorStoreFile(String(docId), "upload", safeName, hash, vsFile.id);

    return res.json({ vectorStoreFileId: vsFile.id, reused: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

/**
 * POST /v2/chat
 * body: { docId: string, userMessage: string, instructions?: string }
 * reply: { reply: string, responseId: string }
 */
app.post("/v2/chat", async (req, res) => {
  try {
    const { docId, userMessage, instructions } = req.body || {};
    if (!docId || !userMessage) {
      return res.status(400).json({ error: "Missing 'docId' or 'userMessage'" });
    }

    const session = await getOrCreateSession(String(docId), typeof instructions === "string" ? instructions : "");

    // If the user asks which model is being used, answer from backend config (authoritative).
    const msgStr = String(userMessage || "");
    const askedModel = /(\bmelyik\b|\bwhich\b).*(\bmodel\b|\bopenai\b)/i.test(msgStr);
    if (askedModel) {
      return res.json({
        reply: `A backend szerint ezzel a modellel hívlak: ${session.model || OPENAI_MODEL}`,
        responseId: "local-model-info",
      });
    }

    const response = await client.responses.create({
      model: session.model || OPENAI_MODEL,
      conversation: session.conversation_id,
      instructions: buildInstructions(session.instructions),
      tools: [
        {
          type: "file_search",
          vector_store_ids: [session.vector_store_id],
        },
      ],
      input: msgStr,
      max_output_tokens: 1200,
    });

    return res.json({
      reply: String(response.output_text || "").trim(),
      responseId: response.id,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ====== ERROR HANDLING ======
// Ensure oversized JSON bodies return JSON (Apps Script expects JSON).
app.use((err, req, res, next) => {
  const isTooLarge = err && (err.type === "entity.too.large" || err.status === 413);
  if (isTooLarge) {
    return res.status(413).json({
      error: `Payload Too Large. Increase DOCASSIST_BODY_LIMIT (current: ${BODY_LIMIT}).`,
    });
  }
  return next(err);
});

const PORT = process.env.PORT || 3000;
await ensureTables();

app.listen(PORT, () => {
  console.log(`Docs agent backend listening on port ${PORT}`);
  console.log(`OpenAI model: ${OPENAI_MODEL}`);
  if (DOCASSIST_TOKEN) console.log("Auth: enabled (DOCASSIST_TOKEN)");
  else console.log("Auth: disabled (set DOCASSIST_TOKEN to enable)");
});