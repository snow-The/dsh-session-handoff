/**
 * subagent-tool-scope.js — keep research/cross-machine tools out of a subagent's request.
 *
 * THE MEASUREMENT THIS FIXES. Across 168 native sessions in `source/repos` (all
 * `origin: "subagent"`, `delegationDepth: 1`, `agentPreset: "cordis"`), 126 of 222 declared tools
 * were NEVER called, and they cost 21,136 tokens per request — 58.3% of the whole schema block.
 * The three families that dominate are `rlab_*` (10 tools), `search_*` (4) and `ssh_*` (3).
 *
 * WHY THE PRESET IS NOT THE FIX. `preset-cordis` declares only ~35 plugins (cfg-dump.yml:1125).
 * The other 120+ tools are registered GLOBALLY by our own bundles (`dsh-bundle-research` and
 * friends), and `ctx.tools.register` is global by contract (dsh-tools/index.d.ts:44: "Register
 * globally or in the calling agent scope. Scoped tools shadow globals"). So a subagent inherits
 * every global tool whether or not its preset asked for it.
 *
 * THE OFFICIAL MECHANISM (dsh-tools/index.d.ts:51-58):
 *
 *   restrict(filter: ToolRestriction): () => void;
 *   // "Restrict global tools for the calling agent scope. ... Restrictions intersect; scoped
 *   //  registrations remain visible."  filter = { allow?: string[]; deny?: string[] }
 *
 * It is reversible (the returned disposer lifts it) and it does not touch registrations, so a
 * wrong guess costs one disposer, not a lost capability.
 *
 * WHY `deny` AND NOT `allow`. `allow` would freeze the subagent's toolset at today's list and
 * silently drop every tool added later. `deny` removes exactly the families measured dead and
 * leaves everything else — including tools that do not exist yet — alone.
 */

/**
 * Tool families a subagent does not need, each with the reason it is safe to remove.
 *
 * Every entry was measured dead across 168 subagent sessions. Adding a family here is a decision
 * that needs the same evidence; do not add one because it "looks like a main-session tool".
 */
export const SUBAGENT_DENY = {
  // Research-lab tools: they drive a long-lived research project (OCR, arxiv digests, wiki pages).
  // A delegated subagent works on one scoped task and never advances a lab project.
  rlab: [
    'rlab_related', 'rlab_scoop', 'rlab_absorb', 'rlab_ocr', 'rlab_bench', 'rlab_claim',
    'rlab_experiment', 'rlab_wiki', 'rlab_arxiv_digest', 'rlab_latex', 'rlab_status',
    'rlab_validate', 'rlab_ref', 'rlab_writing', 'rlab_rewrite', 'rlab_paper_review',
  ],
  // Cross-machine tools: a subagent runs on the host that spawned it. Moving work to another
  // machine is the parent's decision, and the parent has these tools.
  ssh: ['ssh_exec', 'ssh_cluster', 'ssh_tunnel', 'ssh_resolve', 'ssh_list', 'ssh_upload', 'ssh_download'],
  // Search fan-out: the parent already searched; a subagent gets the URLs it was given.
  search: [
    'search_api', 'search_code', 'search_deep', 'search_open', 'search_arxiv', 'search_hubs',
    'search_github', 'search_probe', 'search_verify', 'search_corpus_add', 'search_corpus_search',
    'search_corpus_clear', 'platform_search', 'web_search',
  ],
  // Session-bus and ACP administration: these coordinate SESSIONS, and a subagent is not a peer.
  bus: [
    'session_bus_room', 'session_bus_send', 'session_bus_inbox', 'session_bus_ack',
    'session_bus_thread', 'session_bus_list', 'session_bus_wake', 'session_bus_whoami',
    'acp_set_limit', 'acp_shrink', 'acp_compress', 'acp_decompress', 'acp_status',
    'acp_config', 'acp_recommend', 'acp_graph', 'acp_search', 'acp_block',
  ],
  // Long-running orchestration: a subagent IS the unit of work; it does not schedule more.
  orchestration: [
    'workflow', 'busyloop_run', 'schedule_create', 'schedule_edit', 'schedule_list',
    'schedule_view', 'orchestrator_open', 'orchestrator_send', 'orchestrator_report',
    'orchestrator_settle', 'orchestrator_status', 'orchestrator_reachability',
  ],
};

/** Flatten SUBAGENT_DENY into the `deny` array `restrict()` takes. */
export function subagentDenyList() {
  return Object.values(SUBAGENT_DENY).flat();
}

/**
 * Should this agent get the restriction?
 *
 * Only subagents. A root session legitimately uses every one of these tools, and restricting it
 * would remove capability rather than waste.
 *
 * @param agent - anything with `session.header`
 * @returns whether to apply the restriction
 */
export function shouldRestrict(agent) {
  const header = agent?.session?.header;
  if (header == null) return false;
  return header.origin === 'subagent';
}

/**
 * Apply the restriction to one agent's scope.
 *
 * The caller owns the disposer: it must be called when the agent ends, or the restriction leaks
 * into the next agent that reuses this scope.
 *
 * @param ctx - the Cordis context whose scope is the agent's (i.e. `agent.ctx`)
 * @param agent - the agent being restricted
 * @returns the disposer, or null when nothing was applied
 */
export function restrictSubagentTools(ctx, agent) {
  if (!shouldRestrict(agent)) return null;
  const tools = ctx?.get?.('tools') ?? ctx?.tools;
  if (tools == null || typeof tools.restrict !== 'function') return null;
  const deny = subagentDenyList();
  try {
    return tools.restrict({ deny });
  } catch {
    // An unknown name fails the whole call by contract ("unknown names ... fail"), so a single
    // stale entry would silently disable the restriction. Returning null makes that visible to
    // the caller instead of pretending it worked.
    return null;
  }
}
