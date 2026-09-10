/**
 * Redirects the host-provided @deepseek-ai packages to test-only stand-ins, so the unit
 * suite runs from a fresh clone with no host install. Loaded via:
 *   node --import ./test/register-stubs.mjs --test "test/*.test.mjs"
 *
 * Everything else resolves normally: if a test ever needs real host behaviour, this hook
 * is the single place to change.
 */
import { registerHooks } from 'node:module';

const stubs = new Map([
  ['@deepseek-ai/dsh-tools', new URL('./stubs/dsh-tools.js', import.meta.url).href],
  ['@deepseek-ai/dsh-home-paths', new URL('./stubs/dsh-home-paths.js', import.meta.url).href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = stubs.get(specifier);
    if (stub !== undefined) return { url: stub, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
