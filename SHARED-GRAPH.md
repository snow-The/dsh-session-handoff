# One shared graph for multi-context and multi-agent analysis

## 1. Today: three stores, two algorithms, one of them empty

| store | size now | owner | what it holds |
|---|---|---|---|
| `~/.dsh/graph/graph.db` | **24.9 MB** | dsh-session-handoff | the authoritative cross-session graph: `nodes`, `edges` (196k), `checkpoints` (495), `checkpoint_nodes`, FTS5 over nodes/checkpoints/docs, `block_originals` |
| `~/.dsh/notemap/graph.db` | **4 KB** | dsh-notemap | a *copy* of the ACP graph, imported on demand; carries its own relation algorithms (weights, confidence, PageRank, communities) |
| `~/.dsh/memory/memory.db` | 61 KB | dsh-acp-memory | the seven-layer memory (soul/user/project/fact/lesson/topic/rules) |

Two graphs is a duplication problem: notemap `importFromAcpGraph()` copies what ACP already owns, the copies drift, and there are two relation algorithms to keep consistent. The user's ask — *"multi-context and multi-agent analysed together, with one shared graph-relation algorithm"* — is exactly the fix for this.

## 2. Target: one store, three additive tables, one algorithm

Keep `~/.dsh/graph/graph.db` as the **only** graph. Add what analysis across contexts and agents actually needs — provenance, canonical identity, and the delegation tree — with `CREATE TABLE IF NOT EXISTS`, so nothing existing is rewritten:

```sql
-- one row per session/agent that contributed anything (the multi-context axis)
sources(id INTEGER PRIMARY KEY, session_id TEXT UNIQUE, parent_session TEXT,
        agent_kind TEXT,            -- 'main' | 'subagent'
        cwd TEXT, label TEXT, created_at INTEGER, last_seen INTEGER)

-- which source mentioned which node, where (the raw material for consensus)
mentions(source_id INTEGER, node_id TEXT, checkpoint_seq INTEGER,
         count INTEGER, first_seen INTEGER, last_seen INTEGER,
         PRIMARY KEY (source_id, node_id, checkpoint_seq))

-- entity canonicalisation: aliases collapse to one node
aliases(alias TEXT PRIMARY KEY, node_id TEXT, kind TEXT, created_at INTEGER)

-- the agent tree as edges (parent delegates to child)
delegations(parent_source INTEGER, child_source INTEGER,
            PRIMARY KEY (parent_source, child_source))
```

`parent_session` and `agent_kind` come straight from each session header (`parentSession`,
`origin: 'subagent'`, `delegationDepth`), so the multi-agent structure is already on disk —
it just was never materialised into the graph.

## 3. The shared relation algorithm

One module, used by both plugins (and by anything else that wants to read the graph):

```
recall(query, { sources?, agentScope?, depth = 2, limit = 10 })
```

| stage | what it does | why it matters here |
|---|---|---|
| 1 candidates | FTS5 BM25 over `node` titles, `checkpoint` summaries and (optionally) `docs` | unchanged from today |
| 2 per-source ranking | rank the candidates **within each `source_id`** | each session/agent becomes a voter — this is the multi-agent dimension |
| 3 fusion | reciprocal rank fusion over the per-source lists, `score = Σ 1/(60 + rank_s(n))` | a node ranked highly by *several* agents beats one ranked highly by a single chatty agent |
| 4 consensus boost | `×(1 + log(1 + distinct_sources))` | the explicitly multi-context signal: "three agents independently arrived at this" |
| 5 confidence | β-prior over mentions: `(prior·w + mentions)/(w + mentions)`, w = 100 | already used by the graph; now fed by `mentions` instead of a global counter |
| 6 expansion | BFS `depth` hops, weight = `edge.weight × edge.confidence × recency(last_seen)`, hop decay 0.5 | finds related entities a pure text search misses |
| 7 authority | PageRank over the whole graph (or the selected agent subtree) | "what matters overall", independent of the query |
| 8 agent scope | when scoped to one agent, optionally traverse `delegations` downward with a hop penalty | a main agent can ask "what did my workers find" in one call |
| 9 output | every hit carries provenance: `sources: [{session, agent_kind, count}]` plus the linking path | explainable, and it is what makes "analysed together" visible |

