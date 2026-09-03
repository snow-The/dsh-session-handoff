# dsh-session-handoff — ACP Graph Layer Design (v0.1)

> Active Context Pruning → Graph-Aware Long-Term Memory.
> Keeps DSH-native compaction fully pluggable; adds a high-performance
> project-agnostic graph index under ~/.dsh as a sidecar.

## 1. Goals

1. **Pluggable**: the core `acp_compress`/`acp_decompress`/`acp_search` tools keep
   calling the DSH-native `compaction.compactRegion()` service and keep emitting
   `compaction/summary` session events. Nothing about the native contract changes —
   the graph layer is a read-only consumer of those events.
2. **Graph-aware**: after many compactions, the session is a chain of summaries with
   no cross-linkage. The graph layer extracts entities from each summary and links
   them, so "which checkpoints mention `dsh-llm-pi-ai`" or "how do the ARK fixes
   relate to the notemap work" can be answered across compaction boundaries.
3. **Three-tier storage** (user decision):
   - **L1 one-shot**: the acp_* tools themselves — ephemeral, in-session, native.
   - **L2 project wiki**: high-performance SQLite graph index under `~/.dsh/` (global,
     because it is generic processing) using `node:sqlite` (Node 22+ builtin,
     same style as dsh-research-lab).
   - **L3 DSH-native long-term memory**: `compaction/summary` events already persisted
     in session.jsonl — authoritative, rebuildable, native-readable.

## 2. Clarification: "ACP" is not packages/acp

The official `packages/acp` in deepseek-harness is the **Agent Client Protocol**
(MCP-family, `agent_thought_chunk`/McpServer). The Active-Context-Pruning
feature here is the `acp_*` toolset in dsh-session-handoff built on
`@deepseek-ai/dsh-compaction-basic` (the `compactSurfaceRegion` service and its
`compaction/summary` events). This design is about the latter.

## 3. Native contract we must preserve (L1)

`acp_compress` today:
```ts
const result = await compaction.compactRegion(start, end, agent, exec.signal);
// emits compaction/summary session event with { shadowedRange, shadowedSeqs }
```
- Range validation via `assertSafeRange` (preserveRecent tail).
- minTokens gate via tokenMeter.
- The graph layer hooks **after** the native call, reading the produced summary.

## 4. L2 Graph store — `~/.dsh/graph/`

Layout (mirrors lab's `.rlab/` discipline):
```
~/.dsh/graph/
  graph.db        # SQLite (node:sqlite)
  checkpoints/    # optional JSON sidecar per compaction (for manual diffing)
  watermarks.json # idempotent rebuild watermark per session file
```

### Schema (SQLite)

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,          -- entity id (lowercased, normalized)
  kind        TEXT NOT NULL,             -- 'file' | 'function' | 'concept' | 'decision' | 'session'
  title       TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,          -- session seq of first mention
  last_seen   INTEGER NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS edges (
  source   TEXT NOT NULL REFERENCES nodes(id),
  target   TEXT NOT NULL REFERENCES nodes(id),
  relation TEXT NOT NULL,                -- 'co-occurs' | 'parent' | 'calls' | 'causes'
  weight   REAL NOT NULL DEFAULT 1.0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (source, target, relation)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  seq_start   INTEGER NOT NULL,
  seq_end     INTEGER NOT NULL,
  summary     TEXT NOT NULL,             -- the compaction/summary text
  session_id  TEXT NOT NULL,
  shadowed_seqs TEXT NOT NULL,           -- JSON array
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq_start, seq_end)
);

CREATE TABLE IF NOT EXISTS checkpoint_nodes (
  checkpoint_seq INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  PRIMARY KEY (checkpoint_seq, node_id)
);
```

### Entity extraction (w8-style TS NLP, zero-dep)

- Tokenize summary text (English words + Chinese n-grams).
- Detect entity kinds:
  - `file` — paths and `pkg/file.ext` tokens (`src/config.ts`, `dsh-llm-pi-ai`)
  - `function` — `name(` or `name` followed by word boundary in code-ish text
  - `concept` — high-TF-IDF terms (per-corpus, same approach as lab's related.ts)
  - `decision` — sentences matching /(decided|fix|root cause|chose|reverted|B|C)/i
- This is intentionally heuristic; the agent can also write explicit
  `[entities: a,b,c]` markers in the summary to seed nodes deterministically.

## 5. Tools

### New: `acp_graph`
- `acp_graph build [--force]` — scan session.jsonl `compaction/summary` events,
  extract entities, upsert nodes/edges. Idempotent via watermark.
- `acp_graph recall <query>` — BM25/FTS over node titles + checkpoint summaries,
  then expand through edges (BFS 1-2 hops). Returns node list + which checkpoints mention them.
- `acp_graph related <node>` — neighborhood rank (weight × recency).
- `acp_graph stats` — node/edge/checkpoint counts.
- `acp_graph export` — dump graph as DSH-native event(s) (see L3).

### Enhanced: `acp_search`
- After substring hits on the linear surface, also consult the graph: if the query
  matches an entity, list every checkpoint (summary) that mentions it — recovering
  cross-compaction context the linear search cannot see.

### Enhanced: `acp_recommend`
- Add a graph-degree term: entities with high degree and high recency are flagged as
  "hot" — when choosing a compress range, prefer to keep the context where hot
  entities live (or at least record them in the summary so they survive).

## 6. L3 — DSH-native long-term memory

- The source of truth stays `compaction/summary` events in session.jsonl.
- `acp_graph build` is a **read** of those events → sidecar SQLite index.
- `acp_graph export` can emit a synthetic `memory/graph-snapshot` event (custom type)
  or write a handoff markdown; both stay DSH-native readable.
- The SQLite DB is disposable: delete it and rebuild from session.jsonl.

## 7. notemap downgrade (depends on ACP)

- dsh-notemap stops maintaining an independent graph.
- It becomes a consumer: reads `acp_graph` results, renders the graph (canvas/UI),
  and can drive `acp_graph build` after each session.
- Its `notemap_*` tools become thin aliases over `acp_graph` (or delegate).

## 8. lab reverse-dependency

- dsh-research-lab's `rlab_related` / `rlab_status` can call `acp_graph recall`
  to fuse cross-project session memory with project wiki pages.
- Optional: `rlab_absorb` already sinks reports into `.rlab`; a new hook sinks
  `acp_graph` checkpoints into the project wiki as `literature` pages.

## 9. Implementation order

1. L1 preserved (verify no regression).
2. `graph.ts` — SQLite schema + entity extraction (node:sqlite, w8 NLP).
3. `acp_graph` tools (build/recall/related/stats/export).
4. `acp_search` graph augmentation.
5. `acp_recommend` hot-entity term.
6. notemap downgrade + lab reverse-dep.

## 10. Open questions (defer)

- Node version on this host: confirm `node:sqlite` availability (Node ≥ 22.5).
- Whether `acp_graph` should auto-build on each `agent/pre-step` (cheap watermark
  check) or only on demand.
- Cross-session merge policy for nodes with the same id (merge counts vs keep both).
