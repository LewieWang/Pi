# Pi WebUI 使用说明

给 Pi coding agent 套的网页界面（类 Claude Code 的网页版），**自带 ChatGPT 风格历史会话侧栏 + 输入增强（文件 / 图片 / Skill 选揮）+ / 命令实时补全 + 图片灯箱 + Markdown 渐进渲染 + 上下文状态栏 + 长对话折叠 + 源头防空会话（懒创建 + 启动清扫）+ 空白消息清理**。

## 启动（最简单）

双击 `start.bat`，浏览器会自动打开 http://localhost:3210

## 启动（手动方式）

在 PowerShell 或 CMD 里：

```bat
cd D:\PI\pi-webui
node server.js --port 3210 --cwd "D:\你的项目目录"
```

可选参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port <n>` | 3210 | HTTP/WebSocket 端口 |
| `--cwd <dir>` | `process.cwd()` | Pi 的工作目录（Pi 只能读写该目录下的文件） |
| `--session-dir <dir>` | `./sessions`（项目内） | 会话持久化目录 |
| `--ephemeral` | 关 | 临时模式，会话不落盘（旧 `--no-session` 行为） |
| `--name <name>` | — | 初始会话名 |
| `--model <id>` | `minimax/MiniMax-M3` | 默认模型 |
| `--pi <path>` | 自动探测 | Pi 可执行文件路径 |
| `--max-upload <MB>` | 25 | 单文件上传上限（v0.3） |

## 停止

- 双击 `stop.bat`
- 关闭 start.bat 的命令行窗口
- 在服务窗口里按 Ctrl+C

## 界面功能

### 主聊天区（v0.1 已存在）
- 左侧：模型切换、token 用量
- 中间：聊天区，流式输出
- 工具调用（读文件/执行命令）会显示为卡片
- 底部：输入框，Enter 发送，Shift+Enter 换行
- 「■ 中断」按钮可打断正在执行的任务

### 历史会话侧栏（v0.2 新增）
- 「＋ 新会话」按钮 — 开新对话（自动保存到 sessions/）
- **按时间分组**：今天 / 昨天 / 本周 / 本月 / 更早
- **点击任一会话** → 立即切换上下文（消息、token 统计全部加载）
- **鼠标悬停** → 显示删除按钮
- **搜索框** → 按标题或首条消息过滤
- **⟳ 按钮** → 重新扫描 sessions 目录
- 顶栏的 **「✎ 重命名」** / **「⊟ 压缩」** / **「⎘ 导出」** 按钮分别对应：
  - `set_session_name` — 改名后再列里也能搜
  - `compact` — 自动压缩上下文，把旧消息摘要腾空间
  - `export_html` — 把当前会话导出为可分享的 HTML

### 输入增强（v0.3 新增）
输入区现在是 ChatGPT 风格：上方显示已选附件 chips，中间是 textarea，下方是 toolbar。

**三种附件方式：**
- **📎 文件 按钮** — 选任意类型文件 → 上传到 `<WORK_DIR>/.pi-uploads/`，消息中插入路径引用，Pi 会用 `read` 工具读取
- **🖼 图片 按钮** — 选图片 → 以 base64 形式内联到 `prompt.images`（原生 Pi 协议）
- **Ctrl + V 粘贴** — 剪贴板里的图片直接走图片路径
- **拖拽** — 把文件 / 图片拖到输入区任意位置自动上传

**@ Skill 下拉：**
- 点 toolbar 的 **@ Skill ▼** → 弹出搜索面板，列出 Pi 当前可用的所有 Skill（从 `get_commands` 过滤 `source === "skill"`）
- 点击某 Skill → 自动在光标位置插入 `/skill:<名称> `，你可以在后面继续写参数
- 默认也会展开 Skill 调用（`/skill:name` 是 Pi 原生命令）

**附件限制：**
- 单文件默认上限 **25 MB**（`--max-upload` 可改）
- 文件名会被清洗：`../` 、控制字符、路径分隔符都会被过滤
- 文件保存在 `<cwd>/.pi-uploads/`，名字加 ISO 时间戳前缀防重名
- 超限会弹错提示（HTTP 413 + 前端 alert）

**示例场景：**
- 「看下这报表」 + 上传 `report.xlsx` → 文件落到 `.pi-uploads/2026-10-15T03-..._report.xlsx`，消息里多一行 `请用 read 工具读取`
- 「这张截图哪里不对」 + 截图 → 图片走 base64 内联
- 「用前端设计 Skill 帮我重新设计」 + 点 `@ Skill ▼ → frontend-design` → 自动插入 `/skill:frontend-design `

### / 命令实时补全 + 图片灯箱（v0.4 新增）
**`/` 补全：**
- 在输入框里打 `/` → 自动在光标上方弹补全面板
- 面板按分组排列：**Skill → 扩展命令 → 提示模板**（跟来源 source 分类）
- 继续打字实时过滤（按名称 + 描述）
- **键盘**：
  - `↓` / `↑` → 上下移动选择
  - `Tab` 或 `Enter` → 补全当前选中项（补完后自动加一个空格方便接参数）
  - `Esc` → 关闭面板
- **鼠标**：直接点某项也会补全
- 面板失焦 150ms 后自动关闭（点面板项不会被吞）

**图片灯箱：**
- 聊天气泡里的图片 / chip 区的缩略图 → 点击 → 全屏放大查看
- 背景 85% 黑色透明 + ESC 关闭 + 点击背景关闭 + ← / → 切换多图
- 多图轮播（同一轮气泡 + chip 合并为一张轮播集）

### Markdown 渐进渲染 + 上下文状态栏 + 长对话折叠（v0.5 新增）
**Markdown 渲染（`public/markdown.js`，零依赖，约 300 行）：**
- assistant 和用户气泡里的文本全部按 Markdown 渲染：标题 / 加粗 / 斜体 / 列表 / 引用 / 分隔线 / 表格 / 链接 / 图片
- **代码围栏**（``` ```js ... ``` ```）渲染为带语言标签和**复制按钮**的代码块，点击复制后按钮变「已复制」1.2 秒
- **语法高亮**：js / py / sh / json 四族，关键字 / 字符串 / 数字 / 注释 / 函数名 / JSON 键名分色
- **渐进渲染**：流式输出期间每 60ms 节流增量渲染，未闭合的代码围栏自动吞到文末（打字机效果下不闪烁）
- **安全性**：escape-first 顺序（先转义再解析）、URL 白名单（http/https/mailto，剥离引号尖括号）、图片/链接正则禁引号，XSS 向量单测 27/27 通过
- 复制按钮用 document 级事件委托，动态渲染的代码块也自动生效

**上下文状态栏（聊天区顶部）：**
- **当前模型**（provider/id，来自 `set_model` / `get_available_models`）
- **上下文占用**：最后一条 assistant 消息 usage 的总输入（input+cacheRead+cacheWrite）÷ 模型窗口（256,000），带百分比——这是当前 prompt 大小的近似值
- **累计 tokens**：in / out 两条线
- **缓存命中率**：cacheRead 占总输入比例
- **消息数**：当前会话条数
- 数据在每轮结束（finalize）、get_state、切模型、切会话时刷新；纯会话重置归零

**长对话折叠：**
- 消息数超过 **30** 条时，早期消息自动折叠为一条虚线胶囊「已折叠 N 条早期消息，点击展开」
- 点一下展开，再点折叠回去
- 阈值 `COLLAPSE_THRESHOLD = 30` 在 `app.js` 顶部可调

### 源头防空会话 + 空白消息清理（v0.7 重做，v0.6 消息层清理保留）

> v0.6 曾用「默认隐藏 + 降噪行提示」处理空会话（参考 DSH）。用户反馈：遮丑不如源头治理——
> 文件还在磁盘上，重启又冒出来。v0.7 从四个层面在源头解决，**降噪行 UI 已拆除**。

**空会话的源头（实证）：** 空文件只有一个来源——`new_session` RPC 被调用时 pi 落盘的
header-only 文件（点了「新建会话」但不发消息就留下）。pi 进程 spawn 时不建文件，
session 文件是**懒落盘**的（get_state 返回的路径要等首条消息才创建）。

**四层源头修复：**
1. **API 过滤（listSessionFiles）**：零消息的会话不再进入 `/api/sessions/list` 响应——列表的源头不吐空会话。同时 `usage.jsonl`（用量审计日志）按名排除，不再被误当会话
2. **启动清扫（sweepEmptySessions）**：server 启动时删除历史遗留的「有 session 头、零 message」文件，重启即清零。安全护栏双保险：只清确有 session 头的 + 跳过内部文件名单；执行时机在 pi 惰性启动之前，无写冲突
3. **懒创建（startPendingNewSession）**：点「新建会话」只设前端 pending 态（header 显示「新会话 / 发送第一条消息后创建」），不发 RPC；**第一条消息发出时才真正 new_session**，响应回来后自动发出暂存的消息（用户气泡一并重建）——点了不发 → 零文件
4. **拆除降噪 UI**：降噪行/查看/收起/清理按钮全部移除（`session-hidden-empty` 样式同步删除）；前端另留一道静默双保险（`applySessionList` 过滤 `hasMessages === false`，无 UI），兼容旧 server 未重启的混合态

**顺手修复的两个关联 bug（懒创建联调实测发现）：**
- `new_session` 响应清空消息区会把发送时已渲染的用户气泡删掉 → flush 时用暂存的附件信息重建气泡
- `new_session` 时的列表刷新早于文件创建（懒落盘）→ `agent_settled` 后仅当当前会话不在列表时才补刷（零常态开销）

**轮数显示修正（v0.6 遗留）：** 轮数此前只统计前 80 行——大会话的前 80 行全是 system 提示时，700 条消息的会话会显示"1 轮"。v0.7 起 <8MB 的会话全文精确重统计（先清零避免重复累计；name 取最后一次改名，更当前）；≥8MB 巨型会话保持 80 行下界，显示 "N+ 轮"（countsPartial 标记）。

**空白消息清理（v0.6 成果，保留）：**
- 完全空的 assistant 消息（中断/模型空返回）**不再渲染 "(空响应)" 空泡**；有 token 消耗但无文本的只显示一个低调的「（无文本输出）」占位
- usage 全 0 时不显示 "0 in / 0 out tokens" meta 行
- 聊天头部消息计数以**实际渲染数**为准（空消息不占计数）
- 流式结束但整条无内容时直接移除空泡（流式中已渲染的工具卡片不丢）

**实现分层：** server.js `scanSessionFiles()` 全量扫描（含空会话、含 hasHeader 标记），`listSessionFiles()` 过滤有消息的、`sweepEmptySessions()` 启动清扫，两者共用一次扫描；前端 `pendingNewSession`/`pendingFirstPrompt` 懒创建态机。**前端修复刷新即生效；API 过滤与启动清扫需重启 server 后完全生效**（未重启时前端静默双保险仍兜底）。

## 存储位置

默认 `D:\PI\pi-webui\sessions\`：

```
sessions/
└── <encoded-cwd>/
    └── 2026-10-15T14-22-01-123Z_<uuid>.jsonl
