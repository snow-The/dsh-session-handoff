# 插件 ACP 兼容依赖扫描

日期：本会话
范围：web profile 全部 24 个插件 bundles
目标：找出哪些插件可以"兼容依赖 ACP"（有 acp_graph 就增强，无则降级）

## 已改造（兼容依赖 ACP）

### 1. dsh-session-handoff（ACP 本体，L2/L3）
- acp_graph 工具 + ~/.dsh/graph/graph.db（SQLite + FTS5 混合检索）
- 权威长期记忆源：读 compaction/summary 事件（DSH 原生）
- 状态：✅ 已完成 + 系统测试 fuzz 通过

### 2. dsh-notemap（降级为依赖 ACP）
- 新增 src/acp.ts：acpGraphAvailable() / importFromAcpGraph() / acpGraphRecall()
- notemap_import_session → ACP 图可用时从 ACP 图导入（避免重复解析 session）
- notemap_recall → 融合 acpGraphRecall 跨会话命中
- 无 ACP 图 → 完全降级纯本地（不破坏）
- 状态：✅ commit ca61837，build + 部署

### 3. dsh-research-lab（兼容依赖 ACP）
- 新增 src/acp.ts：acpGraphAvailable() / acpGraphRecall()
- rlab_related search → 融合 ACP 跨会话 checkpoint 命中（追加 "## ACP 跨会话记忆" 段）
- 无 ACP 图 → 纯项目内检索（降级）
- 状态：✅ build + 部署（非 git 仓库，源在 .dsh-starter/plugins/）

## 候选（可兼容依赖 ACP，未改造）

### 4. dsh-lib-analyzer（libsearch）— 高价值
- libsearch 跨库知识检索（.dsh-lib-analyzer/pages + batch/out）
- 兼容点：libsearch 可融合 acpGraphRecall，把"以前会话关于某库的结论"带进分析
- 与 lab 同类（都是项目级检索），改造模式相同

### 5. @openviking/dsh-memory-plugin — 中价值
- 记忆插件，本质也是长期记忆
- 兼容点：可融合 acp_graph 作为另一路记忆源（去重/互补）
- 需先看其存储格式是否与 ACP 图重叠

### 6. dsh-session-archive（@linxin666）— 中价值
- 会话归档，可能含摘要/索引
- 兼容点：归档时可记录 ACP 图位置/复用

## 不适用（无需兼容 ACP）

- dsh-base / dsh-web-app：框架层
- @linxin666/dsh-client-ui-* / dsh-remote-web-ui / dsh-desktop-launcher：UI/客户端
- aegis / dsh-busyloop / dsh-gitkit / dsh-snapshot / dsh-plugin-doctor / dsh-plugin-guide / dsh-skill-pack / dsh-session-repair / dsh-browser / dsh-search / dsh-undo-savepoint / dsh-ark-plan / dshmarket / dsh-commandcode-provider / archify-dsh / dsh-perf / dsh-usage / dsh-i18n / dsh-pet / dsh-liangshen / dsh-doctor / dsh-ssh / dsh-tool-describe-image / dsh-web-all：功能独立，与长期记忆图谱无直接交集

## 兼容依赖的通用模式（已确立）
1. **数据层依赖**：只读 ~/.dsh/graph/graph.db（SQLite 文件），不 import session-handoff 代码
2. **探测**：acpGraphAvailable() = graph.db 存在 且 checkpoints 非空
3. **融合**：检索时追加 acpGraphRecall(query) 结果（实体命中→带 checkpoint 摘要）
4. **降级**：无 ACP 图 → 返回 [] / 纯本地，零破坏
5. 共享的 src/acp.ts 模板（notemap/lab 各一份，已成型）

## 下一步建议
1. dsh-lib-analyzer libsearch 融合（与 lab 同模式，优先级最高）
2. 检查 openviking memory 存储格式（避免双份长期记忆）
3. 考虑把 src/acp.ts 抽成共享小库（@snow-the/dsh-acp-client?）避免三份复制
