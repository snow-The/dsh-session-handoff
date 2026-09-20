/**
 * Read a session's events — ONE owner for the fact that a harness Session has no `events` property.
 *
 * Verified on a live session: the keys are log/surfaceManager/header/inheritedEventCount/
 * firstLiveSeq/eventsSnapshot/headerFold/headerFoldSeq, and `typeof session.events === "undefined"`
 * (not an array, not even an iterable). The public accessors are `ownEvents()` / `snapshotEvents()`;
 * `log` is the private array behind them.
 *
 * Why it is a MODULE and not a local helper: it used to live inside index.js, and graph.js — a
 * separate module that cannot see it — read `session.events` directly instead. That copy was a no-op
 * (`[]` for every real session) AND its ternary had the same expression in both branches, so
 * `acp_graph build` silently ingested nothing whenever the session file was empty. The fallback that
 * was supposed to "cover non-zstd / plaintext sessions" could never run. Two owners, two bugs.
 *
 * Inside index.js this helper used to return [] for every real session, silently degrading all eight
 * call sites (growth estimation, pricing, the banner). Fixtures that pass a plain `{ events: [...] }`
 * keep working through the fallback below.
 */
let warned = false;

export function sessionEvents(session) {
  try {
    if (typeof session?.ownEvents === 'function') {
      const own = session.ownEvents();
      if (Array.isArray(own)) return own;
    }
    if (typeof session?.snapshotEvents === 'function') {
      const snap = session.snapshotEvents();
      if (Array.isArray(snap)) return snap;
    }
  } catch { /* fall through to the raw fields */ }
  const events = session?.log ?? session?.events;
  if (events == null) {
    if (!warned && session != null) {
      warned = true;
      console.warn('[dsh-session-handoff] session has no readable events (ownEvents/snapshotEvents/log all absent) — context estimates degrade');
    }
    return [];
  }
  if (Array.isArray(events)) return events;
  if (typeof events[Symbol.iterator] === 'function') return [...events];
  return [];
}