```

JSONL 文件就是 Pi 原生的会话格式，可以直接拷到 Pi CLI 里用 `--session` 加载。

如果想换位置（比如放 `%APPDATA%\pi-webui\sessions\`）：

```bat
node server.js --session-dir "%APPDATA%\pi-webui\sessions"
```

**v0.3 上传文件** 默认落到 `<WORK_DIR>/.pi-uploads/`（跟随 `--cwd`）。建议加入项目的 `.gitignore`：

```gitignore
.pi-uploads/
```

## 每轮 git 锚点（v0.8）

server 在每轮 assistant 回复结束后（`turn_end` 信号），若 `--cwd` 是 git 仓库，会自动把当时的工作目录快照挂到：

```
refs/piweb/rounds/<会话标识>/<轮号>
```

- **绝对只读**：只用 `git stash create`（生成临时 commit 对象，不进 stash list）+ `git commit-tree` + `git update-ref`；不改工作区、不动 index、不碰 HEAD、绝不 add/commit/checkout
- 无变更的轮直接挂 HEAD 等价快照；非 git 目录静默跳过；git 不存在或超时（5s）也静默跳过
- WebUI 侧栏有「⚓ anchors: N」徽标，点击展开最近 5 条（hash + message）

**回看某轮结束时的完整文件状态：**

```bat
:: 列出所有锚点
git for-each-ref refs/piweb/rounds/

