# DESIGN-SKILL-EVOLUTION.md — dsh-skill-pack 按 WikiSkill 重写 + libsearch 拆解

依据：WikiSkill (arXiv 2608.27454, Google Research) "Compiling Agent Experience into
Persistent Knowledge for Skill Evolution"。

## A. libsearch 拆解（已确认：独立工具，复用 ACP 索引）

现状：libsearch 在 dsh-lib-analyzer 里逐行扫描 .dsh-lib-analyzer/pages + reports。
问题：本质是通用扫描方法，且结果孤立（无跨会话记忆）。

方案：
1. session-handoff 的 acp_graph 增加"索引外部知识目录"能力：
   acp_graph build 时也扫描索引 .dsh-lib-analyzer/pages 等目录（作为 doc 节点进 graph.db）
2. libsearch（lib-analyzer）改为查 acp_graph 的 FTS5 索引（复用 ACP 索引），不再自己扫文件
3. libsearch 命中自动带出跨会话 checkpoint 上下文（ACP 整理的价值）
4. 无 ACP 图 → libsearch 回退逐行扫描（降级）

## B. dsh-skill-pack 按 WikiSkill 重写

现状：静态挂载 31 个预置 skill（filesystem provider），无演进。
目标：skill 像 wiki 一样被维护，开发经验固化成 skill 的一部分。

### B.1 三层知识架构（~/.dsh/skill-wiki/）
- raw/（不可变）开发经验轨迹：每次任务/会话的执行轨迹（工具调用、失败、成功策略）
- wiki/（累积知识）：
  - patterns/<name>.md —— 具体失败模式/成功策略 + 可操作 workaround
  - logs.md —— 演进日志（Wiki Maintainer 更新：每个迭代接受/拒绝了什么）
  - skill-impact.md —— skill 影响跟踪（验证后程序化更新）
- skills/ —— 可执行 skill（SKILL.md，前身是预置的 31 个 + 演进新增）

### B.2 演进循环（新增工具）
- skillwiki_consolidate：Wiki Maintainer —— 读 raw/ 经验 → 诊断失败/提取成功 → 写 patterns/ + logs.md
- skillwiki_propose：Skill Proposer —— 读 wiki 索引 + skill-impact + 结果摘要 → 提议 skill 创建/增量编辑
- skillwiki_gate：Gating —— 验证候选 skill（可手动确认），score>best 接受否则回滚
- skillwiki_ingest：把当前会话/经验轨迹固化进 raw/（开发经验成为 skill 原料）
- 现有 skill 挂载保留（filesystem provider），演进产生的 skill 写进 skills/ 目录实时生效

### B.3 与 ACP 打通
- skill 影响跟踪用 ACP 图（acp_graph）：skill 更新关联到产生它的 checkpoint/经验
- skillwiki_ingest 从 ACP 图拉取当前会话的 compaction 摘要作为经验源

### B.4 开发经验成为 skill
- 每次调试/重构成功的经验 → skillwiki_ingest 进 raw/ → consolidate 成 pattern → propose 更新对应 skill
- 例如：修 ARK-C provider 的经验 → pattern "anthropic-messages 协议绕开 developer role" → 更新 api-config skill

## C. skill 收集
- 加入 awesome-design-md（73 个 DESIGN.md 模板）→ 作为 design-md skill 的资源扩展
- GitHub 找其他高质量 skill（mattpocock/skills 已有；找 claude-skills 生态等）

## 实施顺序
1. libsearch 拆解（session-handoff 加外部目录索引 + lib-analyzer 改查 ACP）
2. dsh-skill-pack 重写（三层架构 + 演进工具）
3. skill 收集（awesome-design-md + GitHub）
