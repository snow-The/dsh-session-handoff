/**
 * 服务访问纪律：每个 `ctx.<name>` 都必须是【已声明的】或【安全取用的】。
 *
 * ── 为什么有这个测试 ───────────────────────────────────────────────
 *
 * 2026-10-04 在笔电上部署时，webServer 因隔壁插件配置非法而未能启动。
 * 同一批插件里有 14 个干净地"等待服务"，唯独本插件抛出：
 *
 *     Error: cannot get property "webServer" without inject
 *
 * 因为 lib/index.js 里写的是：
 *
 *     const webServer = ctx.get?.('webServer') ?? ctx.webServer;
 *
 * 这【看起来】防御，实际不是：在 cordis 里访问未注入的服务属性是**抛异常**，
 * 不是返回 undefined，所以 `??` 右边那条兜底路径自己就会炸。
 * 结果是一个"服务缺席"被误报成"插件崩溃"，而且错误信息指向完全无关的方向。
 *
 * ── 本测试断言什么 ─────────────────────────────────────────────────
 *
 *   1. 每个 `ctx.<name>` 用法，name 要么在 `export const inject` 里，
 *      要么在 CORDIS_BUILTINS 里（框架自带，不需要 inject）。
 *   2. 不在上述两者、又必须用到的服务，必须走 serviceOf() —— 而 serviceOf 内部
 *      用的是 `ctx.get(name)` / `ctx[name]`，所以它自己不会触发本断言。
 *   3. 注释与字符串里的示例不算（否则 services.js 的说明文字会误报）。
 *
 * 违约时给出修法，而不是只报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

/**
 * cordis Context 自带的成员，不需要（也不能）写进 inject。
 * 只列本仓库实际会用到的那几个，多列会把真正的违规一起放进来。
 */
const CORDIS_BUILTINS = new Set([
  'get',        // service lookup（serviceOf 用的就是它）
  'set',
  'provide',    // 注册服务
  'effect',     // 生命周期效应
  'on',         // 事件
  'emit',
  'logger',
  'scope',
  'root',
  'plugin',
]);

/** 剥掉块注释与行注释 —— 文档里的 `ctx.x` 示例不是代码。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readInject() {
  const src = readFileSync(join(LIB, 'index.js'), 'utf8');
  const m = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(src);
  assert.ok(m, 'lib/index.js 里找不到 `export const inject = [...]`');
  return new Set(
    m[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  );
}

function usages() {
  const out = [];
  for (const f of readdirSync(LIB).filter((n) => n.endsWith('.js'))) {
    const src = stripComments(readFileSync(join(LIB, f), 'utf8'));
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bctx\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        out.push({ file: f, line: i + 1, name: m[1], text: line.trim() });
      }
      for (const m of line.matchAll(/\bctx\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) {
        out.push({ file: f, line: i + 1, name: m[1], text: line.trim() });
      }
    });
  }
  return out;
}

test('每个 ctx.<service> 要么在 inject 里，要么走 serviceOf', () => {
  const inject = readInject();
  const all = usages();
  assert.ok(all.length > 0, '一个 ctx.<name> 用法都没扫到 —— 解析逻辑坏了');

  const offenders = all.filter(
    (u) => !inject.has(u.name) && !CORDIS_BUILTINS.has(u.name),
  );

  assert.deepEqual(
    offenders,
    [],
    '发现未声明也未安全取用的服务访问:\n' +
      offenders.map((o) => `  ${o.file}:${o.line}  ctx.${o.name}   →  ${o.text}`).join('\n') +
      '\n\n修法（二选一）:\n' +
      '  · 该服务【必需】→ 加进 lib/index.js 的 export const inject\n' +
      '  · 该服务【可缺席】(headless/tui 里本来就没有) → 用 serviceOf(ctx, \'名字\')，\n' +
      '    并处理 null（通常是干净地跳过，不要抛）\n' +
      '不要写成 `ctx.get?.(n) ?? ctx[n]` —— 右边会抛，防御是假的。',
  );
});

test('serviceOf 对缺失服务返回 null 而不是抛', async () => {
  const { serviceOf } = await import('../lib/services.js');

  // 模拟 cordis 的行为：访问未注入的服务属性【抛异常】
  const throwing = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'get') return () => undefined;
        if (prop === 'then') return undefined; // 避免被当成 thenable
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    },
  );

  assert.equal(serviceOf(throwing, 'webServer'), null, '缺席的服务必须返回 null');

  // 有服务时正常取到
  const present = { webServer: { register() {} } };
  assert.equal(serviceOf(present, 'webServer'), present.webServer);

  // ctx.get 存在时优先走它
  const viaGetOnly = { get: (n) => (n === 'agents' ? { ok: true } : undefined) };
  assert.deepEqual(serviceOf(viaGetOnly, 'agents'), { ok: true });

  // ctx.get 本身抛也不崩
  const brokenGet = {
    get() { throw new Error('boom'); },
    llm: { ok: 1 },
  };
  assert.deepEqual(serviceOf(brokenGet, 'llm'), { ok: 1 });
});
