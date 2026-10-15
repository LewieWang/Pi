# harness-extensions

SoL-Pi 思想的本地实现，作为 v1.2.0 扩展。不修改 pi 源码。

## 当前状态

| 机制 | 状态 | 测试 |
|---|---|---|
| **Action Fusion** (`then_run`) | ✅ 已固化 + 已加载 | 13/13 |
| **Observation Pack** (`obs_recid`) | ✅ 已实现 + 端到端验证 | 16/16 |
| **Evidence-Preserving Reducer** | ✅ 启发式版已实现 + 端到端验证 | 14/14 |
| **Online Context Compact** | ✅ 已实现 + 决策链端到端验证 | 21/21 |
| **Token Tracker** | ✅ 每轮 + session 总结 | 12/12 |
| **Savings Tracker** | ✅ Footer live counter | 1/1 |
| **Bundle** | ✅ 单一入口安装 | — |
| **Integration** | ✅ 25s 真实 pi run | 1/1 |

## 已固化（Phase 2 完整化）

- ✅ **自动加载** —— `pi install ./extensions` 后每次 pi 启动都生效
- ✅ **Edit + Write 两种工具** 都支持 `then_run`
- ✅ **Hash guard** —— 检测 mutation 和 then_run 之间是否有外部写入
- ✅ **Decision journal** —— 每次 append 到 `~/.pi/agent/decisions.jsonl`
- ✅ **TUI 渲染** —— 显示 "⚡ Action Fusion · fused command" 标记
- ✅ **Off-switch** —— `actionFusion: false` 时不替换内置工具
- ✅ **Strict schema** —— 未知 key / 错误类型立即报错
- ✅ **Project config 优先级** —— `<project>/.pi/sol-pi.json` 覆盖 `~/.pi/agent/sol-pi.json`

## 配置

`~/.pi/agent/sol-pi.json`：
```json
{
  "version": 1,
  "actionFusion": true,
  "cacheWriteReadRatio": 1.0
}
```

## 加载

```bash
# 已经安装
pi list  # → User packages: D:\PI\workspace\extensions

# 卸载
pi remove D:/PI/workspace/extensions
```

或在 settings 里加 `"packages": [...]`。

## 开发

```bash
cd extensions
npm install
npm test          # 编译 + node --test (13 tests)
npm run check     # typecheck only
```

## 核心设计原则（来自 SoL-Pi）

1. **No Pi patches** — 只用公开 API
2. **Opt-in** — 默认关闭
3. **Fail open** — 优化失败 ≠ 任务失败
4. **Preserve evidence** — 决策可追溯

## Action Fusion 怎么用

LLM 调用示例：

```json
{
  "path": "src/foo.ts",
  "edits": [{"oldText": "...", "newText": "..."}],
  "then_run": {"command": "npm test", "timeout": 30}
}
```

返回结果包含：
- `[then_run:succeeded]` + 命令输出（成功）
- `[then_run:failed]` + 错误（命令失败）
- `[then_run:skipped]` + 原因（mutation 失败 / hash guard 命中 / 文件消失）

每次执行都 journal 一行到 `~/.pi/agent/decisions.jsonl`：
```json
{"timestamp":"...","kind":"mutation","path":"...","outcome":"ok"}
{"timestamp":"...","kind":"then_run","path":"...","outcome":"succeeded","command":"...","duration_ms":140}
```

## 实战教训（必须看）

详见 `../NOTES/sol-pi-harness.md` 第十节。最关键的一条：

**wrap 不能调用 `withFileMutationQueue`**，base 工具已经序列化同文件 mutation，嵌套 mutex 会死锁。

## 已知限制

1. **Windows Git Bash 路径** —— `then_run` 命令要用相对路径
2. **bash.isError 处理** —— 我们手动检测 `bashResult.isError` 并 throw
3. **Decision journal 无清理** —— 长期累积，建议定期 rotate

## 来源

- SoL-Pi: `https://github.com/NVlabs/SoL-Pi`
- 学习笔记: `D:/PI/workspace/NOTES/sol-pi-harness.md`
- 当前 pi: `@earendil-works/pi-coding-agent v1.2.0`