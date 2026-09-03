# DESIGN-ACP-MEMORY.md — acp-memory：依赖 ACP 的统一本地记忆体

> 状态：设计稿 v1（待用户确认后实现）
> 参考：OpenViking（理念）、TencentDB-Agent-Memory（分层理念）、meow-memory（本地七层实现）
> 依赖：@snow-the/dsh-session-handoff（ACP graph）

## 1. 背景与动机

- **OpenViking 从未工作**：~/.openviking/pending/ 堆积 21849 个 addMessage（2026-08-17 → 09-03），
  server 从未存在（无进程/端口/配置/exe/docker）。dsh-memory-plugin 只是把捕获转发到不存在的 server。
  → **吸收其记忆理念（capture→recall→注入）为本地实现，移除插件 + 清理 pending**。
- **TencentDB-Agent-Memory 只有客户端**：仓库主推远端 Gateway（TCVDB/COS/Redis + Pipeline Worker），
  openclaw-plugin 纯客户端。**不可本地依赖**。
  → 只借鉴其**四层记忆设计理念**（L0 对话/L1 原子/L2 场景/L3 画像、符号化压缩、渐进披露、Persona+Scene Navigation）。
- **meow-memory 是本地七层实现**：.dsh-meow/memory.db（node:sqlite），soul/user/project/fact/lesson/topic/rules
  七层表 + 全局 wiki + 静态手册进 system prompt + 首轮注入 + 关键词命中 + 艾宾浩斯衰减。**本地实现参考**。
- **目标**：一个**依赖 ACP graph** 的本地统一记忆插件 acp-memory，把 openviking/TencentDB/meow 的理念
  融合进 ACP 生态，纯本地（node:sqlite），KV 缓存友好，配合 ACP 压缩实现"压缩不失忆"。

## 2. 设计原则

1. **纯本地**：node:sqlite，无远端依赖，无 LLM 硬依赖（规则打底，LLM 按需）。
2. **依赖 ACP**：acp_graph 是记忆的图谱层（跨检查点实体/关系），acp-memory 是其上的记忆语义层。
3. **分层**（TencentDB 语义）：L0 对话（session.jsonl 原生）/ L1 原子（七层表）/ L2 场景（project/topic 聚合）/ L3 画像（soul/user/rules）。
4. **符号化**：压缩摘要带结构化符号（[graph:...]/[entities:...]），省 token、利图检索。
5. **渐进披露**：先给索引/摘要，按需深挖（Scene Navigation 理念）。
6. **KV 缓存友好**：稳定层（Persona + Tools Guide + Scene Nav）静态注入，动态层（L1 命中）pre-step 注入。
7. **压缩不失忆**：compaction 后重注入长期记忆快照 + 项目全景（meow 理念）。
8. **兼容降级**：ACP（session-handoff）不存在时，acp-memory 仍可用规则记忆，图谱能力降级。

## 3. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  acp-memory（@snow-the/dsh-acp-memory）                     │
│  依赖 → @snow-the/dsh-session-handoff（ACP graph）           │
│                                                            │
│  ┌──────────────┐   ┌──────────────────────────────────┐   │
│  │ 七层记忆表    │   │ 图谱层（复用 graph.db + graph.js） │   │
│  │ memory.db    │   │  nodes/edges/checkpoints/docs     │   │
│  │ soul/user/   │   │  + acp_graph 多命令工具           │   │
│  │ project/fact │   │  + graphRecall/graphHotEntities   │   │
│  │ lesson/topic │   └──────────────────────────────────┘   │
│  │ /rules        │                                          │
│  └──────┬───────┘                                           │
│         │ import { graphRecall, graphHotEntities }          │
│         │        from session-handoff                       │
│  ┌──────┴──────────────────────────────────────────────┐   │
│  │ 捕获（capture）：session/event → 符号化 → 抽取 → 存储  │   │
│  │ 召回（recall）：pre-step → 并行检索 → 格式化注入       │   │
│  │ 注入（inject）：稳定层（静态）+ 动态层（命中）          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
       数据：~/.dsh/memory/memory.db（node:sqlite，全局）
