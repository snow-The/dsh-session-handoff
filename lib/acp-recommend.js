/**
 * dsh-session-handoff — ACP threshold recommendation.
 *
 * The "best value" soft/hard limits balance three costs over a session's life:
 *   1. carrying cost  — every request re-sends the whole context (pay per
 *      token), so larger contexts cost more per turn;
 *   2. compaction cost — one summarize call that reads the entire compacted
 *      range as input, plus one more quality-loss event for the session;
 *   3. quality loss — details flattened into a summary; worse when compaction
 *      is forced late (whole-range, agent-unaware) instead of chosen early
 *      (agent-picked range).
 *
 * Key empirical fact (from real session archives): session sizes are heavily
 * long-tailed. The vast majority of sessions never approach the window, so the
 * thresholds are only ever "paid" by the few heavy sessions. For those, the
 * per-turn context growth G decides everything:
 *
 *   hard = fuse. Put it as late as safely possible (90% of the window minus a
 *          single-turn burst margin of ~2×G) so the session compacts as few
 *          times as possible. Every extra compaction costs one whole-range
 *          summarize call and one quality-loss event.
 *   soft = hard − G × bufferRounds. The runway lets the agent compact
 *          actively (cheap, agent-chosen range) several turns before the fuse
 *          would force it (expensive, whole-range summary).
 *
 * With a 1M window and heavy sessions growing ~30-50k tokens/turn this yields
 * roughly soft 60-65% / hard 90% — matching the empirically observed sweet
 * spot of the original 60% soft value while fixing the over-conservative 70%
 * hard value that caused 10+ compactions in a single long session.
 */
export function recommendThresholds({
  windowTokens,
  growthPerTurn,
  hardRatio = 0.9,
  bufferRounds = 6,
  minSoftRatio = 0.35,
} = {}) {
  const W = Number(windowTokens);
  if (!Number.isFinite(W) || W <= 0) throw new Error('windowTokens must be a positive number');
  // Default growth: 5% of the window per turn (typical heavy workload).
  const g = Number.isFinite(growthPerTurn) && growthPerTurn > 0
    ? growthPerTurn
    : Math.floor(W * 0.05);

  // Fuse: 90% of the window, but never closer than a 2×G burst margin.
  const hard = Math.max(
    Math.floor(W * minSoftRatio) + 1,
    Math.min(Math.floor(W * hardRatio), W - Math.max(Math.floor(2 * g), 50000)),
  );
  // Runway: the agent should get bufferRounds of active-compaction time.
  const softRaw = hard - g * bufferRounds;
  const soft = Math.min(Math.max(Math.floor(softRaw / 1000) * 1000, Math.floor(W * minSoftRatio)), hard - 20000);

  const roundPct = (tokens) => Math.max(1, Math.min(95, Math.round((tokens / W) * 100)));
  const minPct = roundPct(soft);
  const maxPct = roundPct(hard);
  const growthPct = Math.round((g / W) * 100);

  return {
    min: `${minPct}%`,
    max: `${maxPct}%`,
    minTokens: soft,
    maxTokens: hard,
    windowTokens: W,
    growthPerTurn: g,
    reasoning: [
      `window: ${(W / 1000).toFixed(0)}k tokens; heavy-session growth ≈ ${(g / 1000).toFixed(0)}k tokens/turn (${growthPct}%/turn)`,
      `hard ${maxPct}% = fuse: as late as safely possible (90% minus a ${(2 * g / 1000).toFixed(0)}k single-turn burst margin) to minimize compaction count`,
      `soft ${minPct}% = hard − ${bufferRounds} turns × ${(g / 1000).toFixed(0)}k: gives the agent ${bufferRounds} turns of active-compaction runway before the fuse forces a whole-range summary`,
    ],
  };
}
