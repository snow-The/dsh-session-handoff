# Changelog

## v0.17.5

- **Combobox items are now pickable.** The suggestion popup relies on the
  input keeping focus (`:focus-within`), and the host shell can blur the input
  on mousedown — which hid the list before a `click` could fire, so clicking a
  suggestion did nothing. Items now apply on `onMouseDown` (with
  `preventDefault`, before any blur) with `click` kept as a fallback, so a
  suggestion always lands in the model field.

## v0.17.4

- **Model picker candidates for built-in routes.** `deepseek-official` and
  other routes without registered models now get a non-empty suggestion list:
  the union of every route's registered models + provider-known defaults
  (`deepseek-official` → `deepseek-chat` / `deepseek-reasoner`) + the chat's
  current model + the pinned model, deduped. The combobox (v0.17.3) always has
  something to show on focus; typing still filters, and free text is accepted.

## v0.17.0

- **Per-route model + reasoning effort.** A failover route is now
  `provider[:model[:effort]]` — the panel has a model dropdown (the
  provider's registered models, or blank = follow the chat's model) and a
  reasoning-effort dropdown (max/high/medium/low/none, or blank = follow
  current) on every route. On failover the rebuilt request applies the pinned
  model / effort (true cross-model switching).
- `model_switch` and the `/switch` route accept optional `model` /
  `reasoningEffort` and preserve the current default's effort (no more
  hard-coded `max`).
- Settings line format is backward compatible: `failoverRoutes:
  deepseek,deepseek-official` still works (each entry just provider).
- New tests: entry parse/format, `provider:model:effort` persistence,
  per-route override applied on switch. 48 tests total.

## v0.16.0

- **Generic routes — no fixed model id.** Every registered provider route
  (llm directory + `llm-pi-ai.providers.*` + built-ins, incl. any
  vision-toolkit wrappers) is a first-class route you can order, switch to,
  and fail over to. `model_switch` now preserves the currently selected model
  instead of forcing `deepseek-v4-flash`. Tool descriptions and panel copy
  are model-agnostic ("registered route").
- **Failover alternation fixed (real bug caught by the new test).** The
  tried-provider set is now preserved across the error → request → error
  cycle, so a second failure advances to the *next* route (A→B→C) instead of
  looping back to the first (A→B→A→B…). Entries are TTL-pruned (10 min) to
  bound memory.
- **New installFailover tests** drive the full event chain
  (`agent/request-error` → retry → `agent/request` rebind): a→b→c
  alternation, interruption never switches, non-failover codes ignored,
  safe no-op without an event bus. 45 tests total.

## v0.15.0

- **Chat model list is the source of truth** (no self-configured vision
  model): the routes panel/tool reads the running session's
  `requestContext()` — the model actually last chosen in the chat dialog —
  and derives the candidate pool from the live `llm` directory
  (`ctx.llm.listProviders()`), so vision-toolkit wrapper providers appear
  naturally as ordinary sortable entries. Ordering is entirely the user's job.
- `model_switch` no longer recommends/writes a vision wrapper — it points
  agent-default-model at exactly the provider you pick. Failover stays dumb
  and predictable: on a failed step it tries the next provider in the saved
  priority list in order (`failoverRoutes`), skipping only what already
  failed this step; user interruptions never switch.

## v0.14.0

- **Provider failover (auto route switching)** — the core ask: a priority
  list of routes in settings.yaml (`session-handoff.failoverRoutes: a,b,c`,
  order = priority). When a model request fails because the active provider
  is unreachable or out of quota (`QUOTA` / `RATE_LIMIT` / `SERVER` /
  `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE` / `AUTH` / credential / adapter
  errors), the next route is tried automatically and the step continues.
  User interruptions (aborted signals) NEVER fail over. Wired through the
  official extension points: `agent/request-error` (return `{kind:"retry"}`)
  + `agent/request` (override the provider in the seed call config, so
  `prepareCall` rebinds the adapter). Every switch is recorded as an
  `llm/failover` session event.
