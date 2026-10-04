/**
 * 安全取用一个 cordis 服务。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────────
 *
 * 直觉写法是：
 *
 *     const webServer = ctx.get?.('webServer') ?? ctx.webServer;
 *
 * 它【看起来】是防御性的，实际不是。在 cordis 里，访问一个未注入的服务属性是
 * **抛异常**，不是返回 undefined：
 *
 *     Error: cannot get property "webServer" without inject
 *
 * 于是 `??` 右边那条兜底路径自己就会炸 —— 左边的 `ctx.get` 完全白写。
 *
 * ── 实测（2026-10-04，笔电部署时） ─────────────────────────────────
 *
 * webServer 因隔壁插件配置非法而未能启动。同一批插件里有 14 个干净地"等待服务"
 * （报告为 `Plugins waiting for services`），唯独本插件抛错，顶层错误于是变成：
 *
 *     session-handoff: cannot get property "webServer" without inject
 *
 * —— 一个与真实原因（别的插件配置写错了）毫无关系的错误。排查时它会指错方向，
 * 而且把一个"缺席"误报成"崩溃"。
 *
 * ── 正确做法 ───────────────────────────────────────────────────────
 *
 * 服务缺席是**正常情况**（headless / tui profile 里本来就没有 webServer），
 * 应当降级而不是抛错。所以：
 *
 *     const webServer = serviceOf(ctx, 'webServer');
 *     if (webServer == null) return;          // 干净地跳过
 *
 * ── 注意 ───────────────────────────────────────────────────────────
 *
 * 不要用 `ctx.x?.y` 来"保护" —— `?.` 作用在**取到的结果**上，
 * 而 `ctx.x` 这个属性访问本身就已经抛了。必须整个访问都包在 try 里。
 */

/**
 * @param {object} ctx cordis Context
 * @param {string} name 服务名，如 'webServer' / 'agents'
 * @returns {any|null} 服务实例；不可用时返回 null（永不抛）
 */
export function serviceOf(ctx, name) {
  try {
    const viaGet = ctx.get?.(name);
    if (viaGet != null) return viaGet;
  } catch {
    // ctx.get 本身不可用（更老的宿主）—— 走下面的属性访问
  }
  try {
    return ctx[name] ?? null;
  } catch {
    // 未注入。这是正常情况，不是错误。
    return null;
  }
}

/**
 * 与 serviceOf 同源，但用于**嵌套服务**：`sessionPersistence.locate()` 这类
 * "对象在、方法不在"的场景。
 *
 * 存在理由见 lib/session-mgmt.js 里那段注释：`ctx.sessionPersistence?.locate?.(...)`
 * 会把"该方法根本不存在"静默变成 undefined，于是整个分支永不执行、而调用方仍然
 * 报告成功。那是静默失败，不是兼容层。这里显式区分"服务不在"与"方法不在"。
 *
 * @returns {{ ok: true, fn: Function } | { ok: false, reason: string }}
 */
export function methodOf(obj, method) {
  if (obj == null) return { ok: false, reason: 'service-missing' };
  const fn = obj[method];
  if (typeof fn !== 'function') return { ok: false, reason: 'method-missing' };
  return { ok: true, fn: fn.bind(obj) };
}
