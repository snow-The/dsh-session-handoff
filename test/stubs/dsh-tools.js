/**
 * TEST-ONLY stand-in for @deepseek-ai/dsh-tools.
 *
 * The real package is provided by the DSH host at runtime, not by this repository: the
 * plugin is deliberately zero-dependency (see README). Without a stand-in the unit tests
 * cannot even load lib/index.js, which is why eight test files sat here unwired and
 * broken (ERR_MODULE_NOT_FOUND for the host package).
 *
 * Only the surface the plugin uses is mirrored. defineTool is a schema helper - it
 * annotates a tool definition and returns it - so the identity is faithful for these
 * tests, which exercise internals (pressure math, range safety, config plumbing), not
 * the host's tool plumbing. The real host integration is covered by boot smoke tests.
 */
export function defineTool(definition) {
  return definition;
}