```

### 数据位置
- 七层记忆：~/.dsh/memory/memory.db（node:sqlite，全局，跨工作区共享——用户拍板"全局 wiki"）
- 图谱：~/.dsh/graph/graph.db（session-handoff 已有）
- 会话已见记录：~/.dsh/memory/sessions/<sessionId>.json（meow 风格）

## 4. 数据模型（七层表，meow 风格）

| 层 | 表 | 关键列 | 语义（TencentDB 对应） |
|---|---|---|---|
| L3 | soul | content, importance | AI 自身设定（Persona 基础） |
| L3 | user | content, importance | 用户偏好/基本信息（L3 画像） |
| L2 | project | name, subcategory, content | 项目（overview/structure/decisions/quotes/ops/todo） |
| L1 | fact | content(≤60字), project?, keywords | 原子事实（L1） |
| L1 | lesson | content(≤60字), project?, corrected | 教训（L1 特殊类） |
| L2 | topic | title, goal, content | 进行中话题（目标句） |
| L3 | rules | content, importance | 全局设计原则/行为准则 |

通用列：id（时间前缀 base36+随机，排序=创建序）、created_at、updated_at、status（active/archived/stale）、keywords（JSON 数组，检索用）。

```sql
-- 每层一表（数据结构不同，用户拍板）
CREATE TABLE IF NOT EXISTS soul   (id TEXT PRIMARY KEY, content TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS user   (id TEXT PRIMARY KEY, content TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS project(id TEXT PRIMARY KEY, name TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT 'overview', content TEXT NOT NULL, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS fact   (id TEXT PRIMARY KEY, content TEXT NOT NULL, project TEXT, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS lesson (id TEXT PRIMARY KEY, content TEXT NOT NULL, project TEXT, corrected INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS topic  (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT, content TEXT, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS rules  (id TEXT PRIMARY KEY, content TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]');
```

全局标记：project.name = '全局'（跨项目共享，meow 的 globalProjectMarker 概念）。

## 5. 数据流

### 5.1 捕获（capture）
```
session/event（user/assistant 消息）
  → 符号化压缩（规则：工具日志 → 紧凑符号行 [graph:...]）
  → L1 抽取（混合：规则打底提取实体/关键词；LLM 按需精炼成 fact/lesson/user 偏好）
  → 写入 memory.db（七层表）
  → 实体同步进 graph.db（调 indexDocsDir 或直接写 nodes/edges）
```
- 排除 plugin 注入消息（openviking capture 的白名单理念）。
- LLM 抽取受阈值控制（turn/end token 阈值，openviking commitTokenThreshold 理念）。

### 5.2 召回（recall）
```
pre-step（用户消息前）
  → 并行：
      ① L1 搜索（BM25 × 近期权重 × 艾宾浩斯衰减，meow bm25.ts 移植）
      ② L3 Persona（soul/user 全量 + rules importance≥2）
      ③ L2 项目全景（当前 project 的 project/topic 条目）
      ④ ACP 图谱（graphRecall(query) → 跨检查点实体/摘要）
  → 格式化注入：
      稳定层（Persona + Scene Nav + Tools Guide）→ 静态（KV 缓存友好）
      动态层（L1 命中 + ACP 图谱命中）→ pre-step plugin 消息
```

### 5.3 注入策略
- **首轮注入**：soul/user 全量 + 记忆导引（project/topic 标题列表）+ 关键词命中 top-2。
- **每轮**：pre-step 动态命中（top-2）+ ACP 图谱融合。
- **压缩后重注入**：收到 compaction/* 信号 → 下一用户消息轮重注入长期记忆快照 + 项目全景（meow reinjectPending 理念）。
- 去重：.dsh/memory/sessions/<id>.json 记录 injected/searched/accessed，已注入不重复。

## 6. 工具集

| 工具 | 命令 | 说明 |
|---|---|---|
| memory_remember | 写 | 必填 content/project/keywords；自动去重合并；返回读回确认 |
| memory_search | 检索 | 七层检索，支持 level/project/status/days 过滤，top10 |
| memory_project | 项目全景 | 按 subcategory 分组注入项目信息（Scene Navigation） |
| memory_read | 读 | 按 id 读单条记忆 |
| memory_update | 改 | 更新内容/关键词/状态 |
| memory_find_similar | 查重 | 冲突检测 |
| acp_recall | ACP 融合 | 调 graphRecall + 七层记忆，返回跨检查点记忆视图 |

## 7. ACP 配合（核心差异化）

1. **跨检查点检索**：线性 surface 看不到被压缩掉的内容，acp_recall 调 graphRecall 找回。
2. **热实体提示**：graphHotEntities(5) 在首轮注入末尾追加，引导模型关注高频实体。
3. **符号化摘要**：memory_remember 支持 [entities:...]/[graph:...] marker，acp_graph build 已能解析。
4. **会话级聚合**：checkpoints 表已有 session_id，可做 L2 场景聚合（跨会话同一实体）。
5. **压缩不失忆**：compaction 事件 → 重注入（图数据不受压缩影响，因为来自 graph.db）。

## 8. 里程碑

- **M1（核心骨架）**：插件脚手架（cordis.patch.yml + index.js + memory.db 建表）+ memory_remember/search/read/update + L1 规则抽取。
- **M2（ACP 融合）**：import graphRecall/graphHotEntities + acp_recall 工具 + 首轮注入 + 压缩重注入。
- **M3（LLM 抽取）**：turn/end LLM 精炼 fact/lesson/user（阈值控制，可关）。
- **M4（注入完整）**：pre-step 动态命中 + 稳定层静态注入 + 项目全景 + 已见去重。
- **M5（清理 OpenViking）**：从 profile 移除 @openviking/dsh-memory-plugin + 清理 21849 pending。
- **M6（部署验证）**：安装到 web profile + boot 验证 + 记忆读写实测。

## 9. 风险与取舍

- **LLM 抽取成本**：默认规则打底（零成本），LLM 精炼默认关/低频（M3 可配置阈值）。
- **七层 vs 四层**：meow 七层更细（topic/rules 独立），符合用户"全局 wiki"需求；TencentDB 四层是语义映射。
- **与 notemap/lab 关系**：notemap/lab 已各自融合 ACP；acp-memory 是**统一的记忆语义层**，
  notemap（图可视化）/lab（研究）可继续独立，acp-memory 提供跨会话记忆底座。
---

## 10. 实现架构 v2（用户确认：混合方案）

### 10.1 模块级分离（core/dsh 解耦）
```
dsh-acp-memory/                      # ~/.dsh-starter/plugins/dsh-acp-memory（TS + esbuild）
├── package.json                     # @snow-the/dsh-acp-memory
├── cordis.patch.yml                 # dsh.bundle.patch
├── tsconfig.json
└── src/
    ├── index.ts                     # DSH 插件薄层：apply() 注册 hooks/tools（调用 core）
    ├── core/                        # ★ 核心引擎（零 DSH 依赖，可独立测试/复用/日后 server 化）
    │   ├── db.ts                    #   memory.db 七层表 + CRUD（node:sqlite）
    │   ├── pipeline.ts              #   L1→L2→L3 抽取（规则打底 + LLM 按需）
    │   ├── recall.ts                #   BM25 × 近期 × 艾宾浩斯衰减
    │   └── acp.ts                   #   读 graph.db（数据层依赖，research-lab 模式）
    └── dsh/                         # ★ 适配层（薄）
        ├── hooks.ts                 #   capture/recall/inject（session/event + pre-step）
        └── tools.ts                 #   memory_* / acp_recall 工具定义
```

### 10.2 复用 ACP graph 的方式：数据层依赖（research-lab 已验证）
- **不 import session-handoff 的 JS**（exports 未暴露 ./graph）→ 改为**直接读 ~/.dsh/graph/graph.db**
- `acpGraphPath()` = `$DSH_HOME/graph/graph.db`（join(homedir(), '.dsh')）
- `acpGraphAvailable()` = 文件存在 && checkpoints 非空
- `acpGraphRecall(query, limit)` = FTS5 实体命中 → checkpoint 摘要；无图返回 []（完全降级）
- acp-memory 的 core/acp.ts 复刻 research-lab src/acp.ts（已验证可工作）

### 10.3 与现有插件的关系
| 插件 | 角色 | 与 acp-memory 关系 |
|---|---|---|
| session-handoff | ACP 图谱 + 压缩 | acp-memory 的数据源（graph.db） |
| research-lab | 项目研究 | 已独立融合 ACP（读 graph.db） |
| notemap | 图可视化 | 已独立融合 ACP |
| **acp-memory** | **统一记忆语义层** | **七层记忆 + capture/recall/inject，跨会话底座** |
