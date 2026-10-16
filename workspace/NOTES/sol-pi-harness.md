# SoL-Pi 学习笔记 & Harness 强化路线

仓库：`https://github.com/NVlabs/SoL-Pi`（NVIDIA，2026）
目标 Pi 版本：0.85.1（同时兼容 0.84.2）
我们当前版本：@earendil-works/pi-coding-agent **v1.2.0**

## 一、SoL-Pi 是什么

一个**独立**（不修改 pi 源码）扩展，在 pi 之上一层做了**纯效率优化**。核心思路：

> 在保证任务结果和证据的前提下，减少 token 流量、推理工作量和 agent 轮次。

四个机制（按数据流方向）：

| 机制 | 钩入点 | 节省什么 |
|---|---|---|
| **Action Fusion** | `pi.registerTool()` 替换 `edit`/`write` | edit+验证命令 合并成 1 次 tool call（1 个 round-trip） |
| **ObservationPack** | `pi.on("context")` 投影层 | 大结果前 N 次全发，之后稳定占位符 + `obs_recall` 精确分页召回 |
| **Evidence-Preserving Reducer** | `pi.on("tool_result")` | 弱模型先读长诊断日志，每个引用字面校验，错就 fallback |
| **Online Context Compact** | `turn_end` + `agent_settled` + `session_compact` | 在 plan step 完成时主动压缩，cache write/read ratio 经济决策 |

## 二、SoL-Pi 的 4 条原则（精炼）

1. **No Pi patches** — 只用公开 API，不 fork
2. **Explicit opt-in** — 默认全关，按需启用（不是 openAt JSON 而是"缺失即禁用"）
3. **Preserve evidence** — 失败开放（fail open），原数据永远不破坏

5. **Use Pi's runtime choices** — model / auth / shell 由 Pi 决定，扩展只补一件事

> 推论：扩展的成功 = "Pi 不知道我在场，但效率上去了"。

## 三、值得学习的工程模式（按重要性排序）

### 1. 工厂 + 注入 config loader（测试友好）

```ts
export function createSolPiExtension(
  loadConfig: SolPiConfigLoader = (ctx) => loadSolPiConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()),
): ExtensionFactory {
  return (pi) => { ... };
}
```

**应用**：我们所有新机制都应设计成可注入配置 + 可注入 SessionManager/ModelRegistry 的双参数工厂。

### 2. 失败开放（fail open）— 优化失败 ≠ 任务失败

```ts
} catch (error) {
  // Fail open: a packing failure must never cost the agent its observation.
  console.error(`[observationpack] fail-open for tool result: ${reason}`);
}
```

**应用**：每一个 transform / projection / reduction 节点都要包 try/catch，错误回退到原始数据。

### 3. Journal 日志 — 决策可追溯

```ts
await ledgerFor(ctx)({
  event: "fallback",
  toolCallId: event.toolCallId,
  sourceSha256: archive.hash,
  reason: checked.reason,
  usage: provider.usage,
});
```

每个机制都有 append-only JSONL ledger 记录每次决策（candidate / provider_response / fallback / applied），便于事后审计。

**应用**：我们现有的 session log 是完整事件流，但缺少"为什么这个观测被压缩了"这种语义化记录。建议在 `session-dir/sol-pi/<session-id>/` 目录下加上决策 journal（这是 SoL-Pi 已经做好的模式）。

### 4. 配置 schema 严格校验 — 加载即失败

```ts
for (const key of FEATURE_KEYS) {
  if (record[key] !== undefined && typeof record[key] !== "boolean") {
    throw new Error(`SoL-Pi config ${key} must be boolean: ${path}`);
  }
}
```

未知 key、版本错误、类型错误 → 致命错误立即暴露。**绝不**默默用默认值。

**应用**：我们 settings.json / project options 应该采用同款 strict 校验。

### 5. Cache write/read ratio 经济决策

```ts
const incrementalCacheCostRatio = Math.max(0, cacheWriteReadRatio - 1);
const newDebtTokens = postCompactionTokens * incrementalCacheCostRatio;
const breakevenRequests = newDebtTokens / savingTokens;
const compact = savingTokens > 0 && breakevenRequests <= effectiveHorizonRequests;
```

