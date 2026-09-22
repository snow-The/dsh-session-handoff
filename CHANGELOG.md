# Changelog

## v0.18.11

- fix(config): `cacheMissPricePerMTokens` — the ABSOLUTE price behind every CNY figure in the journal —
  was read by the loss formula and settable **nowhere**: absent from DEFAULTS, so `readSection` dropped
  it from settings.yaml silently and the function fell back to 1. The advice "set it to 2 for peak
  hours" therefore did nothing. It is a real key now (DEFAULTS, coercion, the write block, acp_config,
  acp_set_limit and resolveConfig), so the peak/off-peak difference is data. `cacheHitPriceRatio` stays
  the RATIO, which does not move with the hour (0.02/1 = 0.04/2).
- note: this is the THIRD key found in the same shape — read by code, missing from DEFAULTS, silently
  unsettable from settings.yaml (`hostTrigger`/`hostTriggerAt` were the first, `compressTargetRatio` was
  dropped on every write). A key that exists only in `resolveConfig` is a key the user cannot configure.
- test: 107/107.
## v0.18.10

- feat(guard): a fold must remove at least `minFoldRatio` (default **10%** of the context) or it is
  refused, with the arithmetic in the message. Motivated by the probe that verified the snap-down
  retry: folding 596 tokens of a 507k context answered "the next call re-sends ~507,508 tokens uncached
  (≈0.497)" — one full-prefix miss to save ~12 tokens per request, a **41,700-request payback**.
  Break-even is ~49 x (context / folded) later requests, so a cosmetic fold never pays; the error names
  the way out (`deep:true` or a wider range). The same check runs on the SNAPPED range too, because a
  retry is smaller than the request and could otherwise pay a full miss for a sub-economic fold.
- note(verified live): the snap-down retry works end to end. A deliberately unbalanced `end` (a seq that
  opens a tool call) was refused by the core and the plugin folded 20757-20764 instead: 3 nodes,
  508,104 -> 507,508, reported as "end 20765 split a step: folded DOWN to the balanced boundary 20764
  instead". The journal row priced it on the POST-fold context (lossTokens == after) and the M1 block
  store kept the original (`blocks saved: 1`).
- known gap (recorded, not papered over): the MEASURED half of the bill — `settle` rows and the L2 cache
  line — reads `storages/session_projcache.json`, and a LIVE session has no row there yet (checked: this
  session and the one that folded twice are both absent; the store is written by the harness's
  projection cache at ITS checkpoints). So `L3 measured` currently reads "no settled fold bill yet" for
  an active session. The live service is `ctx.sessionProjectionCache.recordFor(id, identity)`, which
  needs the log-identity witness; the self-contained alternative is to aggregate the per-attempt usage
  the session log already carries. Either is a real change, not a constant — it is next, not hidden.
- test: 106/106 — the share guard is pinned both ways (refused with arithmetic, and a 49% fold passing).
## v0.18.9

- fix(price): `CACHE_HIT_PRICE_RATIO` was 0.1. DeepSeek's published table (2026-09) is **0.02 / 1 CNY**
  per million input tokens off-peak and **0.04 / 2** peak — a cache hit costs **2%** of a miss at either
  hour. The constant weights the CARRYING term (cache reads) against the FOLDING term (one full miss),
  so being 5x too expensive on the hit side made carrying look 5x worse than it is and INVERTED the
  advice it fed: the "lower the soft trigger to 50-60%" proposal of the previous round is a net LOSS at
  2% (the carrying it saves is 5x smaller than that estimate, and each extra fold costs relatively 5x
  more). **Retracted**; the standing advice is fewer, later, deeper folds — what `acp-recommend` already
  said, now for the right reason.
- note: the per-fold money estimate barely moved (the factor is `1 - ratio`: 0.9 -> 0.98, ~9% higher).
  What moves by 5x is the reported SPLIT in `formatCacheLine`: for session-f20d1471 the same counters
  now read "misses are 43% of prompt cost" instead of 13%.
- feat(config): `cacheHitPriceRatio` is a setting (default 0.02). Prices are DATA — a provider or plan
  change must not need a code edit — and the peak/off-peak doubling does not move the ratio at all.
- test: 104/104. The ratio, the `(miss - hit)` formula, the peak-price case and the reported split are
  pinned; the two pre-existing assertions that encoded 0.9 were updated with the table as the reason.
  They caught the change, which is exactly what they were for.
## v0.18.8

