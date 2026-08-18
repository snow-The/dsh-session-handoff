# Changelog

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