压缩本身也会写入 cache（新的 summary），所以**每次压缩都产生 cache debt**，必须追踪并在未来请求中"偿还"。

**应用**：当我们引入"自动 compaction"或"observation pack"类机制时，必须考虑 cache 写入的边际成本（默认 12.5x read）。

### 6. 窗口保护 = 绝对（不可冷却）

```ts
// Window protection stays absolute: near the context limit, compact even in cooldown.
const economicAllowed = economic && !cooldownActive;
const compact = compressible && (windowProtection || economicAllowed);
```

冷却只是经济决策的延迟，**窗口压力是不可逾越的红线**。

### 7. 文件级 mutation queue（防止 read-modify-write race）

```ts
export async function withFusedFileQueue<T>(filePath: string, work: () => T): Promise<T>
```

> **重要**：v1.2.0 我们已经导出了 `withFileMutationQueue`！SoL-Pi 当时需要自己写是因为它针对 0.85.1。**现在任何新机制应直接复用**。

### 8. 决策状态可恢复（session 重启不丢失）

```ts
export const ONLINE_STATE_ENTRY = "sol-pi-online-context-state-v1";
state = restoreOnlineState(context.sessionManager.getBranch());
```

OCC 把 plan / request horizon / cache debt 等所有运行时状态存为 session 自定义条目，重启后从 entries 重建。

**应用**：我们的"长会话助手"或"压缩计划"应该使用 Pi 的 `pi.appendEntry()` 持久化状态，而不是文件。

## 四、我们当前 v1.2.0 已经具备的好东西

确认了 SoL-Pi 依赖的所有公开 API 在我们这里都有：

- ✅ `createEditToolDefinition` / `createWriteToolDefinition` / `createBashToolDefinition`
- ✅ `withFileMutationQueue`（SoL-Pi 的 queue 改用这个）
- ✅ `pi.on("context")` / `pi.on("context_with_system")`
- ✅ `pi.on("tool_result")` / `pi.on("tool_call")`
- ✅ `pi.on("session_start")` / `pi.on("session_compact")` / `pi.on("session_before_tree")` / `pi.on("session_tree")`
- ✅ `pi.on("before_provider_request")` / `pi.on("before_agent_start")` / `pi.on("turn_end")` / `pi.on("agent_settled")` / `pi.on("agent_before_settle")`
- ✅ `pi.on("input")` / `pi.on("user_bash")`
- ✅ `pi.on("cache_warming_decision")` ← SoL-Pi 0.85.1 没有
- ✅ `pi.on("provider_stream_event")` / `pi.on("before_provider_headers")` ← SoL-Pi 0.85.1 没有
- ✅ `ExtensionContext.compact()` / `getContextUsage()` / `getSystemPrompt()`
- ✅ `ExtensionContext.modelRegistry` / `model` / `sessionManager`
- ✅ `SessionManager.getSessionDir()` / `getSessionId()`
- ✅ `pi.sendMessage({ triggerTurn: true })` / `pi.appendEntry()`
- ✅ `truncateHead/Tail/Middle` （v1.2.0 内置，比 SoL-Pi 自己写的好）
- ✅ `EventBus`（v1.2.0 新增，扩展间通信）
- ✅ 内置的 `compaction.ts`（`compact()` / `prepareCompaction()` / `findCutPoint()` / `shouldCompact()`） ← SoL-Pi 必须自己实现
- ✅ `CacheWarmingDecision` 类型（cache-aware compaction 信号）

## 六、我们目前没有但 SoL-Pi 有的能力

| 能力 | 我们 v1.2.0 | SoL-Pi 增量 |
|---|---|---|
| Action Fusion (then_run) | ❌ | +1 round-trip / 改动 |
| Observation Pack (obs_recall) | ❌ | 长结果 token 节省 60%+ |
| Evidence-Preserving Reducer | ❌ | 长 build log 节省 ~37% |
| Online Context Compact | ⚠️ 部分（自动 compaction） | + cache 经济决策 + plan-step 触发 |
| Cache write/read ratio | ❌ | 压缩经济学的核心输入 |
| Likely-secret 检测 | ❌ | reducer 安全护栏 |
| Per-session archive dir 自动 fallback | ❌ | `--no-session` 兼容 |
| Factory + injected loader | 部分（`createToolDefinition`） | 测试覆盖率更高 |

