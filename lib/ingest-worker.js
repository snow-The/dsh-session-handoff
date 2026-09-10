/**
 * ingest-worker.js - session-log parsing + graph ingest, off the harness thread.
 *
 * Decoding a DSH session log is CPU- and memory-bound (a 155 MB log holds
 * 278,451 zstd frames / 423,681 events). Done inline it froze the harness event
 * loop for seconds on every compression, so the work now runs here and the
 * caller only schedules it. The worker reuses the same incremental ingest path
 * as the main thread, so the watermark stays the single source of progress.
 */
import { parentPort } from 'node:worker_threads';
import { autoIngestSession } from './graph.js';

if (parentPort !== null) {
  parentPort.on('message', (msg) => {
    const started = Date.now();
    try {
      const result = autoIngestSession(msg && msg.sessionId, msg && msg.cwd);
      parentPort.postMessage({ id: msg && msg.id, ok: true, ms: Date.now() - started, result });
    } catch (e) {
      parentPort.postMessage({ id: msg && msg.id, ok: false, ms: Date.now() - started, error: String(e && e.message ? e.message : e) });
    }
  });
}
