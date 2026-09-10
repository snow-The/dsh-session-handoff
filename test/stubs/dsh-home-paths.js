/**
 * TEST-ONLY stand-in for @deepseek-ai/dsh-home-paths (host-provided at runtime).
 *
 * Mirrors the documented behaviour of the real helpers: the harness home comes from
 * $DSH_HOME, else <os home>/.dsh, and dshHomePath joins segments under it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DSH_HOME_DIR_NAME = '.dsh';
export const DSH_HOME_ENV = 'DSH_HOME';
export const DEFAULT_DSH_HOME_DISPLAY = '~/.dsh';

export function resolveDshHome(home) {
  const configured = home ?? process.env[DSH_HOME_ENV];
  return configured !== undefined && configured !== '' ? configured : join(homedir(), DSH_HOME_DIR_NAME);
}

export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments);
}
