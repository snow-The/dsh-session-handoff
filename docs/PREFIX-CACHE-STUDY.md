# Prefix-Cache 研究：Reasonix 的三段式 vs 我们的 ACP 实测

> 2026-09-11 ｜ 资料源：Reasonix `docs/ARCHITECTURE.md`（main 分支，35k★ Go 项目）+ 我们本机 `~/.dsh/dsh-usage/usage-ledger.json`、`~/.dsh/storages/session_projcache.json`
> 结论先说：**宿主（dsh-agent-loop）本身已实现"不可变前缀"纪律，所以我们实测 98%（远好于 Reasonix 文档说的 <20%）；唯一被我们自己引爆的全量 miss 是 ACP 压缩**（它会 bump `surface.replaceGeneration` → 强制重投影）。长会话（今天 69.8%）就是重灾区。

## 一、一手资料：Reasonix 怎么做的（原话摘录）

**经济前提**（Pillar 1 — Cache-First Loop）：
- DeepSeek 对**缓存命中的输入按 miss 价的 ~10% 计费**；
- 自动前缀缓存**只在上一请求的字节前缀完全一致时**才生效；
- "多数 agent 循环每轮重排、重写或注入新时间戳 —— **实测命中率 <20%**"。

**解法：三段式上下文**
```
┌──────────────────────────────┐
│ IMMUTABLE PREFIX             │  system + tool_specs + few_shots，会话内钉死、哈希、pin
├──────────────────────────────┤
│ APPEND-ONLY LOG              │  只按追加顺序序列化，绝不重写
├──────────────────────────────┤
│ VOLATILE SCRATCH             │  每轮重置，**永不发上游**；折叠进 log 前先蒸馏
└──────────────────────────────┘
```
不变量：① 前缀每会话只算一次；② 日志只追加；③ scratch 先蒸馏再进 log。
**指标**：`prompt_cache_hit_tokens/(hit+miss)` 逐轮暴露（TUI 顶栏有"缓存格"）。

另外三根支柱（与缓存无关但同样值得偷）：
- **Pillar 2 工具调用修复**：`flatten`（>10 参数或嵌套>2 的 schema 拉平成点号形式）、`scavenge`（从 reasoning_content 里捞模型忘记发出的 tool_call）、`truncation`（JSON 被 max_tokens 截断 → 补括号/续写）、`storm`（滑窗内相同 (tool,args) → 抑制并注入反思轮）。
- **Pillar 3 成本控制**：flash 优先（pro 约 12×）；**turn-end 自动压缩**——每轮结束时把 >3000 token 的工具结果压到 3000（"模型读它的那一轮已经拿到全文，后续轮次看摘要，需要再 read 一次远比把它拖着便宜"）；40% 上下文比例**预防性**压缩、80% 紧急；`<<<NEEDS_PRO>>>` 由模型自报升档。

## 二、我们的实测（不是估算）

**总计（`session_projcache.json`，191 个 >100k token 的会话）**

| 指标 | 值 |
|---|---|
| 缓存命中 token | 10,603.9 M |
| 未命中 token | 208.7 M |
| **合计命中率** | **98.1%** |
| ≥95% 的会话 | 134 个 |
| <95% / <90% / <50% | 57 / 17 / 2 个 |

**近 12 天账本**：87.0M miss + 1,359.5M cache = **94.0%**，成本 **¥77.12**，3,988 次调用。

**分模型**：`deepseek-flash` 99.6% ｜ `deepseek-v4.1-flash`（新换）98.5% ｜ `deepseek-v4-flash` 92.4% ｜ 某 fast 变体 27%（仅 11 次调用）。

**成本形状（关键）**：miss 只占 **1.93% 的 prompt token**，却占 **16.4% 的 prompt 成本** —— 因为 miss 单价是命中价的 10 倍。

**长会话才是问题**：今天的主会话（14 次调用、1.03M prompt token）命中率 **69.8%** ✗ —— 同一份内容若达到 98% 命中，**该会话 prompt 成本约降 68%**。

## 三、机制定位（读宿主源码得出，不是猜）

**宿主的 `dsh-agent-loop` 已经实现了"不可变前缀"纪律**（`lib/index.js:1019`）：

```js
const commits = this.systemPrompt.project(renderedPrompt, {
  inHistory: preparedCall?.systemPromptUpdate === "in-history",
  startsSeries: startsRequestSeries
    || this.requestSurfaceGeneration !== this.session.surface.replaceGeneration  // ← 压缩会 bump
    || this.toolsChanged(assembly.tools)
});
```

system prompt 只在三种情况下**重新投影**成新的 `system/message`：

| 触发 | 后果 | 我们的可控性 |
|---|---|---|
| **系列开始**（`startsRequestSeries`） | 新前缀 → 该次调用冷启动 | ✗ 宿主行为 |
| **`surface.replaceGeneration` 变化** —— 即 **ACP 压缩/任何 surface 替换** | 强制重投影 + 开新系列 → **整条上下文按 miss 计费** | ✅ **我们完全可控** |
| 工具集变化 | 同上 | ✅ 基本可控（别中途加减插件/工具） |

另外 `index.js:1201` 比较 `previousContext.provider/model/contextWindow`：**换 provider/model 即换缓存域** ✗（这解释了 `deepseek-v4-flash-fast` 那个 27% 的离群点）。

**由此得到真实结论**（比 Reasonix 的 "<20%" 说法精确得多）：

