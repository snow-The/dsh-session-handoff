// 守护规则：**worker 线程能碰到的模块，不许 import 宿主包**。
//
// 实测（2026-11-05/06，0.2.1-rc.5 与 0.2.2-rc.1 都有）：
//   [dsh-session-handoff] ingest worker error: Cannot find package '@deepseek-ai/dsh-tools'
//   imported from .../lib/graph.js
// `ingest-worker.js` 在 worker 线程里 `import { autoIngestSession } from './graph.js'`，而 graph.js
// 顶层 import 了 `@deepseek-ai/dsh-tools`。worker 按插件的真实路径解析模块，宿主包在天上，
// 于是整个 ingest 功能静默死掉 —— 主线程的一切看起来都正常。
//
// 这条测试不做运行时依赖，只做静态可达性：从 ingest-worker.js 出发，顺着本地 import 走一遍，
// 谁碰了 `@deepseek-ai/*` 就红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const LIB = join(here, '..', 'lib')

/** 文本里所有宿主包 import（`from '@deepseek-ai/...'` 或 `import('@deepseek-ai/...')`）。
 *  **先剥掉注释**：`zstd-frames.js` 的头部注释里就有这行 import（它说明「这是官方实现的逐字移植」），
 *  不剥注释会把它数成一个真 import —— 守卫的第一次运行就报了这个假红。 */
export function hostImports(text) {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/^\s*\/\/.*$/gm, '') // whole-line // comments
  const out = []
  const re = /(?:from\s+|import\s*\(\s*)['"](@deepseek-ai\/[^'"]+)['"]/g
  for (const m of code.matchAll(re)) out.push(m[1])
  return out
}

/** 本地相对 import（`from './x.js'`）。 */
function localImports(text) {
  const out = []
  const re = /from\s+['"](\.\/[^'"]+\.js)['"]/g
  for (const m of text.matchAll(re)) out.push(m[1])
  return out
}

/** 从入口文件出发，收集它和它（一层层）import 的本地模块。 */
function reachable(entry) {
  const seen = new Map()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    seen.set(file, text)
    for (const rel of localImports(text)) queue.push(resolve(dirname(file), rel))
  }
  return seen
}

test('the ingest worker can only reach host-free modules', () => {
  const files = reachable(join(LIB, 'ingest-worker.js'))
  assert.ok(files.size >= 3, `expected the worker chain to span several files, got ${files.size}`)
  const offenders = [...files].flatMap(([file, text]) =>
    hostImports(text).map((pkg) => `${file.replace(LIB, 'lib')} imports ${pkg}`),
  )
  assert.deepEqual(offenders, [], `worker-reachable modules must not import host packages: ${offenders.join('; ')}`)
})

test('the host-import detector can actually go red (control)', () => {
  // 老写法：graph.js 顶层 `import { defineTool } from '@deepseek-ai/dsh-tools';`
  const old = "import { defineTool } from '@deepseek-ai/dsh-tools';\nimport { mkdirSync } from 'node:fs';\n"
  assert.deepEqual(hostImports(old), ['@deepseek-ai/dsh-tools'], 'the detector must catch the import that broke the worker')
  // 对照组：纯 node 内建 + 本地模块 → 必须干净
  const ok = "import { mkdirSync } from 'node:fs';\nimport { x } from './y.js';\nimport('node:zlib');\n"
  assert.deepEqual(hostImports(ok), [])
  // 注释里的 import 不算 import（否则守卫会被文档噎死 —— 实测它第一次就是这样假红）
  const doc = "/**\n * ported from\n * `import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd'`\n */\n"
  assert.deepEqual(hostImports(doc), [], 'an import mentioned inside a comment is documentation, not code')
  // 但注释剥除不能把真 import 也吃掉
  const mixed = "// note\nimport { defineTool } from '@deepseek-ai/dsh-tools';\n"
  assert.deepEqual(hostImports(mixed), ['@deepseek-ai/dsh-tools'])
  // defineTool 作为参数传进来，不得出现在 import 里
  assert.deepEqual(hostImports('export function registerGraphTools(ctx, defineTool) {}\n'), [])
})