## 七、Harness 强化路线（按风险/收益排序）

### Phase 1：基础 - 引入 cacheWriteReadRatio 配置 + 暴露相关 API

收益：所有后续机制都依赖这个经济学输入。
成本：1 个 PR，纯配置层。

**具体工作**：
1. 在 settings 中加入 `cacheWriteReadRatio`（默认 12.5）
2. 在 `ExtensionContext` 或 `AgentSession` 暴露该值
3. 在 `compaction.ts` 的 `shouldCompact` 中可选择性考虑该比例

### Phase 2：Action Fusion - 内置 then_run 参数

收益：高频操作（write/edit + 立即运行测试）每次省一个 round-trip。
成本：低，因为我们已经导出了 `withFileMutationQueue`。

**具体工作**：
1. 在 `dist/core/tools/edit.ts` 和 `write.ts` 的 schema 中加入 `then_run` 可选参数
2. 复用 `withFileMutationQueue` 而不是再写
3. 复用 `createBashToolDefinition(ctx.cwd)` 跑命令
4. 复用 `createEditToolDefinition(ctx.cwd).execute()` 跑 mutation
5. 加 hash-guard 防内容变化（`assertUnchangedBeforeCommand`）
6. 失败开放：mutation 成功但 command 失败也要返回 mutation 结果

### Phase 3：ObservationPack - 大结果归档 + obs_recall 工具

收益：长 build output 第二次起只发 placeholder，token 节省巨大。
成本：中，需要：
- ledger 设计
- 新增 `obs_recall` 工具
- `pi.on("context")` projection hook
- `pi.on("tool_result")` archive 钩子
- 稳定 ID 设计

**关键决策**：
- FULL_SENDS 默认 1 还是 2？（SoL-Pi 默认 2，更安全）
- 归档用文件还是 session entry？（SoL-Pi 用文件 + JSONL ledger；我们可以用 `pi.appendEntry` 存归档引用 + 实际文件）
- 占位符前缀要带 observation id，让模型知道怎么召回

### Phase 4：Evidence-Preserving Reducer（可选，高风险）

收益：长日志的第一次读取外包给便宜模型。
成本：高：
- 需要配置"reducer model"路由
- 验证逻辑复杂（每条引用必须字面匹配原文）
- LIKELY_SECRET 检测不能漏
- 失败 fallback 必须可靠

**先决条件**：Phase 1 + Phase 3 都完成。

### Phase 5：Online Context Compact（可选）

收益：在 plan step 完成时主动压缩，避免等到窗口压力触发。
成本：高：
- 需要新增 `update_plan` 工具
- 需要 plan 解析、状态追踪、续接请求
- 完整的 cache debt 会计
- window protection 是绝对底线
- 测试需要真实 AgentSession

**先决条件**：Phase 1 完成。

### Phase 6：可能不需要做

| SoL-Pi 特性 | 是否需要内化 |
|---|---|
| Per-session archive fallback（`mkdtempSync`） | ❌ 我们的 `--no-session` 已经有自身机制 |
| `sol-pi-skill`（把宿主对话导出到另一个 pi） | ❌ 我们用户场景不需要这种 hand-off |
| `solpi-visual`（3D scene 重建） | ❌ 领域特定，外置扩展更合适 |

## 八、SoL-Pi 给我们的反例（不要做）

1. ❌ 不应该在 pi 内置里 fork SessionManager（要用现有的）
2. ❌ 不应该隐藏配置错误（fail-loud 而不是 fail-silent）
3. ❌ 不应该让 reducer / OCC 直接写文件而不是用 `pi.appendEntry`
4. ❌ 不应该覆盖 pi 自己的错误处理
5. ❌ 不应该替代 `truncateMiddle` 自己写截断逻辑（用我们内置的）
6. ❌ 不应该引入新的存储路径（用 `runtimeRoot(ctx)` 即 `ctx.sessionManager.getSessionDir()`）

