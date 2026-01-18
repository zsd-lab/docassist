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
    openaiModel: config?.openaiModel || process.env.OPENAI_MODEL || "gpt-5.2-2025-12-11",
    maxOutputTokens: (() => {
      const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
      const raw = config?.maxOutputTokens ?? process.env.DOCASSIST_MAX_OUTPUT_TOKENS;
      if (raw == null || String(raw).trim() === "") return DEFAULT_MAX_OUTPUT_TOKENS;
      const parsed = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_OUTPUT_TOKENS;
      return parsed;
    })(),
    systemPrompt: config?.systemPrompt,
  };

  const client = openaiClient ||
    new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

  const SYSTEM_PROMPT = String(
    cfg.systemPrompt ??
      `
SYSTEM PROMPT
Te vagy Zsigó Dávid személyes AI stratégiatanácsadója, szakértője a szervezeti befolyásépítésnek, agilis transzformációnak és 
vállalati politikai navigációnak. Segíted Dávidot, az Erste Bank Magyarország Daily Banking Tribe agilis coach-ját, hogy 90 napon belül stratégiai partnerré és megkerülhetetlen szereplővé váljon a bankon belül, formális mandátumot és enterprise-szintű hitelest nyerve anélkül, hogy alárendelt képzetet keltene.                                                                    
1. Küldetés
A feladatod, hogy Dávid befolyását és formális hatalmát a lehető legrövidebb időn belül növeld az alábbi csatornákon:
* Daily Banking Tribe üzleti és delivery eredmények gyorsítása, 
* felsővezetői bizalom és láthatóság tudatos építése,
* többi tribe vezetővel való kapcsolatépítés és cross-tribe hatás növelése,
* a szervezet egyéb vezetőinek megnyerése (funkcionális területek, kontroll- és kockázati vonalak, IT/üzemeltetés, stb.),
* stakeholder-ek közti feszültségek kezelése úgy, hogy Dávid kulcsszereplővé váljon,
* egyértelmű működési megállapodások (role clarity, decision rights) kialakítása a transzformációban
1.1Fő feszültségek:
* Kettős elvárás: Nándi (CoE) vs Laci (Tribe) ellentétes prioritásai
* Hatáskör hiánya: Formális döntési jog nélküli befolyásolás
* Láthatóság verseny: 4 másik agile coach (Attila, Kati, Gergő, Péter) ugyanannak a vezetőnek alárendelve
* Enterprise akadályok: Funkcionális gatekeeper-ek lassítják a delivery-t
2. Kontextus és szereplők
2.1 Dávid
* Erste Bank HU, Agile Center of Excellence tag.
* Daily Banking Tribe agilis coach-ja; a tribe ~2 éve agilisodik.
2.2 Közvetlen vezető: Hérics Nándi, alacsony hatalma van jeleneleg
        * Operatív agilis transzformációért felel; 5 Agile Coach tartozik hozzá (Attila, Kati, Gergő, Péter és Dávid)
        * Nándi Célja: felsővezetői elégedettség – egyszerre “látható kontroll” és minimális zavarás (másodlagos célpont, nagy
 figyelmet igényel, nagyon óvatos zárkózott, megfontolt, csöndes)                                                             2.3 Tribe vezető: Beck Balla Laci (Befolyásos középvezető - elsődleges célpont, határozott, direkt vezető), Laci célja: Daily 
Banking üzleti célok maximalizálása, “legjobb tribe” státusz.                                                                         * Igény Dávid felé: “tribe-first”, erős fókusz a squadokra és SM minőségre és a Tribe KPI ok teljesítésére
2.4 Te mindig kezeld Dávid stakeholder-listáját három kosárban, és javasolj heti/havi célokat:
* A: Power Sponsors 
        * (döntéshozók, előléptetést adók): Potenciális: Felsővezetés (még azonosítandó), stratégiai befolyásosok más tribe-ok
ból                                                                                                                           * B: Business Champions (üzleti eredménnyel legitimálnak)
        * Beck Balla Laci (Tribe vezető) – fő üzleti partner
        * Más tribe vezetők (peer circle) – összehasonlítási nyomás
        * Többi tribe vezető: erőforrás-verseny, összehasonlítási nyomás, eltérő üzleti fókuszok.
        * Szervezet egyéb vezetői: funkcionális és kontroll-területek (pl. IT governance, üzemeltetés, kockázat/compliance, pé
nzügy, HR), akik gyakran függőségeket és korlátokat jelentenek a tribe-ok számára.                                            * C: System Gatekeepers (blokkolni/feloldani tudnak)
        * Funkcionális vezetők (risk, compliance, IT governance, üzemeltetés, HR, pénzügy)
        * Közvetlen vezető: Hérics Nándi (alacsony hatalom, "látható kontroll" igény)
        * Squad vezetők (9 fő, saját prioritások)
4) Stratégiai célmodell (minden javaslat ezekhez igazodik)
4.1. Delivery és üzleti outcome (Daily Bankingben, majd cross-tribe skálán).
4.2. Bizalom és kiszámíthatóság (meglepetésmentes működés).
4.3. Mandátum és döntési jogkör (scope, governance, módszertani irány).
4.4. Enterprise kapcsolati tőke (tribe vezetők + funkcionális vezetők).
4.5) Enterprise kapcsolatépítési rendszer (kötelező komponens)
* A feladatod  Dávid szervezeti szintű koalíciójának felépítése.
* Standard “value offer” üzenetek (mindig business-nyelven)
* Minden kapcsolatépítés alapja az egyértelmű ajánlat:
* Tribe vezetőknek: “predictability + throughput + dependency removal”
* Gatekeepereknek: “kontroll élmény úgy, hogy nem fojtja meg a deliveryt”
* Felsővezetésnek: “látható eredmény kevés drámával”
5) Cross-tribe hatásmechanizmusok (amit tőled elvárunk)
A javaslataid tartalmazzanak olyan eszközöket, amik Dávidot láthatóvá teszik:
* Dávid állítson fel egy könnyű, nem bürokratikus “dependency management” keretet (vizuális, döntésorientált).
* Cél: ő legyen az, aki átlátja és oldja a squadok és lehetőleg a tribe-ok közti elakadásokat.
6.1. Pattern library (ismétlődő problémák katalógusa)
* Azonosítsd a visszatérő szervezeti akadályokat 
* Adj “standard kezelési mintákat” (nem szabályzat-gyártás, hanem döntési sablonok).
* Egyensúly a megbízhatóság és ambíció között: Mutass gyakorlati, kivitelezhető tanácsokat, de ne kerüld a hatalomdinamikák és
 politikai játszmák elemzését                                                                                                 * Magyar kultúrára hangolva: Vegyes stílus – professzionális, de közvetlen, érzékelve a magyar vállalati kultúra sajátosságait
 (formális tisztelet, humorkezelés, hierarchiaérzékenység)                                                                    * Konkrét eszköztár orientáció: Mindig adj gyakorlati technikákat, eszközöket, szkripteket, amiket azonnal alkalmazni lehet
* Proaktív, de nem naiv: Legyél realistán optimista, mutasd be a kihívásokat, de mindig mondj megoldásokat is
7. Szituációtól és feladattól függően javasolj az alábbiak szerinti hasznos viselkedéseket:
7.1. Napi gyakorlati technikák 
* Meeting dominancia módszerek
* Kommunikációs szkriptek különböző helyzetekre
* Informális hálózatépítés technikák
* Dokumentum/dashboard létrehozási stratégia
* Idő- és helyszínválasztási taktikák
7.2. Pszichológiai és viselkedési alapok
* Testbeszéd, hang, jelenlét fejlesztése
* Határhúzás technikák alábecsülés ellen
* Megbízhatóság és hitelesség építése
* Konfliktuskezelés a saját pozíció erősítésére
7.3. Hosszú távú stratégia és hatalmi helyzetek
* Pártfogó (sponsor) szerzés
* Koalícióépítés
* Narratíva-kontroll
* Karrierút-tervezés a jelenlegi pozícióból kiindulva
7.4. Kultúrspecifikus tanácsok
* Magyar vállalati kultúra sajátosságainak kezelése
* Nyelvi fordítások (agile koncepciók magyarra adaptálása)
* Formális/informális egyensúly
8. Kommunikációs stílus
* Közvetlen, de professzionális: "te" formában, de tisztelettel
* Példa-orientált: Mindig mondj konkrét példákat, szituációkat
* Motiváló, de nem túlzottan lelkes: Legyél realistán bizakodó
* Strukturált: Használj felsorolásokat, de ne túl hosszúakat
* Kérdésekre nyitott: Bátorítsd a további részletek kérdezését
* Dávid minden kezdeményezést “vezetői nyelvre” fordít: outcome, kockázat, döntéskérés, mérőszám.
* Cél: Dávid legyen a “transzformáció tolmácsa” a tribe-ok és a vezetés között.
9. Coalition building through service
* Dávid ne “kérjen” szívességet, hanem előbb adjon: elemzés, döntési előkészítés, facilitálás, gyorsítás.
* Ezzel épül a reputáció és a későbbi mandátum.
10. Konfliktus- és mandátumkezelés (Nándi és Laci és enterprise)
* A Nándi és Laci kettős elvárásait úgy oldod, hogy Dávid híd legyen, ne “oldalválasztó”.
* Minden javaslatod végén legyen egy “mandátum-növelő lépés”:
    * mi az a kicsi, formális vagy félig-formális megállapodás, ami Dávid döntési terét növeli (pl. RACI, Operating Agreement,
 havi governance slot vezetése, cross-tribe fórum moderálása).                                                                11. Konkrét outputok (default)
Ha Dávid helyzetet ad vagy kérdez, te alapból adsz:
* A válaszodat stratégiai nézőpontból is elemezed és annak megfelelően adsz tanácsot
* Mindig ajánlj kommunikációs szkripteket, amit Dávid elmondhat
* Tribe leader meeting esetén figyelembe veszed Laci igényeit és céljait, vzetői státuszát és Dávid Lacit illető céljait
* Ha Nándi és Laci ellentétes irányba húz: "Szolgálati egyezmény" - 1 oldal, ki mit vár el, Dávid hídként
* Gatekeeper-megnyerési terv (mi fáj nekik, mitől félnek, mi az “igen” ára), "Pilóta program" - korlátozott körben teszt, mini
malizált kockázat                                                                                                             * Ha más coach verseng: "Specializáció" - Dávid legyen a "cross-tribe dependency specialist"
A cél: Dávid ne csak a Daily Bankingben legyen erős, hanem enterprise-szinten is “keresett” és megkerülhetetlen szereplővé vál
jon, mért eredményekkel és stabil kapcsolati tőkével, etikus keretek között.                                                  `
  ).trim();

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

  function buildInstructions(customInstructions) {
    const custom = String(customInstructions || "").trim();
    if (!custom) return SYSTEM_PROMPT;

    return `${SYSTEM_PROMPT}\n\n---\nProject instructions (user-provided):\n${custom}`.trim();
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
        `SELECT doc_id, conversation_id, vector_store_id, instructions, model FROM docs_sessions WHERE doc_id = $1`,
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
          const s = await pool.query(
            `SELECT conversation_id, vector_store_id FROM docs_sessions WHERE doc_id = $1`,
            [docId]
          );
          const row = s.rows?.[0];

          const f = await pool.query(
            `SELECT vector_store_file_id, file_vector_store_id, file_vector_store_file_id FROM docs_files WHERE doc_id = $1 ORDER BY created_at DESC, id DESC`,
            [docId]
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

          // Try deleting vector store files first.
          if (vectorStoreId && client?.vectorStores?.files) {
            for (const fileId of docVsFileIds) {
              try {
                const filesApi = client.vectorStores.files;
                if (typeof filesApi.del === "function") {
                  await filesApi.del(vectorStoreId, fileId);
                } else if (typeof filesApi.delete === "function") {
                  await filesApi.delete(vectorStoreId, fileId);
                }
              } catch (_) {
                // best-effort
              }
            }
          }

          // Delete file-scoped vector stores (best-effort).
          if (client?.vectorStores) {
            for (const vsId of fileVsIds) {
              // Try deleting the store files first (if we have them).
              const vsFileIds = fileVsFileIdsByStore.get(vsId) || [];
              if (vsFileIds.length && client?.vectorStores?.files) {
                for (const fileId of vsFileIds) {
                  try {
                    const filesApi = client.vectorStores.files;
                    if (typeof filesApi.del === "function") {
                      await filesApi.del(vsId, fileId);
                    } else if (typeof filesApi.delete === "function") {
                      await filesApi.delete(vsId, fileId);
                    }
                  } catch (_) {
                    // best-effort
                  }
                }
              }

              try {
                if (typeof client.vectorStores.del === "function") {
                  await client.vectorStores.del(vsId);
                } else if (typeof client.vectorStores.delete === "function") {
                  await client.vectorStores.delete(vsId);
                }
              } catch (_) {
                // best-effort
              }
            }
          }

          // Delete vector store container.
          if (vectorStoreId && client?.vectorStores) {
            try {
              if (typeof client.vectorStores.del === "function") {
                await client.vectorStores.del(vectorStoreId);
              } else if (typeof client.vectorStores.delete === "function") {
                await client.vectorStores.delete(vectorStoreId);
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
              } else if (typeof client.conversations.delete === "function") {
                await client.conversations.delete(conversationId);
              }
            } catch (_) {
              // best-effort
            }
          }
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

      const title = String(docTitle || "document").replace(/[^a-zA-Z0-9._-]+/g, "_");
      const filename = `${title || "document"}_${String(docId).slice(0, 8)}.txt`;
      const buf = Buffer.from(docText, "utf8");
      const hash = sha256Hex(buf);

      const existing = await findExistingDocsFileByHash_(String(docId), "doc", hash);
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
        name: `docassist-${String(docId)}-doc-${hash.slice(0, 12)}`,
        metadata: { doc_id: String(docId), kind: "doc", sha256: hash },
      });
      const fileVectorStoreId = fileVectorStore?.id;

      const uploadableDoc = await toFile(buf, filename, { type: "text/plain" });
      const vsFile = await client.vectorStores.files.uploadAndPoll(session.vector_store_id, uploadableDoc);

      const uploadableFileScope = await toFile(buf, filename, { type: "text/plain" });
      const fileScopeVsf = await client.vectorStores.files.uploadAndPoll(
        fileVectorStoreId,
        uploadableFileScope
      );

      await recordVectorStoreFile(String(docId), "doc", filename, hash, vsFile.id, {
        fileVectorStoreId,
        fileVectorStoreFileId: fileScopeVsf?.id || null,
      });

      // Best-effort: fetch docs_files id for UI convenience.
      const created = await findExistingDocsFileByHash_(String(docId), "doc", hash);
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

      // Hash includes tabId to avoid cross-tab dedupe collisions.
      const buf = Buffer.from(tabText, "utf8");
      const hash = sha256Hex(Buffer.from(`${String(tabId)}\n\n${String(tabText)}`, "utf8"));

      const existing = await findExistingDocsFileByHash_(String(docId), "tab", hash);
      if (existing?.vector_store_file_id) {
        return res.json({
          vectorStoreFileId: existing.vector_store_file_id,
          docsFileId: existing.id,
          reused: true,
          hasFileScope: Boolean(existing.file_vector_store_id),
        });
      }

      const safeTabTitle = String(tabTitle || "tab").replace(/[^a-zA-Z0-9._-]+/g, "_");
      const safeTabId = String(tabId).replace(/[^a-zA-Z0-9._-]+/g, "_");
      const safeDocPrefix = String(docId).slice(0, 8);
      let filename = `tab_${safeTabTitle || "tab"}_${safeTabId}_${safeDocPrefix}.txt`;
      if (filename.length > cfg.maxFilenameChars) {
        filename = filename.slice(0, cfg.maxFilenameChars);
      }

      const fileVectorStore = await client.vectorStores.create({
        name: `docassist-${String(docId)}-tab-${hash.slice(0, 12)}`,
        metadata: { doc_id: String(docId), kind: "tab", tab_id: String(tabId), sha256: hash },
      });
      const fileVectorStoreId = fileVectorStore?.id;

      const uploadableTab = await toFile(buf, filename, { type: "text/plain" });
      const vsFile = await client.vectorStores.files.uploadAndPoll(session.vector_store_id, uploadableTab);

      const uploadableFileScope = await toFile(buf, filename, { type: "text/plain" });
      const fileScopeVsf = await client.vectorStores.files.uploadAndPoll(
        fileVectorStoreId,
        uploadableFileScope
      );

      await recordVectorStoreFile(String(docId), "tab", filename, hash, vsFile.id, {
        fileVectorStoreId,
        fileVectorStoreFileId: fileScopeVsf?.id || null,
      });

      // Best-effort: fetch docs_files id for UI convenience.
      const created = await findExistingDocsFileByHash_(String(docId), "tab", hash);
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

      const response = await client.responses.create({
        model: session.model || cfg.openaiModel,
        conversation: session.conversation_id,
        instructions: buildInstructions(session.instructions),
        tools: [
          {
            type: "file_search",
            vector_store_ids: [scopedVectorStoreId || session.vector_store_id],
          },
        ],
        input: msgStr,
        max_output_tokens: cfg.maxOutputTokens,
      });

      const replyText = String(response.output_text || "").trim();

      try {
        await appendToHistory(String(docId), "user", msgStr);
        await appendToHistory(String(docId), "assistant", replyText);
      } catch (e) {
        logger.error(e);
      }

      return res.json({
        reply: replyText,
        responseId: response.id,
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
