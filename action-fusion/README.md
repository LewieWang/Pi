# Action Fusion (本地版)

**状态**: PoC
**目标 Pi**: `@earendil-works/pi-coding-agent v1.2.0`
**参考**: `https://github.com/NVlabs/SoL-Pi` (src/sol-pi/extensions/action-fusion/)

## 目的

让 `edit`/`write` 工具可以带一个可选的 `then_run` 参数：
- mutation 成功后立刻跑命令
- 命令结果拼接到同一个 tool 返回
- 省 1 个模型 round-trip

## 用法

LLM 调用：

```json
{
  "path": "src/foo.ts",
  "edits": [{"oldText": "...", "newText": "..."}],
  "then_run": {"command": "npm test", "timeout": 30}
}
```

## 设计原则

按 `AGENTS.md` 4 条：

1. **No Pi patches** ✅ — 只用公开 API + 替换 `edit`/`write` 注册
2. **Opt-in** ✅ — 默认不启用，`enabled: true` 才替换
3. **Fail open** ✅ — mutation 失败时 `then_run` 跳过（带标记）
4. **Preserve evidence** ✅ — mutation 成功保留，bash 失败带标记不抛错

## 复用 pi 内置

```ts
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  createBashToolDefinition,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
```

> 不重写 mutation queue（v1.2.0 已经导出了 `withFileMutationQueue`）。

## 文件

- `index.ts` — 入口
- `definition.ts` — 工具 schema + execute
- `hash-guard.ts` — 防 mutation 和 command 之间文件被改