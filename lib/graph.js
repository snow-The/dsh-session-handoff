/**
 * dsh-session-handoff — ACP graph layer (L2).
 *
 * Reads DSH-native compaction/summary session events (L3 source of truth in
 * session.jsonl) and materializes a cross-checkpoint entity graph under
 * ~/.dsh/graph/graph.db. node:sqlite (Node 22+ builtin) + w8-style NLP.
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
  fts: 'CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(id UNINDEXED, title, kind)',
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

/** Shared graph recall: given a query, return [{id, kind, checkpoints: [{seqStart, seqEnd, summary}]}]. null when graph unavailable. */
export function graphRecall(query, limit = 5) {
  const db = openDb();
  if (db == null) return null;
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const hits = [];
  const matchQ = JSON.stringify(q) + '*';
  try {
    for (const n of db.prepare('SELECT id, title, kind FROM node_fts WHERE node_fts MATCH ? LIMIT ?').all(matchQ, limit)) hits.push(n);
  } catch { /* FTS may reject some queries */ }
  if (hits.length < limit) {
    for (const n of db.prepare('SELECT id, title, kind FROM nodes WHERE id LIKE ? OR title LIKE ? LIMIT ?').all('%' + q + '%', '%' + q + '%', limit - hits.length))
      if (!hits.some((h) => h.id === n.id)) hits.push(n);
  }
  return hits.slice(0, limit).map((n) => ({
    id: n.id,
    kind: n.kind,
    checkpoints: db.prepare('SELECT c.seq_start AS seqStart, c.seq_end AS seqEnd, substr(c.summary,1,120) AS summary FROM checkpoints c JOIN checkpoint_nodes cn ON cn.session_id=c.session_id AND cn.seq_start=c.seq_start WHERE cn.node_id=? ORDER BY c.created_at DESC LIMIT 3').all(n.id),
  }));
}

/** Hot entities by mention_count (most-referenced across checkpoints). null when graph unavailable. */
export function graphHotEntities(limit = 5) {
  const db = openDb();
  if (db == null) return null;
  return db.prepare('SELECT id, kind, mention_count FROM nodes ORDER BY mention_count DESC LIMIT ?').all(limit);
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
    description: 'Graph-aware long-term memory over ACP compaction checkpoints. Commands: build | recall <query> | related <node> | stats | export. Reads compaction/summary events into ~/.dsh/graph/graph.db (node:sqlite).',
    parameters: {
      command: { type: 'string', required: true },
      query: { type: 'string' },
      node: { type: 'string' },
      limit: { type: 'integer' },
      force: { type: 'boolean' },
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
        const hits = [];
        const matchQ = JSON.stringify(q) + '*'; // phrase query: "term"* — safe for fts5 special chars
        for (const n of db.prepare('SELECT id, title, kind FROM node_fts WHERE node_fts MATCH ? LIMIT ?').all(matchQ, limit)) hits.push(n);
        if (hits.length < limit) {
          for (const n of db.prepare('SELECT id, title, kind FROM nodes WHERE id LIKE ? OR title LIKE ? LIMIT ?').all('%' + q + '%', '%' + q + '%', limit - hits.length))
            if (!hits.some((h) => h.id === n.id)) hits.push(n);
        }
        const lines = [];
        for (const n of hits.slice(0, limit)) {
          lines.push(n.id + ' [' + n.kind + '] ' + n.title);
          for (const cp of db.prepare('SELECT c.seq_start, c.seq_end, substr(c.summary,1,120) AS s FROM checkpoints c JOIN checkpoint_nodes cn ON cn.session_id=c.session_id AND cn.seq_start=c.seq_start WHERE cn.node_id=? ORDER BY c.created_at DESC LIMIT 3').all(n.id))
            lines.push('    -> s' + cp.seq_start + '-' + cp.seq_end + ': ' + cp.s);
        }
        return hits.length ? 'acp_graph recall "' + q + '":\n' + lines.join('\n') : 'acp_graph recall "' + q + '": no hits';
      }
      if (cmd === 'related') {
        const node = String(args.node || '').toLowerCase().trim();
        if (!node) return 'acp_graph related needs a node id';
        const rows = db.prepare('SELECT e.target AS other, n.kind, e.weight FROM edges e JOIN nodes n ON n.id = e.target WHERE e.source = ? ORDER BY e.weight DESC LIMIT ?').all(node, limit);
        return rows.length ? 'acp_graph related ' + node + ':\n' + rows.map((r) => '  ' + r.other + ' [' + r.kind + '] w=' + r.weight).join('\n') : 'acp_graph related ' + node + ': no neighbors';
      }
      if (cmd === 'export') {
        const nodes = db.prepare('SELECT id, kind, title, mention_count FROM nodes ORDER BY mention_count DESC LIMIT ?').all(200);
        const edges = db.prepare('SELECT source, target, relation, weight FROM edges WHERE weight >= 2 ORDER BY weight DESC LIMIT ?').all(200);
        return 'acp_graph export (DSH-readable):\n\n## nodes\n' + nodes.map((n) => '- ' + n.id + ' [' + n.kind + '] x' + n.mention_count).join('\n') + '\n\n## edges\n' + (edges.length ? edges.map((e) => '- ' + e.source + ' --(' + e.relation + ' w=' + e.weight + ')--> ' + e.target).join('\n') : '(none)');
      }
      return 'acp_graph commands: build | recall <query> | related <node> | stats | export';
    },
  }));
}