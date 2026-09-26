/**
 * ACP 图 schema 契约的【生产者侧】不变量。
 *
 * 消费者(acp-memory / notemap / research-lab / lib-analyzer / skill-pack)通过
 * PRAGMA user_version 与生产方协商, 而不是各自猜表形状。协商只有在版本戳【可信】时
 * 才有意义, 所以这里锁定两条:
 *   1) openDb() 会盖章到 ACP_GRAPH_SCHEMA_VERSION
 *   2) 盖章【只升不降】—— 若库的版本高于本生产者声明的版本(例如用户装过更新的
 *      handoff, 又回退到旧版), openDb() 绝不能把它降回去。降级会让"库比消费方新"
 *      这个判断失效, 消费者就会按旧形状去读一个更新的库 —— 正是契约要防的静默错误。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'acp-stamp-'));
process.env.DSH_HOME = dir;   // 绝不动真实的 ~/.dsh/graph/graph.db

const { openDb, ACP_GRAPH_SCHEMA_VERSION, dispose } = await import('../lib/graph.js');
const dbFile = join(dir, 'graph', 'graph.db');

const readVersion = () => {
  const d = new DatabaseSync(dbFile, { readOnly: true });
  try { return Number(d.prepare('PRAGMA user_version').get().user_version); } finally { d.close(); }
};
const writeVersion = (v) => {
  const d = new DatabaseSync(dbFile);
  try { d.exec(`PRAGMA user_version = ${v}`); } finally { d.close(); }
};

test('openDb stamps the schema contract version', () => {
  const db = openDb();
  assert.ok(db, 'openDb must return a handle');
  db.close();
  assert.equal(readVersion(), ACP_GRAPH_SCHEMA_VERSION);
});

test('the stamp is monotonic: openDb never downgrades a newer db', () => {
  const future = ACP_GRAPH_SCHEMA_VERSION + 6;
  writeVersion(future);
  openDb().close();
  assert.equal(
    readVersion(), future,
    'openDb 把一个更新的库降级了 —— 这会让消费者的"库比消费方新"判断失效',
  );

  // 低版本仍然会被升到声明版本
  writeVersion(0);
  openDb().close();
  assert.equal(readVersion(), ACP_GRAPH_SCHEMA_VERSION);
});

test('stamping is idempotent', () => {
  openDb().close();
  openDb().close();
  assert.equal(readVersion(), ACP_GRAPH_SCHEMA_VERSION);
});

process.on('exit', () => {
  try { dispose?.(); } catch { /* best effort */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
