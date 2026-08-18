/**
 * dsh-session-handoff — session management (trash + list).
 *
 * Agent-callable session management built on the official session services:
 *   session_list    — list sessions (optionally including the trash)
 *   session_trash   — archive + move a session's artifact into the plugin trash
 *   session_restore — move it back and unarchive
 *   session_purge   — permanently delete the artifact and trash entry
 *
 * Zero third-party dependencies: trash entries persist as JSON under
 * $DSH_HOME/dsh-session-handoff-trash/ (no storage-domain/zod requirement).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

export const TRASH_LIMIT = 10;

function trashRoot() {
  return dshHomePath('dsh-session-handoff-trash');
}
function trashSessionDir(sessionId) {
  return join(trashRoot(), sessionId);
}
function entriesFile() {
  return join(trashRoot(), 'entries.json');
}

async function getEntries() {
  try {
    const raw = await readFile(entriesFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
async function setEntries(entries) {
  await mkdir(trashRoot(), { recursive: true });
  await writeFile(entriesFile(), JSON.stringify(entries, null, 2), 'utf8');
}
async function recordEntry(entry) {
  const entries = (await getEntries()).filter((e) => e.sessionId !== entry.sessionId);
  entries.push(entry);
  // keep only the newest TRASH_LIMIT entries; purge overflow artifacts
  const overflow = entries.slice(0, Math.max(0, entries.length - TRASH_LIMIT));
  const kept = entries.slice(-TRASH_LIMIT);
  for (const o of overflow) {
    await rm(trashSessionDir(o.sessionId), { recursive: true, force: true }).catch(() => {});
  }
  await setEntries(kept);
}

/** Resolve one persisted session's artifact directory, or undefined. */
async function locateSession(ctx, sessionId) {
  try {
    const headers = await ctx.sessionPersistence?.list?.();
    if (headers == null) return undefined;
    const meta = headers.find((h) => h.id === sessionId);
    if (meta == null) return undefined;
    const location = ctx.sessionPersistence?.locate?.(meta);
    return location?.path ? dirname(location.path) : undefined;
  } catch {
    return undefined;
  }
}

function validateId(sessionId) {
  if (typeof sessionId !== 'string' || !/^(session-)?[0-9a-fA-F-]+$/.test(sessionId)) {
    throw new Error('invalid session id');
  }
  return sessionId;
}

export function registerSessionMgmtTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'session_list',
    description: 'List sessions (optionally including the trash) with id, cwd and running state.',
    parameters: {
      includeTrash: { type: 'boolean', description: 'Also list trashed sessions (default false)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const lines = [];
      try {
        const headers = await ctx.sessionPersistence?.list?.() ?? [];
        for (const h of headers) {
          const live = ctx.agents?.get?.(h.id) !== undefined;
          lines.push(`${h.id}${live ? ' (running)' : ''}  ${h.cwd ?? ''}`);
        }
        if (lines.length === 0) lines.push('(no persisted sessions)');
      } catch (e) {
        lines.push(`(session list unavailable: ${String(e?.message ?? e)})`);
      }
      if (args?.includeTrash) {
        const entries = await getEntries();
        lines.push('', '## Trash');
        if (entries.length === 0) lines.push('(empty)');
        for (const e of entries) lines.push(`${e.sessionId}  deleted ${new Date(e.deletedAt).toISOString()}`);
      }
      return lines.join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'session_trash',
    description: 'Archive a session and move its artifact into the plugin trash (recoverable). Refuses sessions whose agent is currently running.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to trash' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const id = validateId(args.sessionId);
      const agent = ctx.agents?.get?.(id);
      if (agent?.status === 'running') throw new Error(`session ${id} is running; stop it first`);
      const originalPath = await locateSession(ctx, id);
      let artifactMoved = false;
      if (originalPath !== undefined && existsSync(originalPath)) {
        await mkdir(trashRoot(), { recursive: true });
        const trashPath = trashSessionDir(id);
        await rm(trashPath, { recursive: true, force: true });
        await rename(originalPath, trashPath);
        artifactMoved = true;
      }
      await ctx.workspaceRegistry?.archiveSession?.(id).catch(() => {});
      await recordEntry({ sessionId: id, cwd: agent?.session?.header?.cwd, deletedAt: Date.now() });
      return `Trashed ${id}${artifactMoved ? ' (artifact moved to trash)' : ' (no artifact found, entry recorded)'}`;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'session_restore',
    description: 'Restore a trashed session: move its artifact back and unarchive it.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to restore' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const id = validateId(args.sessionId);
      const entries = await getEntries();
      const entry = entries.find((e) => e.sessionId === id);
      if (entry == null) throw new Error(`session ${id} is not in the trash`);
      const trashPath = trashSessionDir(id);
      let restored = false;
      if (entry.cwd && existsSync(trashPath)) {
        const target = join(entry.cwd, id);
        await mkdir(dirname(target), { recursive: true });
        await rename(trashPath, target);
        restored = true;
      } else if (existsSync(trashPath)) {
        // artifact exists but we don't know the original cwd: leave in place, drop entry
        restored = true;
      }
      await ctx.workspaceRegistry?.unarchiveSession?.(id).catch(() => {});
      await setEntries(entries.filter((e) => e.sessionId !== id));
      return `Restored ${id}${restored ? '' : ' (artifact not moved back; entry removed)'}`;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'session_purge',
    description: 'Permanently delete a session artifact and its trash entry (irreversible).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to purge' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const id = validateId(args.sessionId);
      const entries = await getEntries();
      await rm(trashSessionDir(id), { recursive: true, force: true });
      await setEntries(entries.filter((e) => e.sessionId !== id));
      return `Purged ${id}`;
    },
  }));
}
