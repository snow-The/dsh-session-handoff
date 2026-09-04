/**
 * dsh-session-handoff — ACP graph layer (L2).
 *
 * Reads DSH-native compaction/summary session events (L3, source of truth in
 * session.jsonl) and materializes a cross-checkpoint entity graph under
 * ~/.dsh/graph/graph.db. node:sqlite (Node 22+ builtin) + w8-style NLP.
 *
 * Retrieval: three-stage hybrid (ported from w8-core/src/retrieval.ts):
 *   1 candidate: SQLite FTS5 (BM25) over node titles + checkpoint summaries
 *   2 fusion: RRF (score = sum 1/(k+rank), k=60) + graph BFS expansion
 *   3 rerank: recency decay + beta-prior confidence (mention_count as samples)
 *   embed() interface is reserved (future WASM vectorization); NOT implemented
 *   yet — the graph stays zero-dependency and model-free.
 *
 * The DB is disposable: acp_graph build rebuilds it from session.jsonl
 * (idempotent watermark). Never modifies the native compaction contract.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { DatabaseSync = null; }

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh'); }
function graphDir() { return join(dshHome(), 'graph'); }
function dbPath() { return join(graphDir(), 'graph.db'); }
function watermarkPath() { return join(graphDir(), 'watermarks.json'); }

// --- session.jsonl reading ---
// compaction/summary events live in the session FILE (shadowed region), not in
// the in-memory surface agent.session.events. To build the graph we must read
// the file. Path rule: <DSH_HOME>/sessions/--<cwd-slug>--/session-<id>.jsonl[.zstd]
function cwdSlug(cwd) {
  if (!cwd) return '';
  const norm = String(cwd).replace(/\\/g, '/').replace(/^[A-Za-z]:/, (m) => m[0]);
  const slug = norm.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return '--' + slug + '--';
}

export function sessionFilePath(sessionId, cwd) {
  const sessionsDir = join(dshHome(), 'sessions');
  const candidates = [];
  // primary layout: <sessions>/<cwd-slug>/session-<id>/session.jsonl[.zstd]
  if (cwd) {
    const dir = join(sessionsDir, cwdSlug(cwd), 'session-' + sessionId);
    candidates.push(join(dir, 'session.jsonl.zstd'));
    candidates.push(join(dir, 'session.jsonl'));
  }
  // flat fallbacks
  if (cwd) candidates.push(join(sessionsDir, cwdSlug(cwd), 'session-' + sessionId + '.jsonl.zstd'));
  candidates.push(join(sessionsDir, sessionId + '.jsonl.zstd'));
  candidates.push(join(sessionsDir, sessionId + '.jsonl'));
  const hit = candidates.find((p) => existsSync(p));
  if (hit) return hit;
  // Recursive search by session id (robust when cwd slug is unavailable at runtime).
  try {
    const { readdirSync, statSync } = require('node:fs');
    const walk = (dir) => {
      let found = null;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (found) break;
        const p = join(dir, e.name);
        try {
          if (e.isDirectory()) found = walk(p);
          else if ((e.name === 'session.jsonl.zstd' || e.name === 'session.jsonl') && dir.includes('session-' + sessionId)) found = p;
        } catch { /* skip */ }
      }
      return found;
    };
    return walk(sessionsDir);
  } catch { return null; }
}

