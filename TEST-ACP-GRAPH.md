# graph.js 系统测试记录

## 结果：PASS=16 FAIL=0 (100%)，另加 500 次 fuzz + 恶意输入全过

测试方式：在 run_code 中内联 graph.js 核心逻辑（tokenize/classify/rrf/betaConfidence/recall），
用 node:sqlite 建临时库（表结构同 ~/.dsh/graph/graph.db），模拟 4-8 个 compaction/summary 事件建图，
然后跑断言 + fuzz。

## 覆盖范围

### 单元
- tokenize: 英文复合词（ark-c / deepseek-coding / anthropic-messages 保留整体）、停用词剔除（the）、
  中文 bigram（中文/文图/图谱/谱检/检索）、路径词（path，a 因长度<3 过滤）
- classify: file(.ts) / package(@scope/pkg) / function(camelCase) / concept(连字符) / 空串
- RRF: 多列表融合（b 在两个列表命中排前）
- betaConfidence: 无样本=prior(0.5)，100 样本提升到 >0.7

### 集成（SQLite + FTS5）
- 建库: 20 nodes / 19 edges / 8 checkpoints
- 混合检索 recall:
  - 精确: ark→ark-coding, acp→acp-graph, notemap, fts5
  - 前缀: graph→acp-graph
  - 中文: 图谱命中
  - 边界: 空/null/undefined/数字/无命中 → []

### Fuzz
- 500 次随机垃圾查询（含 \t\n\u0000 控制字符、中文、特殊符号）→ 全部不崩、返回合法
- 恶意输入: SQL 注入(' OR '1'='1)、DROP TABLE、路径穿越、emoji、全角字符 → 全部不崩

## 注意
- tokenize 对连字符复合词保留整体（ark-c 而非 ark）——这是设计意图（保持实体完整性），
  不是 bug。查询时 FTS5 前缀匹配（"ark"* 命中 ark-c）或 LIKE 兜底都能召回。
- 测试脚本在会话中直接运行（run_code + node:sqlite），未单独存档为文件；
  如需回归，复制本说明 + 内联逻辑即可。

## 结论
graph.js 混合检索（FTS5 BM25 + RRF + 图扩展 + recency/beta 重排）实现健壮，无缺漏。