:: 查看第 3 轮结束时的快照内容
git show refs/piweb/rounds/<会话标识>/3 --stat
git ls-tree -r refs/piweb/rounds/<会话标识>/3

:: 把某轮快照的某文件导出来（不动工作区）
git cat-file blob <快照hash>:src/app.js > recovery.js
```

快照 ref 不影响任何 git 操作；不需要时 `git update-ref -d refs/piweb/rounds/<会话>/<n>` 删除即可。

## 文件树与预览（v0.8）

侧栏「📁 文件」区块：懒加载浏览 `--cwd` 工作目录（排除 `.git`/`node_modules`/`.pi-uploads`），文件旁的彩色圆点是 git 状态（`M`=已改，绿色=未跟踪）。

点击文件：`.md` 直接渲染 / 图片复用灯箱（单击放大）/ 文本与代码语法高亮 + 一键复制全文。超过 1MB 的文本与二进制文件只给占位提示（安全约束：所有端点只读，路径穿越/绝对路径/drive-relative 一律 400）。

## 常见问题

**页面顶部出现红色横幅"与后端服务断开连接"**
说明 server.js 没在运行，或者你打开的是静态文件预览而不是 http://localhost:3210。

**侧边栏显示"暂无历史会话"**
- 检查 `--ephemeral` 是否被误开（开了就不保存）
- 检查 `--session-dir` 路径是否写对了
- 看一眼 `./sessions/` 目录有没有文件

**删了一条当前会话后整个崩了**
不会 —— 自动检测：删的就是当前的会提示要不要新建。

## 架构

```
浏览器 (public/)  ↔  WebSocket  ↔  server.js  ↔  pi --mode rpc 子进程
                              │
                              ├→ /api/sessions/list    (文件系统扫 *.jsonl，v0.7 起只返回有消息的会话)
                              ├→ /api/sessions/delete  (fs.unlink)
                              ├→ /api/config           (返回上传上限等信息)
                              └→ /api/upload           (multipart → .pi-uploads/)