/** Read all events from a session file (decompress zstd via CLI when needed). */
export function readSessionEventsFromFile(path) {
  if (!path) return [];
  let text;
  try {
    if (path.endsWith('.zstd')) {
      // Session files are MULTI-FRAME zstd (one frame per append batch).
      // 1) zstd CLI handles multi-frame; PATH first, then known winget path
      //    (DSH's own PATH may not include winget package dirs).
      const { execSync } = require('node:child_process');
      const zstdBins = ['zstd', 'C:\\Users\\snow\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Meta.Zstandard_Microsoft.Winget.Source_8wekyb3d8bbwe\\zstd-v1.5.7-win64\\zstd.exe'];
      let lastErr = null;
      for (const bin of zstdBins) {
        try {
          text = execSync(bin + ' -d -c ' + JSON.stringify(path), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
          lastErr = null;
          break;
        } catch (e) { lastErr = e; }
      }
      if (lastErr) throw lastErr;
      // 2) node:zlib zstdDecompressSync is SINGLE-frame only — it silently
      //    truncates multi-frame files, so never use it here.
    } else {
      text = readFileSync(path, 'utf8');
    }
  } catch (e) {
    console.warn('[dsh-session-handoff] readSessionEventsFromFile failed:', String(e?.message ?? e));
    return [];
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return events;
}

const SQL = {
  nodes: 'CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, mention_count INTEGER NOT NULL DEFAULT 1)',
  edges: 'CREATE TABLE IF NOT EXISTS edges (source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0, last_seen INTEGER NOT NULL, PRIMARY KEY (source, target, relation))',
  checkpoints: 'CREATE TABLE IF NOT EXISTS checkpoints (session_id TEXT NOT NULL, seq_start INTEGER NOT NULL, seq_end INTEGER NOT NULL, summary TEXT NOT NULL, shadowed_seqs TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq_start, seq_end))',
  checkpoint_nodes: 'CREATE TABLE IF NOT EXISTS checkpoint_nodes (session_id TEXT NOT NULL, seq_start INTEGER NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY (session_id, seq_start, node_id))',
  node_fts: 'CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(id UNINDEXED, title, kind)',
  cp_fts: 'CREATE VIRTUAL TABLE IF NOT EXISTS cp_fts USING fts5(session_id UNINDEXED, seq_start UNINDEXED, summary)',
  docs: 'CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, indexed_at INTEGER NOT NULL)',
  doc_fts: 'CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(id UNINDEXED, kind, title, body)',
  // M1 lossless original block storage (headroom CCR-inspired). Stores the FULL
  // original text of large tool outputs at compress time so any compressed
  // block is recoverable verbatim; hash is content-addressed (SHA-256[:24]).
  block_originals: 'CREATE TABLE IF NOT EXISTS block_originals (hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, strategy TEXT NOT NULL, original TEXT NOT NULL, compressed TEXT NOT NULL, token_before INTEGER NOT NULL DEFAULT 0, token_after INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL DEFAULT 0, decompress_count INTEGER NOT NULL DEFAULT 0)',
  block_index: 'CREATE INDEX IF NOT EXISTS idx_block_originals_session ON block_originals(session_id, seq)',
};

export function openDb() {
  if (DatabaseSync == null) return null;
  mkdirSync(graphDir(), { recursive: true });
  const db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  for (const s of Object.values(SQL)) db.exec(s);
  return db;
}

const STOPWORDS = new Set(('a an the and or but if then else of to in on for with at from by as is are was were be been being this that these those it its we our you your they them their i my me he his she her can could should would will may might must not no yes do does did have has had about into over under after before during within without because so also just very much many some any each every such only own same other new now get got make made use used using').split(' '));

function tokenize(text) {
  const out = [];
  const words = text.toLowerCase().match(/[a-z][a-z0-9_\/-]{1,}/g) || [];
  for (const w of words) {
    const leaf = w.split('/').pop().split('.').pop();
    if (leaf.length >= 3 && !STOPWORDS.has(leaf)) out.push(leaf);
    if (w.includes('/') && w.length >= 5) out.push(w);
  }
  const chinese = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const c of chinese) for (let i = 0; i + 1 < c.length; i++) out.push(c.slice(i, i + 2));
  return out;
}

function classify(token) {
  if (/[a-z0-9_/-]+\.(ts|js|tsx|jsx|json|yml|yaml|md|css|html|py|rs|go)$/.test(token)) return 'file';
  if (/^@[a-z0-9_-]+\/[a-z0-9_-]+/.test(token)) return 'package';
  if (/^[a-z][a-z0-9_]*(?:[A-Z][a-z0-9_]*)+$/.test(token)) return 'function';
  return 'concept';
}

function extractEntities(text) {
  const counts = new Map();
  for (const t of tokenize(text)) {
    if (t.length < 3 || t.length > 60) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id, count]) => ({ id, kind: classify(id), title: id, count }));
}