- **Priority list UI** (replaces the v0.13 carousel): vertical list with
  drag-to-reorder rows, delete (✕) per row, add-from-pool select, and a
  "save priority" button (`GET|POST /dsh-session-handoff/failover`). The
  "set default" (agent-default-model) button stays per row.
- `failover_config` / `failover_set` tools for the agent. Unit tests (7).

## v0.13.0

- **Fix "method-not-allowed" on saving thresholds**: `/acp` was registered
  twice (GET + POST) on the same exact path; the webServer keeps a single
  handler per exact path, so POST fell through to the GET handler. The route
  is now registered once and dispatches on `req.method` internally.
- **Fixed recommendation (no more computation)**: the "推荐 / Recommend"
  button fills soft 65 / hard 90 directly (deepseek-v4-flash is a 1M-window
  model); the host `/recommend` route and `acp_recommend` tool remain for
  agent-side use.
- **Model routes carousel**: the routes list is now one route per slide with
  swipe (scroll-snap), ‹ › arrows and numbered dots (1 2 3 …) for the
  small-window "1234" paging the GUI asked for.

## v0.11.0

- **Cost-optimal ACP threshold recommendation**: `acp_recommend` tool +
  `POST /dsh-session-handoff/recommend` + a "推荐 / Recommend" button next to
  the threshold sliders. Model: carrying cost per turn vs one summarize call
  per compaction vs quality loss; hard = 90% fuse (minus a 2×growth burst
  margin), soft = hard − 6 turns × measured per-turn growth (real session
  growth from tokenMeter, character-estimate fallback). Unit tests (6).

## v0.10.0

- **Web client (GUI)**: hand-written `client/index.js` bundle (no build
  step) registering a Settings section "模型路由 / Model Routes":
  model routes panel with one-click default switch (+ vision variant),
  session handoff export button, ACP threshold sliders (17-90%).
- Host HTTP routes (`/dsh-session-handoff/{routes,switch,acp,export}`)
  sharing the exact tool logic (enumerateRoutes/switchProvider/
  readAcpSection/writeAcpConfig/exportHandoffForAgent).
- `dsh.client` + `exports["./client"]` in package.json.

## v0.8.0 (unreleased)

- README rewritten to cover all four modules (handoff, ACP, session
  management, model routes) + soft enhancers + usage recipes.

## v0.7.0

- ACP threshold config: `acp_config` + `acp_set_limit` (persist soft/hard
  limits, preserveRecent, minTokens, nudge into settings.yaml
  `session-handoff:` section; quote-tolerant reader; validation).
- Unit tests for acp-config (5).

## v0.6.0

- Unit tests for session-mgmt (id validation, trash persistence + limit
  overflow, purge) and model-routes (settings parsing, route enumeration).
- model-routes.js exports internals for testing. 20 tests total.

## v0.5.0

- Model routes: `model_routes` (every route serving deepseek-v4-flash:
  baseURL, key env + family, default marker incl. vision-toolkit- variants,
  vision wrapper) and `model_switch` (persist agent-default-model to a
  route; optional vision:true; missing-key warning).

## v0.4.0

- Session management: `session_list` / `session_trash` / `session_restore` /
  `session_purge` on the official session services. Trash persists as JSON
  under $DSH_HOME/dsh-session-handoff-trash (TRASH_LIMIT 10). Zero
  third-party deps.

## v0.3.0

- Unit tests for handoff + ACP internals (`__internals` export): event
  summarization, pressure math, surface range safety, handoff doc structure
  (12 tests). `.gitignore`.

## v0.2.0

- Handoff package: ready-to-run OpenViking `viking_remember` command and
  archify `render` command embedded in handoff documents when those
  enhancers are detected.

## v0.1.0

- Initial release: `handoff_status` / `handoff_export` / `handoff_resume`,
  `acp_status` / `acp_compress` / `acp_decompress` / `acp_search`, system
  prompt pressure banner, `compaction.summarize` interception, `/handoff`
  and `/acp` commands.