## 九、决策记录

我们当前工作目录 `D:/PI/workspace/SoL-Pi/` 只是为了学习，不打算内化为我们自己的依赖。我们将逐步把 SoL-Pi 的精华合并到 `@earendil-works/pi-coding-agent` 内部，而不是以扩展形式提供。

---

## 十、实战教训（Phase 2 实做）

### A. 双重 queue 死锁（最关键！）

**问题**：wrap 的 execute() 调用了 `withFileMutationQueue`，但内部又调用 base.execute（write/edit 工具），而 base.execute 内部**也**调用 `withFileMutationQueue`。

**症状**：进程 hang 住，await 永远不返回。

**修复**：**wrap 不能调用 `withFileMutationQueue`**。base 工具已经序列化同文件 mutation，嵌套 mutex = 死锁。

```ts
// ❌ 错：双重 queue 死锁
return withFileMutationQueue(absolutePath, async () => {
  await mutate();  // → 内部又调 withFileMutationQueue
});

// ✅ 对：让 base 自己处理
const result = await mutate();
```

SoL-Pi 的 `file-queue.ts` 文档里特别注释了这一点：
> // Pi's built-in mutation tool keeps its own queue; the two queues are not nested.

我们 phase 2 的扩展 `D:/PI/workspace/extensions/action-fusion/` 已经把这条 lesson 写进注释里了。

### B. v1.2.0 工具 execute 的 ctx 类型变了

**问题**：SoL-Pi 0.85.1 用 `ExtensionContext`，v1.2.0 改成 `ExtensionToolContext`。`ExtensionToolContext extends ExtensionContext`，多了 `tools` 和 `executeTool`。

**症状**：wrap 函数 ctx 类型被推断成 `ExtensionContext`，导致 base.execute 调用 hang。

**修复**：显式标注 wrap.execute 的 ctx 为 `ExtensionToolContext`。

### C. bash 的 isError 不抛错

**问题**：v1.2.0 的 bash 工具**不抛错**，仅设 `result.isError = true` 和 structuredContent.exit_code。

**修复**：在 wrap 里检测 `bashResult.isError`，手动 throw `[then_run:failed]` 错误。

### D. Windows Git Bash 路径转换

**问题**：`node -e "...writeFileSync('C:\Users\...')"` 在 Git Bash 下被转换成奇怪的短路径。

**修复**：在 then_run 命令里用**相对路径**，依赖 bash 的 cwd（ctx.cwd）。

### E. Node 25 + Vitest 不兼容

**问题**：Vitest worker pool 在 Node 25 + Windows 上崩溃退出。

**修复**：改用 Node 内建 `node:test`，零依赖、`tsc` 编译后跑。

### F. ExtensionToolContext 类型必须显式标注 onUpdate

**问题**：`async execute(toolCallId, input, signal, onUpdate, ctx)` 没标注 onUpdate 类型时，TypeScript 推断成 `unknown`。

**修复**：`onUpdate: AgentToolUpdateCallback<TDetails> | undefined`。

---

## 十一、当前 Phase 完成度

- ✅ **Phase 1**（cacheWriteReadRatio 配置 + settings schema）
  - `~/.pi/agent/sol-pi.json` 已加 `"cacheWriteReadRatio": 1.0`
  - 扩展加载时校验（schema strict）
- ✅ **Phase 2**（Action Fusion 实现 + 固化）
  - `D:/PI/workspace/extensions/action-fusion/` PoC 通过
  - 4/4 单元测试通过
  - **固化完成**（13/13 测试）：
    - 自动加载（`pi install` + `pi list`）
    - Edit + Write 都支持 then_run
    - Hash guard（检测 mutation 和 then_run 之间的 race）
    - Decision journal（`~/.pi/agent/decisions.jsonl`）
    - TUI 渲染（`⚡ Action Fusion · fused command` 标记）
    - Off-switch（`actionFusion: false` 时不替换）
    - Strict schema（未知 key / 错误类型立即报错）
    - Project config 优先级
  - 端到端实测（无 `--extension`）：
    - hello.txt + marker.txt 一次性创建
    - decisions.jsonl 记录 4 个决策事件