function readWatermarks() { try { return JSON.parse(readFileSync(watermarkPath(), 'utf8')); } catch { return {}; } }
function writeWatermarks(wm) { writeFileSync(watermarkPath(), JSON.stringify(wm, null, 2), 'utf8'); }

function upsertNode(db, node, seq) {
  const row = db.prepare('SELECT mention_count FROM nodes WHERE id = ?').get(node.id);
  if (row) {
    db.prepare('UPDATE nodes SET last_seen = ?, mention_count = mention_count + ?, title = ? WHERE id = ?').run(seq, node.count, node.title, node.id);
  } else {
    db.prepare('INSERT OR IGNORE INTO nodes (id, kind, title, first_seen, last_seen, mention_count) VALUES (?,?,?,?,?,?)').run(node.id, node.kind, node.title, seq, seq, node.count);
  }
  db.prepare('INSERT OR REPLACE INTO node_fts (id, title, kind) VALUES (?,?,?)').run(node.id, node.title, node.kind);
}

function linkEntities(db, ids, seq, relation) {
  relation = relation || 'co-occurs';
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (ids[i] === ids[j]) continue;
    db.prepare('INSERT INTO edges (source, target, relation, weight, last_seen) VALUES (?,?,?,1.0,?) ON CONFLICT(source, target, relation) DO UPDATE SET weight = weight + 1, last_seen = excluded.last_seen').run(ids[i], ids[j], relation, seq);
  }
}

function linkCheckpointNodes(db, sessionId, seqStart, seqEnd, summary, ids, seq) {
  db.prepare('INSERT OR REPLACE INTO checkpoints (session_id, seq_start, seq_end, summary, shadowed_seqs, created_at) VALUES (?,?,?,?,?,?)').run(sessionId, seqStart, seqEnd, summary, '[]', seq);
  db.prepare('INSERT OR REPLACE INTO cp_fts (session_id, seq_start, summary) VALUES (?,?,?)').run(sessionId, seqStart, summary);
  for (const id of ids) db.prepare('INSERT OR IGNORE INTO checkpoint_nodes (session_id, seq_start, node_id) VALUES (?,?,?)').run(sessionId, seqStart, id);
}

/** compaction/summary event data.summary is an array of {type,text} blocks (or a string). */
function toSummaryText(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => (typeof x === 'string' ? x : String(x?.text ?? x?.content ?? ''))).filter(Boolean).join('\n');
  }
  if (raw && typeof raw === 'object') return String(raw.text ?? raw.content ?? JSON.stringify(raw));
  return String(raw ?? '');
}

function extractMessageText(e) {
  const m = e?.data?.message;
  if (!m) return '';
  const parts = [];
  const walk = (content) => {
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else if (c?.type === 'reasoning' && typeof c.text === 'string') parts.push(c.text);
      else if (Array.isArray(c?.content)) walk(c.content);
    }
  };
  walk(m.content);
  return parts.join('\n');
}

