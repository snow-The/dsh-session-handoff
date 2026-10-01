# Compatibility

> 本文件由 `~/.dsh-starter/plugins/_p0/gen-compat-docs.mjs` 从插件清单与宿主实测**生成**。
> **请勿手改** —— 手改的内容会被下一次生成覆盖。要改，改生成器或改 `package.json`。
>
> 生成器版本 `1.0.0` · 宿主 `0.2.0-rc.2` · 插件 `@snow-the/dsh-session-handoff@0.18.13`
>
> 代际下界与 `dshReleases` 的**单一事实源**是 `_p0/floor.json`。切换世代改那一个文件，然后重跑本生成器。

## 支持的 dsh 版本

| 项 | 值 |
|---|---|
| `dsh.compatibility.dshReleases` | ["0.2.0-rc.1","0.2.0-rc.2"] |
| `dsh.compatibility.verifiedAgainst` | `0.2.0-rc.2` |
| 官方 peer 声明 | `dsh` >=0.2.0-rc.1<br>`dsh-home-paths` >=0.2.0-rc.1<br>`dsh-session-persistence-jsonl` >=0.2.0-rc.1<br>`dsh-tools` >=0.2.0-rc.1 |
| 本次宿主判定（`0.2.0-rc.2`） | **PASS** |

## 门禁到底是什么（宿主实际执行的判定）

真正决定这个插件**会不会被静默禁用**的**只有 `peerDependencies`**。宿主逻辑：

```js
// @deepseek-ai/dsh-app-boot/lib/index.js:286-313  evaluatePluginCompatibility()
:289  if (!Object.hasOwn(fields, "peerDependencies")) return void 0;   // 无 peerDependencies = 完全不检查
:294  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;  // 只查 dsh / dsh-*
:300  if (requirement.trim() === "" ||
:300      !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range;
```

两个容易误解的点：

1. `runtimeVersion` **不是** `dsh` CLI 的版本，也不是每个包各自安装的版本 —— 它是 `@deepseek-ai/dsh-app-boot` **自己的 package.json** 版本（`lib/index.js:271-275`）。**所有 peer 都拿这同一个版本比对。**
2. 比较带 `{ includePrerelease: true }`，所以 `0.2.0-rc.2` 满足 `<0.2.0`。**带上界的范围今天能过，到正式版就会落闸** —— 这就是本文件要求纯下界的原因。

> ⚠️ **`dsh.compatibility` 这个清单字段，宿主【不读】。** 全安装树零处引用。它是**本仓库自己的记录**，供人读与 CI 用。
> profile 级别的豁免文件是另一回事：`<profile>/compatibility.json`，由 `dsh plugin allow-version` 写入。

## 本次验证了什么

用**宿主自己的** `evaluatePluginCompatibility`（不是我们自己实现的等价物）在本机安装树的版本上判定本插件的真实 `package.json`：

```
插件        @snow-the/dsh-session-handoff@0.18.13
宿主        0.2.0-rc.2
判定        PASS（peerDependencies 无冲突，不会被禁用）
```

**这个判定的含义要说清楚：它只证明「宿主不会在预检阶段禁用本插件」。它不证明插件能正常工作。**

## 本次【未】验证什么

这一节是本文件最重要的部分。以下都**没有**被验证过：

- **除上述宿主版本外的任何 dsh 版本。** 声明是纯下界，所以更高的版本会在门禁上通过 —— 但**通过门禁不等于 API 仍兼容**。
- **实际功能**。本插件的工具/路由/客户端是否真的工作，本次没有端到端跑过。
- **客户端在浏览器里的真实挂载**。没有开浏览器验证 UI 是否出现、槽位是否被宿主声明。
- **本插件的测试套件**。仓库里有测试，但本次这一轮没有运行它们。
- **与其他插件的同时加载**。单个插件通过门禁不排除插件之间互相冲突。
- **卸载/升级路径**。

## 能力面（由静态扫描得到，可能不精确）

本插件不 import 任何官方包，只通过宿主注入的 ctx 服务工作。

客户端面：`dsh.client.platform = "web"`，`inject = ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-slots"]`。

`dsh.client.inject` 列的是**包名**（客户端模块图里必须先加载的包），与服务注入（模块自己 `exports.inject` 里的**服务名**，如 `slots`/`locale`/`sessions`）**是两回事**。

## 如何重新验证

```sh
# 用宿主自己的判定函数跑所有插件的真实清单
node ~/.dsh-starter/plugins/_p0/verify-applied.mjs

# 对 profile 里【宿主实际读取的那一份】再跑一遍
node ~/.dsh-starter/plugins/_p0/verify-installed.mjs

# 真启动测试（stderr 应为空）
dsh web --port <随机冷端口> --no-open
```

## Scope

本文件只覆盖**加载期兼容性**这一个问题。它不描述插件做什么、怎么用、配置项是什么 —— 那些看 `README.md`。
