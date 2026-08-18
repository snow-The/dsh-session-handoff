# dsh-session-handoff

Session handoff & context management for DeepSeek Harness — built because the
existing session-management and context-pruning plugins were written before
the latest DSH update and don't cover the full workflow.

## Why

Long sessions (like a 170k-line r32 session) hit context limits, trigger
repeated automatic compaction, and stall. Switching to a fresh session loses
all progress. This plugin fixes both halves:

1. **Handoff** — export a structured, portable handoff document so a fresh
   session can continue seamlessly.
2. **Active context pruning** — compress spent history before the context
   window fills, using the official compaction API with model-authored
   summaries (absorbed & refreshed from `dsh-active-context-pruning`).

## Features

### Module A — Handoff (zero dependencies)

| Tool | Purpose |
|---|---|
| `handoff_status` | Compact session overview: turns, messages, tool usage, checkpoints, context pressure |
| `handoff_export` | Parse the current session into a structured Markdown handoff under `<workspace>/.dsh-handoff/` |
| `handoff_resume` | Load the latest handoff document in a fresh session and continue |

Also `/handoff` command.

### Module B — Active Context Pruning (official compaction API)

| Tool | Purpose |
|---|---|
| `acp_status` | Usage, surface seq map, limits (soft/hard pressure level) |
| `acp_compress` | Replace an inclusive surface seq range with your summary (`ctx.compaction.compactRegion`) |
| `acp_decompress` | Read the original text hidden by a checkpoint (read-only) |
| `acp_search` | Search visible + hidden compacted history |

Plus a system-prompt pressure banner that nudges the model to compress past
the soft/hard limit (`60%` / `70%` defaults, configurable), and a
`compaction.summarize` interception so model-authored summaries are used.

### Module C — Soft enhancers (detected, never required)

- **OpenViking memory**: if `viking_*` tools are present, `handoff_export`
  reports it and suggests `viking_remember` for cross-session recall.
- **archify**: if the archify skill/CLI is present, `handoff_status` reports
  it so the agent can generate a progress diagram.

Core works with neither installed.

## Install

```bash
dsh plugin --profile web add github:snow-The/dsh-session-handoff
# restart dsh web
```

## Usage

In the old session:

```
handoff_export   → writes .dsh-handoff/handoff-<session>.md
```

In the new session:

```
handoff_resume   → loads the handoff; continue the work
```

Before heavy work in long sessions:

```
acp_status       → check pressure
acp_compress {start} {end} {summary}   → prune spent ranges
```

## How the defaults work

dsh-settings registers each entry's patch config as the `base` of its
settings section, so user settings.yaml always wins. Compaction thresholds
are read from the plugin config (`minContextLimit` / `maxContextLimit`).

## License

MIT