function ingestSession(db, sessionId, events, wm, force) {
  let lastSeq = wm[sessionId] || 0;
  let added = 0;
  // PTC/agent 后端不产 compaction/summary 事件：检测是否有标准事件，
  // 没有则用 assistant/message 按 turn 降级建图。
  const hasCompaction = events.some((e) => e?.type === 'compaction/summary');
  let lastTurn = -1;
  for (const e of events) {
    const seq = Number(e.seq);
    if (e?.type === 'compaction/summary') {
      if (!force && seq <= lastSeq) continue;
      const d = e.data ?? {};
      const range = d.shadowedRange ?? {};
      const summary = toSummaryText(d.summary ?? d.content);
      const start = Number(range.start ?? seq);
      const end = Number(range.end ?? seq);
      const ids = [];
      const marker = summary.match(/\[entities:\s*([^\]]+)\]/i);
      if (marker) {
        for (const raw of marker[1].split(',')) {
          const id = raw.trim().toLowerCase().replace(/\s+/g, '-');
          if (id.length >= 2) { upsertNode(db, { id, kind: classify(id), title: id, count: 1 }, seq); ids.push(id); }
        }
      } else {
        for (const ent of extractEntities(summary)) { upsertNode(db, ent, seq); ids.push(ent.id); }
      }
      linkEntities(db, ids, seq);
      linkCheckpointNodes(db, sessionId, start, end, summary, ids, seq);
      lastSeq = seq;
      added++;
      continue;
    }
    // 降级路径：无标准 compaction 事件时，按 turn 从 assistant/message 提取实体
    if (!hasCompaction && e?.type === 'assistant/message' && e?.data?.turn != null) {
      const turn = e.data.turn;
      if (!force && turn <= lastTurn) continue;
      const text = extractMessageText(e);
      if (!text || text.length < 60) { lastTurn = turn; lastSeq = Math.max(lastSeq, seq); continue; }
      const ids = [];
      for (const ent of extractEntities(text)) { upsertNode(db, ent, seq); ids.push(ent.id); }
      if (ids.length) {
        linkEntities(db, ids, seq);
        // 以 turn 为 checkpoint 边界（PTC 没有 seq 区间压缩，用 turn 当块坐标）
        linkCheckpointNodes(db, sessionId, turn, turn, text.slice(0, 300), ids, seq);
        added++;
      }
      lastTurn = turn;
      lastSeq = Math.max(lastSeq, seq);
      continue;
    }
    if (seq > lastSeq) lastSeq = seq;
  }
  wm[sessionId] = lastSeq;
  return added;
}

function graphStats(db) {
  return db.prepare('SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges, (SELECT COUNT(*) FROM checkpoints) AS checkpoints').get();
}

// ---------------------------------------------------------------------------
// three-stage hybrid retrieval (w8-core/retrieval.ts, model-free now)
// ---------------------------------------------------------------------------

function rrf(rankedLists, k) {
  k = k || 60;
  const scores = new Map();
  for (const list of rankedLists) {
    list.forEach((id, rank) => { scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1)); });
  }
  return scores;
}