```

server 启动时（pi 惰性启动之前）执行 `sweepEmptySessions()`：删除「有 session 头、
零 message」的遗留空会话文件（usage.jsonl 等内部文件按名排除，双护栏）。

Pi 的 RPC 协议文档在：
`C:\Users\lewie\.workbuddy\binaries\node\versions\22.22.2-6\node_modules\@earendil-works\pi-coding-agent\docs\rpc.md`

## 文件改动历史

- `server.js` — RPC 桥接 + 历史会话 HTTP API + 上传端点 + `--max-upload` + 会话扫描（v0.6 空会话检测 → v0.7 scanSessionFiles 重构 + API 过滤 + 启动清扫 sweepEmptySessions + usage.jsonl 排除）
- `public/app.js` — 侧边栏渲染 / 切换 / 删除 / 搜索 / 重命名 / 压缩 / 导出 + 附件状态机 + Skill 弹窗 + 拖拽 / Ctrl+V + `/` 补全 + 灯箱 + Markdown 渲染接线 + 状态栏 + 长对话折叠 + 空白消息过滤 + 轮数显示 + v0.7 懒创建 new_session（pendingNewSession/pendingFirstPrompt/flush 重建气泡）+ 双保险过滤（v0.6 降噪 UI 已拆除）
- `public/markdown.js` — **v0.5 新增**，零依赖 Markdown 渲染器 + 语法高亮器（Node 可加载，27/27 XSS 单测）
- `public/style.css` — 历史列表样式 + chip / toolbar / Skill 弹窗 / drag-over 高亮 + 命令补全面板 + 灯箱 + Markdown 排版 + 代码块 + token 着色 + 状态栏 + 折叠条 + 空白占位（v0.6 降噪行样式已删）
- `public/index.html` — 侧边栏 DOM + 顶栏操作按钮 + 新版 composer (chips + toolbar + popover) + 补全面板 + 灯箱容器 + markdown.js 引用 + 状态栏容器 + inline favicon + 版本号

回滚到 v0.2：`cp server.js.bak server.js && cp public/*.bak public/`
注：v0.3 是今天上午的输入增强版本，v0.4 是下午的补全 + 灯箱版本，两个增量分别 313 / 240 行 app.js。当前 .bak 是 v0.2，跳过中间版本；如需回滚到 v0.3/v0.4，需另存中间快照。
v0.5 为纯前端改动（markdown.js 新增 + app.js/index.html/style.css 修改），server.js 零改动，浏览器强刷（Ctrl+F5）即生效。
v0.6 改 server.js（listSessionFiles 加空会话检测）+ 前端；前端刷新即生效大部分，空会话精确检测需重启 server。探针：md_probe.js（v0.5）+ session_probe.js（v0.6，16 项断言）。
v0.7 在 v0.6 基础上从源头重做（API 过滤 + 启动清扫 + 懒创建，拆除降噪 UI）；前端刷新即生效大部分，API 过滤/启动清扫需重启 server。探针 session_probe.js 升级为 22 项断言（含懒创建端到端：点新建不落盘、首条消息 flush、新会话进列表——端到端用例跑一次真实模型调用，约 1-2 分钟）。临时实例测法：`node server.js --session-dir <临时目录> --port 3211` 起第二实例（拷一个大会话文件进去供历史渲染），`PROBE_BASE=http://localhost:3211 node session_probe.js`，避免重启正在用的 3210。
