# dsh-session-handoff

Session handoff & context management for DeepSeek Harness — built because the
existing session-management and context-pruning plugins were written before
the latest DSH update and don't cover the full workflow.

## Why

Long sessions (like a 170k-line r32 session) hit context limits, trigger
repeated automatic compaction, and stall. Switching to a fresh session loses
all progress. This plugin fixes both halves — and more:

1. **Handoff** — export a structured, portable handoff document so a fresh
   session can continue seamlessly.
2. **Active context pruning** — compress spent history before the context
   window fills (official compaction API, model-authored summaries).
3. **Session management** — trash / restore / purge / list sessions.
4. **Model routes** — share one model id (e.g. deepseek-v4-flash) across
   several vendors/plans (official API, Ark, …) and switch between them.
5. **ACP thresholds** — tune compaction limits without touching YAML.

## Tools

### Module A — Handoff (zero dependencies)

| Tool | Purpose |
|---|---|
| `handoff_status` | Compact session overview: turns, messages, tool usage, checkpoints, context pressure |
| `handoff_export` | Parse the session into a structured Markdown handoff under `<workspace>/.dsh-handoff/` + a ready-to-run **handoff package** (OpenViking archive command, archify diagram command — only when those enhancers are present) |
| `handoff_resume` | Load the latest handoff document in a fresh session and continue |

Also `/handoff` command.

### Module B — Active Context Pruning (official compaction API)

| Tool | Purpose |
|---|---|
| `acp_status` | Usage, surface seq map, limits (soft/hard pressure level) |
| `acp_compress` | Replace an inclusive surface seq range with your summary (`ctx.compaction.compactRegion`) |
| `acp_decompress` | Read the original text hidden by a checkpoint (read-only) |
| `acp_search` | Search visible + hidden compacted history |
| `acp_config` | Show the active thresholds (soft/hard limits, preserveRecent, minTokens, nudge) |
| `acp_set_limit` | Persist new thresholds into settings.yaml (new sessions take them) |

Plus a system-prompt pressure banner that nudges the model to compress past
the soft/hard limit (`60%` / `70%` defaults), and a `compaction.summarize`
interception so model-authored summaries are used.

### Module C — Session management

| Tool | Purpose |
|---|---|
| `session_list` | List sessions (optionally including the trash) |
| `session_trash` | Archive + move a session's artifact into the plugin trash (recoverable; refuses running sessions) |
| `session_restore` | Move it back and unarchive |
| `session_purge` | Permanently delete artifact + trash entry |

Trash entries persist as JSON under `$DSH_HOME/dsh-session-handoff-trash/`
(keeps the newest 10; oldest overflow auto-purged).

### Module D — Model routes (same model, many vendors)

| Tool | Purpose |
|---|---|
| `model_routes` | List every route serving `deepseek-v4-flash`: provider, baseURL, key env + family (ark-/sk-), default marker (incl. vision-toolkit- variants), vision wrapper variant |
| `model_switch` | Point agent-default-model at a route (persisted to settings.yaml; new sessions use it). Optional `vision:true` selects the vision wrapper variant; warns when the key family is missing |

Built for users sharing one model id across official DeepSeek and Volcano
Ark plans: `model_routes` shows what is configured, `model_switch deepseek`
uses the Ark lane, `model_switch deepseek-official --vision` uses the official
lane with the vision wrapper.

### Module E — Web client (GUI)

The plugin ships a hand-written client bundle (`client/index.js`, no build
step) that registers a **Settings section "模型路由 / Model Routes"** in the
web GUI, mirroring the host tools as clickable controls:

- **Model routes panel** — every route serving `deepseek-v4-flash` (official /
  Ark / custom), key family badge, default marker, one-click "Set default"
  (with an optional vision-variant checkbox). Backed by
  `GET /dsh-session-handoff/routes` + `POST /dsh-session-handoff/switch`.
- **Session handoff** — export the current session into
  `<workspace>/.dsh-handoff/handoff-<session>.md` with one button
  (`POST /dsh-session-handoff/export`).
- **Compaction thresholds** — soft/hard limit sliders (17-90%) persisted into
  settings.yaml's `session-handoff:` section (`GET/POST /dsh-session-handoff/acp`).
  A **"推荐 / Recommend"** button computes cost-optimal limits from the real
  context window and this session's per-turn growth (carrying cost per turn vs
  one summarize call per compaction vs quality loss): hard = 90% fuse, soft =
  hard − 6 turns × growth. Same logic as the `acp_recommend` tool.

Host routes share the exact same logic as the tools (enumerateRoutes,
switchProvider, readAcpSection/writeAcpConfig, exportHandoffForAgent), so the
GUI and the agent tools can never drift.

### Soft enhancers (detected, never required)

- **OpenViking**: when `viking_*` tools are present, `handoff_export` embeds
  a ready `viking_remember` command in the handoff package.
- **archify**: when `@tt-a1i/archify-dsh` is installed, the handoff package
  includes an `archify render` command for a progress diagram.

Core works with neither installed.

## Install

```bash
dsh plugin --profile web add github:snow-The/dsh-session-handoff
# restart dsh web
```

## Usage

In the old session:

```
handoff_export   → writes .dsh-handoff/handoff-<session>.md (+ handoff package)
```

In the new session:

```
handoff_resume   → loads the handoff; continue the work
```

Before heavy work in long sessions:

```
acp_status       → check pressure
acp_compress {start} {end} {summary}   → prune spent ranges
acp_set_limit    → tune soft/hard limits proactively
```

Switching vendors for the shared model:

```
model_routes                       → see the routes
model_switch deepseek              → use the Ark lane
model_switch deepseek-official     → use the official lane
model_switch deepseek --vision     → ...with the vision wrapper
```

## Development

```bash
# unit tests (run from a profile dir so @deepseek-ai/* resolves)
node --test test/
```

## License

MIT