function betaConfidence(prior, samples, weight) {
  weight = weight || 100;
  if (samples <= 0) return prior;
  return (prior * weight + samples) / (weight + samples);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function ftsPhrase(q) { return JSON.stringify(q) + '*'; }

/**
 * Hybrid recall over the graph. Returns [{ id, kind, title, score, checkpoints }].
 * embed is a reserved seam for future WASM vectorization; when omitted the
 * retrieval runs BM25(FTS5) + graph BFS + RRF + recency/beta only.
 */
export function graphRecall(query, limit = 5, opts = {}) {
  const db = openDb();
  if (db == null) return null;
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const k = opts.rrfK ?? 60;
  const halfLife = opts.recencyHalfLife ?? 400;
  const betaW = opts.betaWeight ?? 100;
  const embed = opts.embed; // reserved: future WASM vectorization

  const bmList = [];
  const matchQ = ftsPhrase(q);
  try {
    for (const n of db.prepare('SELECT id FROM node_fts WHERE node_fts MATCH ? LIMIT 40').all(matchQ)) bmList.push(n.id);
    for (const cp of db.prepare('SELECT session_id, seq_start FROM cp_fts WHERE cp_fts MATCH ? LIMIT 40').all(matchQ)) {
      for (const cn of db.prepare('SELECT node_id FROM checkpoint_nodes WHERE session_id=? AND seq_start=?').all(cp.session_id, cp.seq_start))
        if (!bmList.includes(cn.node_id)) bmList.push(cn.node_id);
    }
  } catch { /* FTS may reject */ }
  if (bmList.length === 0) {
    // FTS tokenization may not split punctuation/compound ids the way queries
    // expect — fall back to plain substring match over node ids/titles.
    for (const n of db.prepare('SELECT id FROM nodes WHERE id LIKE ? OR title LIKE ? LIMIT 40').all('%' + q + '%', '%' + q + '%')) bmList.push(n.id);
  }

  const vecList = [];
  if (embed && typeof embed === 'function') {
    try {
      const qv = embed(q);
      for (const n of db.prepare('SELECT id, title FROM nodes LIMIT 500').all()) {
        const nv = embed(n.title);
        if (cosine(qv, nv) >= (opts.minSimilarity ?? 0.4)) vecList.push(n.id);
      }
    } catch { /* embed unavailable → fall back */ }
  }

  const fused = rrf([bmList, vecList], k);
  const seen = new Set(fused.keys());
  const bfsAdds = [];
  for (const nid of [...fused.keys()].slice(0, 8)) {
    for (const e of db.prepare('SELECT source, target FROM edges WHERE source=? OR target=? LIMIT 12').all(nid, nid)) {
      const other = e.source === nid ? e.target : e.source;
      if (other && other !== nid && !seen.has(other)) { seen.add(other); bfsAdds.push(other); }
    }
  }

  const rows = db.prepare('SELECT id, kind, title, mention_count, last_seen FROM nodes').all();
  const nowTick = rows.reduce((mx, r) => Math.max(mx, r.last_seen), 0);
  const hits = [];
  for (const r of rows) {
    const fusedScore = fused.get(r.id) ?? 0;
    if (fusedScore === 0 && !bfsAdds.includes(r.id)) continue;
    const recency = halfLife > 0 ? Math.pow(0.5, Math.max(0, nowTick - r.last_seen) / halfLife) : 1;
    const confidence = betaConfidence(0.5, r.mention_count, betaW);
    const bfsBoost = bfsAdds.includes(r.id) ? 0.2 : 0;
    const score = fusedScore * (0.5 + confidence) * recency + bfsBoost;
    if (score <= 0) continue;
    hits.push({
      id: r.id, kind: r.kind, title: r.title, score,
      checkpoints: db.prepare('SELECT c.seq_start AS seqStart, c.seq_end AS seqEnd, substr(c.summary,1,120) AS summary FROM checkpoints c JOIN checkpoint_nodes cn ON cn.session_id=c.session_id AND cn.seq_start=c.seq_start WHERE cn.node_id=? ORDER BY c.created_at DESC LIMIT 3').all(r.id),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Hot entities by mention_count. null when graph unavailable. */
export function graphHotEntities(limit = 5) {
  const db = openDb();
  if (db == null) return null;
  return db.prepare('SELECT id, kind, mention_count FROM nodes ORDER BY mention_count DESC LIMIT ?').all(limit);
}

/**
 * Index external knowledge docs (e.g. .dsh-lib-analyzer/pages, wiki pages)
 * into the ACP graph DB (docs + doc_fts). Lets acp_graph build also cover
 * knowledge-base pages, so libsearch-style queries get ACP cross-session
 * context. Idempotent: re-indexing a file updates its row. Returns count.
 */
export function indexDocsDir(db, dir, kind = 'doc') {
  if (db == null) return 0;
  const { readdirSync, readFileSync, statSync } = require('node:fs');
  const { join, basename } = require('node:path');
  let files = [];
  try {
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const fp = join(d, e.name);
        try {
          if (e.isDirectory()) walk(fp);
          else if (/.(md|markdown|txt)$/.test(e.name)) files.push(fp);
        } catch { /* skip */ }
      }
    };
    walk(dir);
  } catch { return 0; }
  let n = 0;
  const now = Date.now();
  for (const f of files) {
    try {
      const body = readFileSync(f, 'utf8');
      const id = 'doc:' + require('node:crypto').createHash('sha1').update(f).digest('hex').slice(0, 12);
      const title = basename(f).replace(/\.(md|markdown|txt)$/, '');
      db.prepare('INSERT OR REPLACE INTO docs (id, kind, title, body, source, indexed_at) VALUES (?,?,?,?,?,?)').run(id, kind, title, body, f, now);
      db.prepare('INSERT OR REPLACE INTO doc_fts (id, kind, title, body) VALUES (?,?,?,?)').run(id, kind, title, body);
      n++;
    } catch { /* unreadable */ }
  }
  return n;
}

/** Search indexed external docs. Returns [{ id, kind, title, snippet }]. Used by libsearch. */
export function graphDocSearch(query, limit = 10, kind = null) {
  const db = openDb();
  if (db == null) return null;
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const matchQ = JSON.stringify(q) + '*';
  const hits = [];
  try {
    const sql = kind
      ? 'SELECT d.id, d.kind, d.title, substr(d.body,1,160) AS snippet, bm25(doc_fts) AS rank FROM doc_fts JOIN docs d ON d.id = doc_fts.id WHERE doc_fts MATCH ? AND d.kind = ? ORDER BY rank LIMIT ?'
      : 'SELECT d.id, d.kind, d.title, substr(d.body,1,160) AS snippet, bm25(doc_fts) AS rank FROM doc_fts JOIN docs d ON d.id = doc_fts.id WHERE doc_fts MATCH ? ORDER BY rank LIMIT ?';
    const args = kind ? [matchQ, kind, limit] : [matchQ, limit];
    for (const h of db.prepare(sql).all(...args)) hits.push({ id: h.id, kind: h.kind, title: h.title, snippet: h.snippet });
  } catch { /* FTS */ }
  return hits;
}

// ---------------------------------------------------------------------------
// M1: lossless original block storage (headroom CCR-inspired).
// At compress time, large tool outputs are stored verbatim keyed by a
// content-addressed hash (SHA-256[:24]). Any compressed block stays fully
// recoverable; retrieval is single-block (M2 groundwork).
// ---------------------------------------------------------------------------

/** Content-addressed hash of raw text (SHA-256, 24 hex chars). */
export function blockHash(text) {
  return require('node:crypto').createHash('sha256').update(String(text)).digest('hex').slice(0, 24);
}

/** Best-effort lossless compact: JSON whitespace minify (keys/strings untouched). */
function losslessCompact(text) {
  const t = String(text);
  try {
    const parsed = JSON.parse(t);
    // Re-stringify with 0 indent — removes ALL insignificant whitespace while
    // preserving every key and value byte-for-byte (lossless).
    return JSON.stringify(parsed);
  } catch {
    // Not JSON: collapse repeated blank lines only (still lossless in spirit —
    // original kept in DB; compressed form is just for size comparison).
    return t.replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n');
  }
}

/**
 * Store one original block. Returns { hash, saved } where saved is the
 * token/char delta estimate. Skips if the text is already stored (idempotent).
 */
export function storeBlock(db, block) {
  if (db == null) return null;
  const { sessionId, seq, kind, text } = block;
  const original = String(text ?? '');
  if (!original || original.length < 200) return null; // only worthwhile for big outputs
  const hash = blockHash(original);
  const strategy = (() => { try { JSON.parse(original); return 'json-minify'; } catch { return 'collapse-blanks'; } })();
  const compressed = losslessCompact(original);
  const exists = db.prepare('SELECT 1 FROM block_originals WHERE hash = ?').get(hash);
  if (exists) return { hash, saved: 0, duplicate: true };
  const now = Date.now();
  try {
    db.prepare('INSERT OR REPLACE INTO block_originals (hash, session_id, seq, kind, strategy, original, compressed, token_before, token_after, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(hash, String(sessionId ?? ''), Number(seq) || 0, String(kind ?? 'tool'), strategy, original, compressed, original.length, compressed.length, now);
    return { hash, saved: original.length - compressed.length, duplicate: false };
  } catch (e) {
    console.warn('[dsh-session-handoff] storeBlock failed:', String(e?.message ?? e));
    return null;
  }
}

/** Retrieve an original block by content hash. Bumps last_accessed + decompress_count. */
export function retrieveBlock(db, hash) {
  if (db == null) return null;
  const row = db.prepare('SELECT * FROM block_originals WHERE hash = ?').get(String(hash ?? ''));
  if (!row) return null;
  try {
    db.prepare('UPDATE block_originals SET last_accessed = ?, decompress_count = decompress_count + 1 WHERE hash = ?').run(Date.now(), hash);
  } catch { /* non-fatal */ }
  return { hash: row.hash, seq: row.seq, kind: row.kind, strategy: row.strategy, original: row.original, created_at: row.created_at };
}

/** Block store stats. */
export function blockStats(db) {
  if (db == null) return null;
  const row = db.prepare('SELECT COUNT(*) AS blocks, SUM(CASE WHEN decompress_count > 0 THEN 1 ELSE 0 END) AS accessed, SUM(decompress_count) AS total_retrievals, SUM(token_before - token_after) AS chars_saved FROM block_originals').get();
  return { blocks: row?.blocks ?? 0, accessed: row?.accessed ?? 0, total_retrievals: row?.total_retrievals ?? 0, chars_saved: row?.chars_saved ?? 0 };
}

export function registerGraphTools(ctx) {
  const db = openDb();
  if (db == null) {
    ctx.tools.register(defineTool({
      name: 'acp_graph', description: 'acp_graph requires node:sqlite (Node >= 22.5)',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() { return 'acp_graph unavailable: node:sqlite missing'; },
    }));
    return;
  }
  ctx.tools.register(defineTool({
    name: 'acp_graph',
    description: 'Graph-aware long-term memory over ACP compaction checkpoints. Commands: build | recall <query> | related <node> | stats | export. Hybrid retrieval: FTS5 BM25 + graph BFS + RRF + recency/beta (embed seam reserved).',
    parameters: {
      command: { type: 'string', required: true },
      query: { type: 'string' },
      node: { type: 'string' },
      limit: { type: 'integer' },
      force: { type: 'boolean' },
      dir: { type: 'string' },
      kind: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const agent = exec?.agent;
      const session = agent?.session ?? {};
      const sessionId = session?.id ?? 'session';
      const cmd = String(args.command || '');
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
      const wm = readWatermarks();
      if (cmd === 'build') {
        // compaction/summary events live in the session FILE (shadowed region),
        // not in the in-memory surface. Read from file first; fall back to
        // in-memory events (covers non-zstd / plaintext sessions).
        const cwd = session?.header?.cwd ?? process.cwd();
        const fpath = sessionFilePath(sessionId, cwd);
        const fileEvents = fpath ? readSessionEventsFromFile(fpath) : [];
        const hasFileCompaction = fileEvents.some((e) => e?.type === 'compaction/summary');
        const memEvents = session?.events ? (Array.isArray(session.events) ? [...session.events] : [...session.events]) : [];
        const events = hasFileCompaction || fileEvents.length ? fileEvents : memEvents;
        const added = ingestSession(db, sessionId, events, wm, args.force === true);
        writeWatermarks(wm);
        const s = graphStats(db);
        return 'acp_graph build: +' + added + ' checkpoint(s)\n  nodes=' + s.nodes + ' edges=' + s.edges + ' checkpoints=' + s.checkpoints;
      }
      if (cmd === 'stats') {
        const s = graphStats(db);
        const top = db.prepare('SELECT id, kind, mention_count FROM nodes ORDER BY mention_count DESC LIMIT ?').all(10);
        return 'acp_graph stats: nodes=' + s.nodes + ' edges=' + s.edges + ' checkpoints=' + s.checkpoints + '\n\nmost-mentioned:\n' + top.map((n) => '  ' + n.id + ' [' + n.kind + '] x' + n.mention_count).join('\n');
      }
      if (cmd === 'recall') {
        const q = String(args.query || '').toLowerCase().trim();
        if (!q) return 'acp_graph recall needs a query';
        const hits = graphRecall(q, limit);
        if (!hits || !hits.length) return 'acp_graph recall "' + q + '": no hits';
        const lines = [];
        for (const h of hits) {
          lines.push(h.id + ' [' + h.kind + '] score=' + h.score.toFixed(3));
          for (const cp of h.checkpoints) lines.push('    -> s' + cp.seqStart + '-' + cp.seqEnd + ': ' + cp.summary);
        }
        return 'acp_graph recall "' + q + '":\n' + lines.join('\n');
      }
      if (cmd === 'related') {
        const node = String(args.node || '').toLowerCase().trim();
        if (!node) return 'acp_graph related needs a node id';
        const rows = db.prepare("SELECT other, kind, weight FROM (SELECT e.target AS other, n.kind, e.weight FROM edges e JOIN nodes n ON n.id=e.target WHERE e.source=? UNION ALL SELECT e.source AS other, n.kind, e.weight FROM edges e JOIN nodes n ON n.id=e.source WHERE e.target=?) ORDER BY weight DESC LIMIT ?").all(node, node, limit);
        return rows.length ? 'acp_graph related ' + node + ':\n' + rows.map((r) => '  ' + r.other + ' [' + r.kind + '] w=' + r.weight).join('\n') : 'acp_graph related ' + node + ': no neighbors';
      }
      if (cmd === 'export') {
        const nodes = db.prepare('SELECT id, kind, title, mention_count FROM nodes ORDER BY mention_count DESC LIMIT ?').all(200);
        const edges = db.prepare('SELECT source, target, relation, weight FROM edges WHERE weight >= 2 ORDER BY weight DESC LIMIT ?').all(200);
        return 'acp_graph export (DSH-readable):\n\n## nodes\n' + nodes.map((n) => '- ' + n.id + ' [' + n.kind + '] x' + n.mention_count).join('\n') + '\n\n## edges\n' + (edges.length ? edges.map((e) => '- ' + e.source + ' --(' + e.relation + ' w=' + e.weight + ')--> ' + e.target).join('\n') : '(none)');
      }
      if (cmd === 'index-docs') {
        const dir = String(args.dir || '').trim();
        if (!dir) return 'acp_graph index-docs needs a dir (absolute path to a knowledge dir)';
        const n = indexDocsDir(db, dir, String(args.kind || 'doc'));
        return 'acp_graph index-docs: indexed ' + n + ' doc(s) from ' + dir;
      }
      if (cmd === 'doc-search') {
        const q = String(args.query || '').toLowerCase().trim();
        if (!q) return 'acp_graph doc-search needs a query';
        const hits = graphDocSearch(q, limit, args.kind ? String(args.kind) : null);
        if (!hits || !hits.length) return 'acp_graph doc-search "' + q + '": no hits';
        return 'acp_graph doc-search "' + q + '":\n' + hits.map((h) => '• [' + h.kind + '] ' + h.title + '\n    ' + h.snippet).join('\n');
      }
      return 'acp_graph commands: build | recall <query> | related <node> | stats | export | index-docs <dir> [kind] | doc-search <query>';
    },
  }));

  // --- acp_block: M1 lossless original-block retrieval (headroom CCR-style) ---
  ctx.tools.register(defineTool({
    name: 'acp_block',
    description: 'M1 lossless block store over ACP compaction. Commands: retrieve <hash> (return a stored original block verbatim) | stats (block store counters). Large tool outputs are stored at compress time keyed by content hash, so any compressed block stays recoverable.',
    parameters: {
      command: { type: 'string', required: true },
      hash: { type: 'string', description: 'content-addressed hash (SHA-256[:24]) from retrieve' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const cmd = String(args.command || '');
      if (cmd === 'stats') {
        const s = blockStats(db);
        if (!s) return 'acp_block stats: unavailable (node:sqlite missing)';
        return 'acp_block stats: blocks=' + s.blocks + ' | accessed=' + s.accessed + ' | retrievals=' + s.total_retrievals + ' | chars_saved=' + s.chars_saved;
      }
      if (cmd === 'retrieve') {
        const hash = String(args.hash || '').trim();
        if (!hash) return 'acp_block retrieve needs a hash';
        const b = retrieveBlock(db, hash);
        if (!b) return 'acp_block retrieve: no block for ' + hash;
        return '# block ' + b.hash + ' (seq ' + b.seq + ', ' + b.kind + ', ' + b.strategy + ')\n\n' + b.original;
      }
      return 'acp_block commands: retrieve <hash> | stats';
    },
  }));
}