1. 我们 98% 的合计命中率**不是运气**——宿主的按需重投影就是"immutable prefix / append-only log"的工程实现 ✓；
2. **ACP 压缩是唯一被我们主动引爆的全量 miss** ✗ —— 每次 `acp_compress` 都会 bump `replaceGeneration` → 下一次调用的整条上下文按 miss 计价；
3. 今天长会话 69.8% 的命中率 = **系列开始次数多 + 一次压缩**共同造成 ✓；
4. banner 里 `used` 每步变化**并不会**逐调用作废前缀（它在系列内被冻结 ✓）——所以"freeze banner"是**低价值**改动 ✗，我最初把它排第一是错的；
5. 真正高价值的杠杆是**压缩频率与压缩时机**，以及**避免中途换模型**。

## 四、提案（按 价值/成本 排序，都带验收指标）

| # | 改动 | 预期 | 验收指标 | 成本 |
|---|---|---|---|---|
| 1 ✅ | **压缩成本可见**（已实现：`acp_compress` 追加 `prefix cache invalidated: ~N tokens (≈¥X)`）：`acp_compress` 返回值里带上"本次压缩作废 N tokens 缓存 ≈ ¥X"（按 miss 价计） | 压缩从"免费操作"变成**有价格的决策**，避免为省 1k token 触发 200k 的 miss | 返回值含 `estimatedCacheLossTokens/Cost` | 小（半小时） |
| 2 | **压缩合并 + 时机**：优先"少而大"，且只在**系列边界**（轮末）压缩，不在轮中反复压 | 每会话压缩事件数 ↓ → 全量 miss 次数 ↓ | 每会话 `acp_compress` 次数、长会话命中率 69.8% → ≥95% | 小～中 |
| 3 ✅ | **逐会话缓存指标**（已实现：`acp_status` 输出来自 `lib/cache-stats.js`；实测本会话 98.5% 命中、miss 占 13% prompt 成本）：把 `cacheRead/(cacheRead+uncached)` 显示在 `acp_status`（账本已有数据 ✓） | 让这类回归**可见**（现在的 98% 是"看账本才知道"） | `acp_status` 输出含本会话命中率 | 小 |
| 4 | **turn-end 工具结果收缩**（借 Reasonix Pillar 3）：轮末把 >3k token 的工具结果压到 3k，而不是靠整表压缩 | **降低压缩事件数**（正文变小 → 更晚触发阈值） | 每会话压缩次数 ↓ | 中 |
| 5 | **storm 抑制**：滑窗内相同 `(tool,args)` 抑制 + 注入反思 | 省 token（今天我自己就重复跑过同样的 grep ✗） | 重复调用计数 | 中 |
| 6 | ~~banner 冻结~~ | 低价值 ✗（系列内已冻结） | — | — |

## 五、可测的判定实验（改完 #1/#2 之后）

**假设**：ACP 压缩是长会话 miss 的主要来源（代码路径已确认 ✗→✅ 的因果）。

**设计**：同一 profile、两个内容相同的长会话：
- A 组：按现状，触阈值就压；
- B 组：压缩后立刻再跑 3 轮相同任务，观察第二、三次是否恢复高命中。

**判据**：B 组在压缩后的**下一次调用**应看到一次全量 miss，之后回到 ≥95% ✓；若持续低命中，说明还有第三个重投影源（再用 `acp_status` 的 `replaceGeneration` 定位）。

**注意**：headless 档一次只跑一轮 ✗、`web` 档要交互 ✗ —— 要做这个实验，**先落 #3 的指标**（把逐会话命中率放进 `acp_status`），否则没有观测量。

## 六、不能照抄的地方（避免踩坑）

- Reasonix 是**独立 CLI**（Go，35k★），不是 DSH 插件 —— 只能借设计，不能装。
- 它的 `turn-end` 收缩本身也是"重写"✗，只是把重写**集中到轮末一次**（一次 miss 而不是多次）——这一点值得学，但别以为它不需要付缓存代价。
- 我们的 3,988 次调用统计里，**同一轮内的重复发送**占了绝大多数缓存读 —— 单看合计命中率会**高估**健康度 ✗（要按会话长度分层看）。
- `deepseek-v4-flash-fast` 那个 27% 的离群点提示：**换模型 = 换缓存域**（不同模型缓存不互通），频繁切换模型会持续冷启动 ✗。


---

## 附：已实现（2026-09-11，commit 见仓库历史）

`lib/cache-stats.js`（新）+ `lib/index.js` 两处接线：

| API | 作用 | 实测输出（真实账本） |
|---|---|---|
| `readSessionCache(sessionId)` | 只读宿主按会话的 usage 行；**无数据返回 null，绝不返回假 0** | `{hits: 3513708672, misses: 52516278, hitRate: 0.9853}` |
| `formatCacheLine(stats)` | 一行状态 | `prefix cache: 98.5% hit (3.5B cached / 52.5M miss) — misses are 13.0% of prompt cost` |
| `compactionCacheLoss(promptTokens, price)` | 压缩的缓存代价 = 整个 prompt × (miss − hit) 价格 | `{tokens: 200000, costCNY: 0.18}` |

- 配置：`session-handoff.cacheMissPricePerMTokens`（默认 1，仅用于把 token 换算成钱）
- 测试：`test/cache.test.mjs` 7 项（含"截断的存储必须降级为 null 而不是抛异常/假 0"）→ 全套 **53/53**
- 生效时机：**下次 DSH 启动**（插件在启动时载入）
