# dsh-session-handoff — Client UI 开发任务书

> 由 2026-08-19 长会话交接生成。原会话上下文超限（713k/1M），client UI 未完成，
> 本任务书供新会话继续。

## 目标（用户确认按 1→2→3 顺序）

给 dsh-session-handoff 加 client Web UI（用户要求 GUI 操作方式，不是 agent 工具）：

1. **模型路由面板**（最高优先）：设置页一个分栏，列出官方/Ark 双路（baseURL/key 家族/默认标记/视觉变体），**一键切换** agent-default-model
2. **会话交接入口**：会话列表/顶部"导出交接"按钮（调 host 已就绪的 handoff_export 逻辑）
3. **ACP 阈值滑块**：设置页通用设置里加阈值滑块（17-90%，学 dsh-session-manager）

## 已就绪的基础（无需重做）

- Host 插件全部工具已实现并测试（25 个单元测试全过）：
  - `model_routes` / `model_switch`（lib/model-routes.js——路由枚举 + 切换，纯逻辑已导出 readSettingsYaml/enumerateRoutes）
  - `handoff_status` / `handoff_export` / `handoff_resume`（lib/index.js）
  - `acp_config` / `acp_set_limit`（lib/acp-config.js——读写 settings.yaml 的 session-handoff: 段）
- 插件已装进 web profile（file: 依赖，`dsh-session-handoff`），GitHub 已发布（v0.9.0，10 commits）
- awesome-dsh-plugin PR #1794 已提（等 repo 满 1 天重跑 gate）
- 关键路径：`C:\Users\snow\dsh-session-handoff`（package.json 目前无 dsh.client）

## 参考实现（已验证可用）

- `C:\Users\snow\tmp-session-manager-ref\src\client\index.ts` —— dsh-session-manager 的 client（settings.section 插槽注册、useSessions 数据源、host 路由调用），3279 行完整参考
- `C:\Users\snow\tmp-research\` —— OpenViking / archify / active-context-pruning 源码
- 手写 client bundle 格式（免构建链）：`window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，参考 `@linxin666/dsh-tool-describe-image\lib\client.js`

## 技术要点

- package.json 加 `dsh.client: { platform: "web", inject: [...] }` + exports["./client"]
- client 端 inject：`['slots', 'locale', 'connection', 'sessions', 'workspaces']`（照 dsh-session-manager）
- 设置页分栏：`ctx.slots.register('settings.section', ...)`（照 dsh-session-manager 的 NAV_ZH/NAV_EN + locale namespace）
- 模型路由数据：host 已有 enumerateRoutes 纯逻辑——client 可通过 host HTTP 路由暴露（照 dsh-session-manager 的 `contract.ts` 路由模式：DELETE_ROUTE/TRASH_ROUTE 等），或加一个 GET /dsh-session-handoff/routes 路由
- 切换动作：client 调 host 路由 → host 写 settings.yaml（复用 model-routes.js 的写逻辑）
- 注意：session-handoff 是纯 host 插件现在，加 client 后要重新 pnpm install + 重启生效

## 验证

- 装好后 GUI 设置页出现「模型路由」分栏
- 一键切换官方/Ark，settings.yaml 的 agent-default-model 随之变化
- 其余 25 个 host 测试不回归
