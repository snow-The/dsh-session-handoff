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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const SQL = {
  nodes: 'CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, mention_count INTEGER NOT NULL DEFAULT 1)',
  edges: 'CREATE TABLE IF NOT EXISTS edges (source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0, last_seen INTEGER NOT NULL, PRIMARY KEY (source, target, relation))',
  checkpoints: 'CREATE TABLE IF NOT EXISTS checkpoints (session_id TEXT NOT NULL, seq_start INTEGER NOT NULL, seq_end INTEGER NOT NULL, summary TEXT NOT NULL, shadowed_seqs TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq_start, seq_end))',
  checkpoint_nodes: 'CREATE TABLE IF NOT EXISTS checkpoint_nodes (session_id TEXT NOT NULL, seq_start INTEGER NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY (session_id, seq_start, node_id))',
  node_fts: 'CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(id UNINDEXED, title, kind)',
  cp_fts: 'CREATE VIRTUAL TABLE IF NOT EXISTS cp_fts USING fts5(session_id UNINDEXED, seq_start UNINDEXED, summary)',
  docs: 'CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, indexed_at INTEGER NOT NULL)',
  doc_fts: 'CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(id UNINDEXED, kind, title, body)',
};

function openDb() {
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

function ingestSession(db, sessionId, events, wm, force) {
  let lastSeq = wm[sessionId] || 0;
  let added = 0;
  for (const e of events) {
    if (e?.type !== 'compaction/summary') continue;
    const seq = Number(e.seq);
    if (!force && seq <= lastSeq) continue;
    const d = e.data ?? {};
    const range = d.shadowedRange ?? {};
    const summary = String(d.summary ?? d.content ?? '');
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
      const events = agent?.session?.events ? [...agent.session.events] : [];
      const sessionId = agent?.session?.id ?? 'session';
      const cmd = String(args.command || '');
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
      const wm = readWatermarks();
      if (cmd === 'build') {
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
}