Notes that keep it honest:

* **Fusion needs lists, not scores.** BM25 scores are not comparable across sources;
  RRF only needs ranks, which is why stage 3 is RRF and not a weighted sum.
* **Consensus is a boost, not a gate.** A single agent's unique finding must still be
  retrievable — it just does not outrank a cross-agent consensus.
* **Canonicalisation is explicit.** `aliases` is written by ingest (normalising case,
  separators, plurals) and can be corrected by hand; no fuzzy merging that silently
  fuses two different things.

## 4. Who owns what (decided 2026-09-11)

The owner's decision: **notemap depends on BOTH handoff and memory.**

```
handoff  (dsh-session-handoff)  ->  COLLECT + ORGANIZE
    session logs -> checkpoints -> entities -> the authoritative graph,
    plus provenance (sources / mentions / aliases / delegations)

memory   (dsh-acp-memory)       ->  PROCESS + USE
    seven layers: capture on turn/end, recall + inject per turn,
    distillation; the "what did I learn" axis

notemap  (dsh-notemap)          ->  RELATE
    turns their LINEAR structures (a checkpoint sequence, a list of layers, a session
    timeline) into a NODE NETWORK: typed nodes, weighted/confidence-scored edges,
    and the relation algorithms (paths, centrality, PageRank, communities, fusion).
```

| component | owner | consumers |
|---|---|---|
| session ingest, checkpoints, entity extraction, provenance tables | **handoff** | everyone (it is the only writer) |
| seven-layer memory, capture / recall / inject | **memory** | notemap reads the layers; agents use the tools |
| node-network materialisation + relation algorithms + fusion ranking | **notemap** | its own tools; handoff keeps only simple lookups |
| `acp_*` memory tools | handoff | unchanged |
| `memory_*` tools | memory | unchanged |
| `notemap_*` tools | notemap | unchanged surface, now backed by the shared store |

Dependency direction (acyclic, verified in the code today - all three declare **zero**
package dependencies on each other and couple only through SQLite files):

```
notemap ──depends on──▶ handoff   (read: graph.db + provenance)
   └────depends on──▶ memory      (read: memory.db layers)
memory  ──reads────▶ handoff      (read-only: graph.db, already the case)
handoff ──owns────▶ sessions/ + graph.db
```

Because the algorithm lives in **notemap** (the relation layer), there is no new shared
package: notemap's node-network view is derived data that can be rebuilt from the two
stores at any time. If it is deleted, nothing is lost.

## 5. Staged implementation (each stage is shippable and reversible)

1. **S1 - provenance tables + backfill.** Add the four tables; backfill `sources` from
   every session file header found under `~/.dsh/sessions` (id, parent, kind, cwd) and
   `mentions` from the existing `checkpoint_nodes` rows. Additive; existing queries
   untouched. *Verify: row counts match today's nodes/checkpoints; no existing tool
   changes behaviour.*
2. **S2 - the shared algorithm + `graph_recall`.** Implement stages 1-9 in one module,
   expose `graph_recall` (with provenance in the result) and `graph_agents` (the agent
   tree with per-agent contribution counts). *Verify: a query that spans a main session
   and its subagents returns hits annotated with both sources.*
3. **S3 - notemap switches.** `notemap_*` read/write the shared store; delete
   `importFromAcpGraph` and the private DB. *Verify: identical query results before and
   after on a fixed corpus.*
4. **S4 - canonicalisation + agent scope.** `aliases` written at ingest, a manual
   `graph_merge` tool, and `agentScope` traversal in `recall`.

## 6. Open questions for the owner

* Should `acp-memory`'s seven-layer memory become nodes in the same graph (one store
  for everything), or stay a separate small store keyed by the same session ids? The
  layered store answers "what did I learn", the graph answers "what is related" — they
  can share the `sources` table without sharing tables.
* Retention: `mentions` grows with checkpoints × entities. It is small compared with
  `block_originals`, but a per-source cap or a vacuum policy may be wanted later.
* Does "multi-context" also mean *other workspaces*? The graph is global today, so yes —
  `sources.cwd` is what lets a query say "only this project".
