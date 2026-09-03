# DESIGN-MEMORY.md — 借鉴 TencentDB-Agent-Memory 改进记忆体系

参考：https://github.com/TencentCloud/TencentDB-Agent-Memory
核心：**symbolic short-term memory + layered long-term memory**。
效果（OpenClaw 实测）：token −61%、成功率 +51%、PersonaMem 48%→76%。

## TencentDB 两支柱 vs 我们现状

| TencentDB 概念 | 他们做法 | 我们现状 | 差距 |
|---|---|---|---|
| 符号化短记忆 | 重工具日志压成紧凑 Mermaid 符号 | acp_graph 实体抽取（token→节点） | 我们已有"实体化"，可加"工具日志压缩" |
| 分层长记忆 | persona/scene 结构化层（非扁平向量堆） | L1/L2/L3（compaction/graph/native） | 我们已分层 ✓ |
| 渐进披露 | 先给宏观索引，按需深入 | acp_graph recall 先给实体+摘要 | ✓ 已近似 |
| 异构存储 | 不同层用不同存储 | graph.db + skill-wiki + session.jsonl | ✓ 已异构 |

## 可借鉴落地点（session-handoff ACP）

### 1. 符号化压缩（Symbolic condensation）
- 现状：acp_compress 产出纯文本摘要
- 改进：压缩摘要时自动生成**紧凑结构符号**（Mermaid 图 / 实体-关系行），
  而非纯文本。让摘要更省 token、更易图检索。
- 实现：acp_compress 的摘要里追加一段 "[graph: 实体A→实体B, 实体C]" 符号行，
  acp_graph build 已能解析 [entities:...]，可扩展解析 [graph:...]。

### 2. 分层记忆检索（Layered recall）
- 现状：acp_graph recall 只按实体/摘要关键词检索
- 改进：加"会话层"（session 级摘要）+ "概念层"（跨会话聚合实体），
  检索时先概念层 → 再会话层 → 最后具体 checkpoint（渐进披露）。
- 实现：checkpoints 表已有 session_id，加 session_fts（会话聚合摘要）即可。

### 3. 记忆质量指标（PersonaMem 对标）
- TencentDB 用 PersonaMem 衡量"人物记忆准确率"
- 我们可加：skillwiki_ingest 的 from=acp 已把 ACP 摘要作为经验源，
  对标 = 检索命中率（recall 命中是否真的带出相关经验）。

## 结论
我们的记忆体系（ACP 图 + skill-wiki）在"分层 + 异构"上已对齐 TencentDB，
最大差距是 **符号化压缩**（摘要还是纯文本，未结构化）和 **分层检索**（无会话层聚合）。
优先做符号化压缩（改动小、收益直接：省 token + 图检索更准）。

## 实施建议
1. acp_compress 摘要追加 [graph:...] 符号行（session-handoff lib/acp-config.js）
2. acp_graph 增加 session_fts（会话聚合检索）
3. 用 skillwiki_ingest from=acp 把压缩摘要固化进 skill-wiki（已打通）