- fix(compress): the v0.18.7 retry moved a refused `end` to the boundary `end: 'auto'` picks — the one
  nearest the preserved TAIL — so a caller asking for a SMALL range could have had far more folded than
  it asked for. The note in that release ("can only ever fold LESS") was wrong about its own code. The
  retry now snaps DOWN: `lib/pairing.js` replicates the core rule ("no unanswered tool call crosses the
  cut", the same predicate `dsh-compaction` enforces) and picks the nearest balanced cut at or BEFORE
  the requested end, so the fold is always a SUBSET of the request. Nothing balanced inside the range
  means the original refusal stands — the plugin never invents a range.
- note(measured, shrink): with `shrinkWindowNodes: 16` + `shrinkProtectedTail: 4` the deterministic
  shrink is a TAIL tool by design, and a live call confirmed it: "nothing to shrink". That is correct
  and not a defect — the bulk of shrinkable text sits deep in history, and shrinking a node N back
  re-bills every token AFTER it (~180k miss-equivalents on a heavy session) to free ~100 equivalents
  per request. What pays is a giant FRESH dump near the tail (the archive's largest single result was
  49,899 chars ≈ 12k tokens: shrinking it early saves ~1.2k equivalents on every later request). Its
  value is therefore real but occasional, and it does nothing for a session that emits curated output.
- test: 102/102 — the pairing rule, the snap-down direction and the refusal-still-stands case are pinned.
## v0.18.7

- fix(banner): the quiet line no longer prints **how far the trigger is**. Evidence from the r32
  session: with `soft trigger 780000 (7k ahead; ...)` on screen the agent wrote "Budget: ~7k tokens
  before the soft trigger — I'm at the limit ✓", wrapped the turn up and promised a compaction next
  turn. The session was hovering 4-9k BELOW the trigger (121 banners, not one of them "past"), so the
  host never fired and nothing happened — read as a budget, the distance made the agent stop short of
  the thing it was describing. A small number next to a limit word gets read as runway whatever
  preposition follows it, so the line now carries the STATE and the denial only:
  `soft trigger 780000 (fold when you pass it, it is not a cap)` / `… (passed - fold now; not a cap)`.
- fix(compress): a fold refused for splitting a step is **retried once** at the balanced boundary
  `end: 'auto'` would have chosen, instead of ending as an error. Session 593a7635's last fold attempt
  died exactly there (`end seq 14400 is not a balanced boundary (would split a step, or the step is
  still open)`) right after the agent had told the user a compaction was coming. The retry can only
  ever fold LESS than the caller asked for (the boundary is at or before the refused end) and it says
  so in the tool's answer: `end N split a step: folded to the balanced boundary M instead`.
- test: 99/99 — the retry is pinned by a compaction stub that refuses the first call.
## v0.18.6

- fix(shrink): the first cut took the **oldest** eligible tool result — the expensive end. A
  replacement invalidates the provider prefix from the changed node **onward**, so the re-bill grows
  with the distance from the tail: rewriting a result 2000 nodes back re-bills nearly the whole
  context (~360k miss-equivalents on a heavy session) to free ~1k tokens of carry (~104 equivalents
  per request). The scan is NEWEST-first inside a bounded `shrinkWindowNodes` (default 16), which
  keeps the re-billed region to a few nodes; older bulk is left to the next fold, which pays one miss
  for everything.
- fix(shrink): `shrinkMinTokens` defaulted to 3000 **tokens** (~12k chars). Measured over a heavy
  session's 3852 tool results (p50 586 chars, p75 1171, p90 2255, p95 3244, p99 7260, max 49899) that
  sits above p99 and almost never fires — in a 170-result session it matched exactly one node. The
  default is now 800 tokens (~3200 chars ≈ p95), where a head+tail shrink still reaches ~25% of all
  tool text; the 1600-char keep budget caps the achievable yield near 30%, so pushing the threshold
  lower buys little and costs a surface write per result.
- note(measurement): why the default was wrong — the distribution was measured AFTER v0.18.5 shipped,
  and it disagreed with the guess in both the unit and the order. Neither default had ever fired in
  production (no `kind: 'shrink'` row), so the correction costs nothing retroactively.
- test: 98/98 — the ordering (newest first), the window and the limit (cheapest candidate, not the
  oldest) are pinned.
## v0.18.5

- feat(shrink): **deterministic tool-result shrink** (`lib/shrink.js`) — head, tail and a marker that
  names the seq still holding the original, written with NO model call, no summary and no surface-wide
  fold. Measured on our two heaviest sessions, 79-87% of billed prompt tokens were cache reads
  re-sending context (f20d1471: 3.51B cached vs 52.5M uncached; b0e810e7: 1.53B vs 41.4M) against
  ~0.27M miss-equivalents for one fold — so the lever is the carried SIZE, and an already-read tool
  dump is the cheapest thing to cut. It runs on the pre-step before the fold decision, and is exposed
  as `acp_shrink` for a manual batch. Guards: only `tool/result`; only at least `shrinkMinTokens`;
  never within the last `shrinkProtectedTail` nodes (the live tail is what the agent is reasoning
  about); never a block holding an image; never one that already carries the marker; at most
  `shrinkMaxPerStep` per pass.
- fix(shrink): `isShrunkContent` tested `startsWith` while the marker sits AFTER the head, so the
  "already shrunk" guard could never fire — the same result would have been cut again on every pass.
  The test caught it; it is a substring test now.
- note(contract): the replacement event shape was verified against the REAL session validator, not
  against a reading of it: constructing a real `Session`, appending a tool result, then appending the
  replacement is ACCEPTED (surface [0,1] -> [0,2], derived text 20,000 -> 1,658 chars), while changing
  the message id instead is refused with "tool/result surface replacement may change only content".
  A one-node rewrite of the same type with only the content changed is the single form the contract
  allows, and it is the form that keeps the prefix cache intact.
- feat(metrics): shrink rows are neither folds nor settles (`kind: 'shrink'`, with before/after/freed),
  are counted separately in `pooledSummary`, and print as their own L3 line — folding them into the
  compaction count would misstate the summary calls, the cache misses and the quality loss at once.
- test: 98/98.
## v0.18.4

- fix(policy): **the host now owns the trigger** — `hostTriggerAt` defaults to `soft`, so the host folds
  when the trigger is passed instead of waiting for an agent that may stall. The model cannot be the
  trigger: that makes the policy depend on it reading a number correctly, and the same complaint came
  back three times (73% read as 100%; the soft limit read as the whole budget; then agents stopping to
  ask the user to authorize compaction). Between the trigger and the ceiling nothing else fired, and
  that gap is exactly where a stalled agent sits. The model still owns the RANGE whenever it folds
  earlier than the trigger, so the normal `acp_compress` path is unchanged.
- fix(metrics): the fold's cache price was taken from the **PRE**-fold prompt, while the cost falls on
  the NEXT call, whose context is the **POST**-fold one (`docs/PREFIX-CACHE-STUDY.md` §3). Every row
  therefore overstated its own fold by that fold's shrink factor. Measured on the eight rows in the
  journal: 6,073,560 tokens / 5.465 CNY claimed against 1,707,791 / ~1.537 CNY on the honest base —
  **3.56x**. Rows written before this version keep the old base; the L3 line now says which is which.
- feat(metrics): the bill is **measured**, not predicted. A fold snapshots the session's cumulative
  cache counters (`storages/session_projcache.json` — cumulative and disjoint) and the next pre-step
  journals the delta as its own `kind: 'settle'` row (`uncachedTokens` / `cachedTokens` /
  `estimatedTokens`). Fold sums go through `foldRows()`, so a settle row never counts as a fold, never
  adds a second loss figure for the same event, and never turns "the gap between the last two folds"
  into the milliseconds between a fold and its own settle row. L3 prints the estimate and the measured
  bill as two labelled lines, and an unsettled fold reads as "not measured yet", never as a zero bill.
- test: 93/93 — the settle row shape, the once-only settle, the fold-only sums and the L4 gap are pinned.
## v0.18.3

- fix(banner): the per-turn ACP line said **"soft limit 780000 — ~24k left"**, and agents read that as
  *their remaining context*: near the trigger they went conservative and stopped a turn early. The room
  number now hangs off the HARD ceiling ("hard ceiling 900000 — 170k of room") and the soft number is
  named for what it is — "soft trigger 780000 (50k ahead; fold when you pass it, **it is not a cap**)".
  One number answers "how much room do I have"; the other answers "when do I fold".
- fix(banner): the action sentence was the constant "below soft limit, no compaction needed" — printed
  even PAST the trigger, because the level was computed in quiet mode and then never read. It now
  follows the level: below -> keep working; past the trigger -> fold now with acp_compress end:auto;
  past the ceiling -> compress before any other work. The contradiction with the instruction section
  (which says to fold when the trigger is passed) is what left agents stopping to ask the user to
  authorize compaction.
- fix(instructions): the ACP section now names the two thresholds as different kinds of thing — the soft
  limit is a TRIGGER you own, the hard limit is the CAP on the window — and grants standing authority
  explicitly: folding is your own call, never a question for the user, never a turn spent waiting for
  permission (it is reversible; acp_decompress returns the original text). Same naming in acp_status,
  acp_config and acp_set_limit, so the tools cannot reintroduce the "soft limit = the limit" reading.
- test: 88/88. The quiet-banner contract test pins the live config (78%/90% — the code default is
  60%/60%, where every "room" assertion degenerates to "reached" and proves nothing), forbids the
  soft-limit-as-remaining-context shape, and adds past-trigger / past-ceiling cases.
- fix(config): `hostTrigger` / `hostTriggerAt` existed in `resolveConfig` but were **absent from
  DEFAULTS** — and `readSection` reads only the keys it finds there, so settings.yaml could not move
  the host-fold fuse at all: the trigger stayed pinned to 'hard'. Between the soft trigger and the
  ceiling the MODEL was then the only thing that could compact, which is precisely the gap where
  agents stalled and asked the user to authorize compaction. Both keys are configurable now
  (`hostTriggerAt: soft` hands the trigger to the host, taking the model out of the loop) and are
  shown by acp_config / acp_set_limit.
- fix(config): `writeAcpConfig` rebuilt the section from a fixed template that omitted
  `compressTargetRatio`, so ANY acp_set_limit call silently deleted a configured deep-fold target. It
  now writes every key it reads, and the ratio is parsed as a fraction (unusable value -> default)
  instead of being carried around as a string.
- test: 90/90 — the fuse round-trip and the unreadable-value fallback are pinned.

## v0.18.2

- fix(graph): `acp_graph build` carried the SAME `session.events` bug as the two metric fields, in its
  own copy of the read. Its fallback — documented as covering "non-zstd / plaintext sessions" — read a
  property a harness session does not have, and the ternary had the same expression in both branches.
  The fallback could never run, so `build` reported "+0 checkpoint(s)" whenever the session file held no
  events: a number that reads exactly like "this session had none".
- refactor(session-events): the accessor now has ONE owner, `lib/session-events.js`, imported by both
  index.js and graph.js. Two owners is how the second, broken reader came to exist at all: index.js held
  the correct helper with a comment explaining the missing property, while graph.js — a separate module
  that could not see it — read the property directly.
- test: `test/graph-build.test.mjs` boots the plugin and builds from a session stub that exposes ONLY
  `ownEvents()`; restoring the `.events` read turns it red. 86/86.

## v0.18.1

- fix(metrics): the first REAL journal row showed two fields that were not measurements.
  - `userMsgs` read `agent.session.events` - a property a harness session does not have (this module
    documents that fact a few lines above the helper). L4's "user turns so far" was therefore ALWAYS 0,
    and the first real row proved it: `userMsgs: 0` for a session with 810k tokens of history. It now
    goes through the same `sessionEvents()` accessor as everything else.
  - the lossless block store (`storeCompressedBlocks`) had the same bug AND looked events up by ARRAY
    POSITION when the ids it holds are seqs. It stored nothing and reported "blocks saved: 0" - a
    number that reads like "the folded range held nothing worth keeping". Events are now indexed by seq.
  - `ms` is now labelled for what it actually measures: the plugin-side call, not the summarizer's
    work. The first real row says 9ms for a 536k-token fold because the host produces the summary
    outside that await, so it must not be read as the fold's wall-clock cost.
- note(the first production fold, for the record): another session folded by itself at 810,420 tokens,
  seq 8-3070, 886 nodes, down to 273,596 (-66.2%), prefix-cache loss ~0.729 CNY. The pooled line read
  "1 compaction(s) across 1 session(s)" while this session showed 0 - which is exactly why pooled and
  per-session are printed side by side.
- test: the automatic-fold case now runs against a session stub that exposes ONLY the accessor
  (`ownEvents()`, no `events`), asserts `userMsgs` is the real count, and asserts the folded tool output
  is actually in the block store (`acp_block stats` -> blocks=1). Mutation-checked: restoring either
  `.events` read turns it red. 85/85.

## v0.18.0

- feat(status): `acp_status` prints the budget ledger (nominal ratio + ABSOLUTE cap + UNIT on one
  line), the four layers of 31057 Tab.4, and the pooled view beside this session.
  - `lib/metrics.js`: an append-only journal (`<DSH_HOME>/acp-metrics.jsonl`) written by every fold
    with `{ts, session, range, nodes, before, after, lossTokens, lossCostCNY, ms, userMsgs}`. The
    per-session ledger was an in-process Map, so every number died with the process and a POOLED
    figure could not be computed at all — while pooled and per-session must both be visible (31057
    reports pooled 55.5% vs per-session 50.8% for the same data; either alone would be "the" number).
  - `after` is RE-MEASURED after the fold, so a fold that shrinks less than it promised is visible;
    `before` was already measured.
  - the status line states its scope: journal count vs in-process count. They disagreed the first
    time the new test ran, and a restart resets only one of them.
  - an unknown window prints `window UNKNOWN` with its REASON (`no-llm-service` /
    `no-provider-model` / `no-context-window`) and never a percentage: a ratio without a
    denominator is a label, not a measurement.
  - L4 is the layer we do not have. Proxies: the gap between the last two folds, and the retrieval
    signals dsh-notemap records. "restatement of the same request by the user" prints as NOT
    MEASURED — an absent signal must not read as a zero.
  - the retrieval line counts a third category — a resolver answer that came back unresolved — so
    the two plugins share ONE file contract, and it is checked by booting the DEPLOYED profile
    copies (22 checks) rather than the source tree: the first run of that check found the
    unresolved-resolve gap above, and a stale hard-linked `index.js` in the profile
- fix(lifecycle): `dispose()` terminates the ingest worker. The worker is `unref()`'d so it never holds
  the HARNESS open, but its MessagePort is still an active handle: any short-lived embedding (a test
  process, a CLI) that triggered one fold hung at exit with `["PipeWrap","PipeWrap","MessagePort"]` and
  no failing test to show for it. Unload/teardown now calls `dispose()`.
- test: the automatic fold is covered end-to-end — `agent/pre-step` with a stubbed compaction service
  must fold `[2, 8]` (index 0 is the system-prompt node and is never folded) with nobody deciding, and
  a fold that fails to shrink must be reported and cooled down instead of retried every step.
- test: `test/metrics.test.mjs` (7: ledger labels, torn-line tolerance, an unwritable journal is a
  `false` and not a throw, rotation, pooled-vs-per-session disagreement, layer gaps, retrieval
  journal) plus `test/metrics-status.test.mjs` (3: boots `apply()` and asserts the text a user
  actually reads, including the UNKNOWN-window case). 83/83.

## v0.17.20

- **fix: ACP per-turn growth estimate inflates after compression.** The
  estimator summed every node between the last few `turn/start` markers,
  including seqs already hidden by acp_compress. Right after a compression the
  hidden nodes (hundreds of thousands of tokens) were counted as if they had
  just been added, producing absurd growth (`growth ≈ 612k/turn`) and a false
  `~0 turns until hard limit` warning that pushed agents into premature
  compression. The estimate now only counts nodes still on the current
  surface; the char-based fallback is filtered the same way.

## v0.17.19

- **fix: web client registration id after the package rename.** The
  `__ModuleLoader__.load({ id })` in `client/index.js` still used the legacy
  short name `dsh-session-handoff`, so the host rejected the client bundle
  (`loaded without registering "@snow-the/dsh-session-handoff"`). The id now
  matches the package name. Server-side plugin name, locale namespace and
  HTTP route prefix are unchanged, so existing `session-handoff:` settings
  keep working.

## v0.17.18

- **Recoverable pointers are archive-addressable.** The compaction rules now
  state explicitly that seq ids are event keys of the session archive
  (`~/.dsh/sessions/**/session.jsonl.zstd`, grep `"seq":N`) and the keys
  `acp_decompress` accepts — checkpoints keep exact seq ids so compressed
  original detail can always be located in the existing local archive
  without duplicating it into separate files.

## v0.17.17

- **Structured, type-aware compaction with recoverable pointers.** The ACP
  summary rules now guide per-type compression (tool results -> name + input
  signature + key numbers; code -> signatures + file:line; conversation ->
  gist; images dropped), require a `## Recoverable` pointer line (paths /
  functions / seq ids a later turn can re-read), and end with a one-line
  self-check (`lost: none | ...`) so critical facts are folded back in
  before the checkpoint lands.
- **Hard-limit forecast in `acp_status`.** Using the measured per-turn
  growth, status now reports the estimated turns until the hard limit
  (e.g. `estimated: ~7 turns until hard limit`), so compression is
  scheduled by rate, not just by percentage.

## v0.17.16

- **Fix route key detection when keys live in `.credentials.yaml` refs.** The
  `keyPrefix` fallback read the credentials document with a column-anchored
  regex, so refs indented under `refs:` were never found and every route
  showed `(missing)` even with a valid key. Detection now resolves the ref
  line by name (any indentation; legacy top-level keys included), matching
  the host's layered resolution (env wins, then the managed store) — the
  Model Routes panel and `model_routes` now show the real key family.

## v0.17.15

- **Self-mount the compaction backend when the host plane lacks one.** The
  patch-row re-enable does not survive the loader's row merge, so legacy web
  sessions (no preset realm) still had no `ctx.compaction`. The plugin now
  dynamically imports `@deepseek-ai/dsh-compaction-basic` and provides the
  official `BasicCompactionEngine` on the host plane whenever nothing else
  provides the service — acp_compress works in every session, old ones
  included, while per-session realms keep their own backend.

## v0.17.14

- **Explicitly clear `disabled` when re-enabling the host-plane compaction
  backend.** The loader merges patch rows per field, so re-stating the row
  without `disabled` kept `dsh-web-app`'s `disabled: true`. The override now
  sets `disabled: false`, which actually mounts compaction-basic on the host
  plane for legacy sessions.

## v0.17.13

- **Re-enable the host-plane compaction backend in web profiles.** `dsh-web-app`
  disables the `compaction-basic` row on the host plane and mounts it only in
  per-session preset realms, so sessions created before presets (or without a
  realm) had no compaction backend at all. This bundle's patch now re-enables
  the row by id (last write wins), giving every session — old ones included —
  a working backend while per-session realms keep their own.

## v0.17.12

- **acp_* tools now find the compaction service in web mode.** In web
  profiles `dsh-web-app` disables `compaction-basic` on the host plane and
  mounts it in each session's realm, so `ctx.get('compaction')` from a
  host-plane plugin returned null and `acp_compress` always failed. The tools
  now resolve the service from the agent's realm ctx first, then the session
  ctx, then the host plane (headless mode), so old web sessions can compress
  in place without migrating to a new session. `acp_status` reports which
  plane the backend was found on.

## v0.17.11

- **handoff_export no longer treats system banners as user objectives.**
  Runtime-context snapshots, checkpoint condensations, skill-catalog notices,
  and `<system-reminder>` injections arrive as `user/message` events in the
  session log; they were captured verbatim into "Recent user objectives",
  filling the handoff document with injected text instead of real user intent.
  `summarizeEvents` now filters them out (and the `user messages` count
  excludes them), so exported handoff docs carry actual conversation content.

## v0.17.10

- **Consistent field layout across rows.** The model/effort fields are now
  stacked vertically in every failover row. Previously they sat side by side
  when the row had room (no "set default" button) and wrapped to two lines
  when it didn't — so rows looked different depending on the action buttons.
  Vertical stacking makes every row identical at any panel width.

## v0.17.9

- **Model and effort fields are now labeled.** Both fields showed "跟随当前"
  when unset, which read as one duplicated/overlapping control. Each field now
  has a small leading label (模型 / 推理等级, Model / Effort), so the two
  controls stay visually distinct even when both values are "follow current".

## v0.17.8

- **Popup no longer overlaps the effort select.** The suggestion popup was
  growing beyond the model input's width (content-sized `min-width`) and
  covering the reasoning-effort select beside it. The popup is now locked to
  the input's exact width; long model names truncate with an ellipsis and show
  the full id on hover (title).

## v0.17.7

- **Visible highlighting + Tab completion.** Highlight styles no longer depend
  on host CSS variables (which the shell may not define): the active
  suggestion gets a theme-neutral translucent background and the matched
  substring gets a blue underline. `Tab` now completes like `Enter` (applies
  the highlighted suggestion and closes the popup; without suggestions it
  keeps the default focus move).

## v0.17.6

- **Combobox keyboard selection + match highlighting.** The typed text no
  longer appears as a ghost item at the bottom of the suggestion list; the
  matched substring inside each suggestion is highlighted instead. Focus/typing
  selects the first suggestion; `↑`/`↓` move the highlight (and `w`/`s` when
  the field is empty), `Enter` applies the highlighted suggestion and closes
  the popup, `Esc` closes it. Hover follows the same highlight.

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