- ✅ **Phase 3**（Observation Pack）
  - 阈值 4KB以上才打包
  - 前 2 次完整发，之后压缩为占位符
  - `obs_recid` 工具可分页召回
  - 16/16 单元测试通过
  - 端到端实测：5+个工具结果从 13413 字节压缩到 176 字节
  - 每次重复省 ~3000 tokens
- ✅ **Phase 4**（Evidence-Preserving Reducer 启发式版）
  - 只在 build/test 命令的 bash 结果上触发
  - 启发式选 fatal / failure / target / warning / summary 行
  - 每条 evidence 带原文 quote + 行号，可 byte-for-byte 验证
  - 14/14 单元测试通过
  - 端到端实测：tsc 100 个错误 7.4KB → receipt 1KB（省 86%）
  - 9 条 evidence（target×8 + summary×1），状态=failure
- ✅ **Phase 5**（Online Context Compact 简化版）
  - `update_plan` 工具记录 4 步计划
  - 决策函数：over high-water (0.7) 且有 plan boundary 才 compact
  - 经济学：`archive * (1 - ratio) > 2 * memo` 才考虑
  - 21/21 单元测试通过
  - 端到端实测：4 次 plan update + 5 次 decision 决策
  - 本轮 context 仅 5-8%，未实际 compact
- ✅ **Vision Guard** —— 图片静默降级变警告
  - session_start 检查 model.input 是否含 image，stderr 警告
  - input 带图 + model 不支持时，具名警告并给出修复方法
  - 防止 `(image omitted)` 静默吞图

## 实证教训：vision 支持是配置问题不是模型问题

**现象**：用户发图，模型看到 `(image omitted: model does not support images)`。

**错误归因**：以为 MiniMax-M3 / ark-code-latest 不支持视觉。

**真实根因**：`~/.pi/agent/models.json` 里 `"input": ["text"]`。pi 的
`downgradeUnsupportedImages()` 检查 `model.input.includes("image")`，
不含就静默把图换成占位符。

**实证验证**：改成 `["text", "image"]` 后，两模型都准确读出测试图
中的文字 `HARNESS TEST 4287`（PowerShell System.Drawing 生成）。

**机制化**：`extensions/vision-guard/index.ts` —— 以后配置错误
不再静默，启动时和发图时都会警告并给出修复方法。

**方法论**：不要把系统行为的静默降级归因为"模型不支持"，
先实证：改配置 → 真发一次 → 看结果。

- ✅ 全部 5 个 Phase 完成

## 累计结果

| 指标 | 数值 |
|---|---|
| 总测试 | 78/78（含 1 个 25s 集成测试） |
| 扩展文件 | ~ 1800 行 |
| 加载机制 | 7 个全部自动加载（4 核心 + token-tracker + savings-tracker + vision-guard） |
| 端到端验证 | 7/7 机制 |
| 实测 token 节省 | ~50K+ / session |

## 阶段 2 增量（按用户需求顺序）

1. **Token Tracker** —— `extensions/token-tracker/`
   - turn_end stderr 单行 `in X out Y cache R/W Σ...`
   - agent_settled stderr box（turns/messages/cache hit/avg/duration/saved）
   - 12/12 测试
2. **集成测试** —— `tests/integration.test.ts`
   - 启动真实 pi 进程，验证全链路：
     - config_loaded ✓ tools_registered ✓ then_run ✓ token_turn ✓ token_session ✓
     - fused.marker 存在 + 内容正确
   - 1/1 测试（25s）
3. **Savings Tracker** —— `extensions/savings-tracker/`
   - turn_end 重读 journal 累计 obs/red/fuse
   - footer key `sol-pi`：`⚡ N KiB saved (X obs · Y red · Z fuse)`
   - 1/1 测试
4. **Sol-Pi Bundle** —— `extensions/bundle/index.ts`
   - 单一入口注册全部机制
   - 使用方式：`./bundle/index.ts` 作为 pi extension 入口