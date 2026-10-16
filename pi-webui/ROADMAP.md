# Pi WebUI 升级路线图 — 可执行任务文案（P1 → P3）

> 用法：每条「任务卡」都是一个完整、自包含的 prompt，直接整段复制发给 Pi 执行即可。
> 建议按「执行顺序」逐个发，完成一个验收一个再发下一个。
> 文档位置：`D:\PI\pi-webui\ROADMAP.md` · 当前版本 v0.5 · 生成于 2026-10-15

---

## 〇、Pi 执行前必读（每个任务已内置，这里给人看的总纲）

**项目**：`D:\PI\pi-webui` — Pi coding agent 的网页界面。
**架构**：薄桥接。`server.js` ↔ `pi --mode rpc` 子进程（JSONL 双向），前端 `public/` 下 `index.html` / `app.js` / `style.css` / `markdown.js`（v0.5 新增，零依赖 Markdown 渲染器），除 `ws` 外零 npm 依赖。
**RPC 协议权威文档**（做任何 RPC 相关改动前必须先读）：
`C:\Users\lewie\.workbuddy\binaries\node\versions\22.22.2-6\node_modules\@earendil-works\pi-coding-agent\docs\rpc.md`
**会话持久化**：`sessions/<encoded-cwd>/*.jsonl`（Pi 原生格式，可直接 `--session` 加载）。
**验证方式**：`probes/md_probe.js` 是现成的 Playwright 专项探针（NODE_PATH 指向 `C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules`，用 `22.22.2-6\node.exe` 跑，headless Chrome 在 `C:/Program Files/Google/Chrome/Application/chrome.exe`），新功能照它的模式加断言。

**三条铁律（每个任务都带）**：
1. 改 `public/` 下的前端文件：安全，浏览器强刷（Ctrl+F5）即生效。
2. 需要改 `server.js`：**改完只做 `node --check server.js` 静态检查，不要重启服务**——重启会杀掉你当前的任务进程。写完告诉用户，由用户在无任务时段手动重启。
3. 保持零依赖原则（除 `ws`），新功能优先纯前端实现。

**两条工作线（文件域不重叠，可并行推进）**：
- **WebUI 线（P1-P4）**：⑨ 审批对话框（最大缺口，不改架构）→ ⑧ steer 队列 → ⑥ 编辑重发 → ④ 轨迹审计 → ⑤ git 锚点 + ⑦ 文件树（两个 server 改动，合并到一次重启）→ ⑩⑪⑫ → ⑬ → P4 暂缓区（IDE 集成，待底层完善）
- **进化线（S1-S3，三篇论文落地）**：S1 evolution 写回日志**已完成**；S2 候选树+探针评分**可立即启动**（只依赖 git 和探针，与 WebUI 线零文件冲突，建议排在 WebUI ⑨ 之后或并行）；S3 诊断 skill+回归门禁**依赖 S2 积累 5+ 进化案例后启动**

---

## 进化线：Harness 自进化引擎（三篇论文落地 · S1 已完成，S2/S3 待启动）

> 思想来源：Meta-Harness（外循环：提议→评估→写回）+ ERA（PUCT 候选树：回退/重组，探针断言当 quality score）+ EvoTrainer（多维信号诊断、失败样本价值、Skill 沉淀复利）。
> S1（evolution 写回日志：每次进化记录改了什么/假设/探针输出/结论）已随 harness-extensions 仓库 git 化完成。
> 标签：`#Harness自进化` `#S2候选树` `#S3诊断skill`。成本纪律：论文每轮 ~10 MTok，你的探针评分必须便宜；模型分工照搬 ERA——MiniMax/ark 跑常规循环，贵模型只做架构设计这类一次性重活。

## S2：git 候选树 + 探针评分（ERA 落地，可立即启动）

```text
任务：为 harness-extensions 建「候选树 + 探针评分」自动进化引擎——每个进化想法走一个 git 分支，用探针断言当 quality score，跑分写回日志，优胜者合并、低分者回退。

项目：D:\PI\workspace\extensions（harness-extensions 仓库，GitHub private repo，LewieWang/harness-extensions，50 个源文件，已有 evolution 写回日志传统：git 提交+tag 记录每次进化）。

背景（ERA 论文思想）：把"改 harness"变成搜索问题——维护候选树而不是单线尝试；每个候选在分支上实现，用可量化的探针评分裁决；能 backtrack（低分分支丢弃不留垃圾），失败的轨迹照样写回日志供后续诊断。

第一步：读仓库结构（ls + git log --oneline -20 看既有进化记录方式），确认探针基础设施现状；确认工作区 git 状态干净再开始。

要求：
1. 分支规范：每个进化目标开分支 evolve/<目标短名>-<YYYYMMDD>，如 evolve/faster-skill-load-20261015。一次只进化一个目标（成本纪律）。
2. 探针评分体系（evolution 目录下建 probes/）：
   a. 每个探针是一个 Node 脚本，输出机器可读结果：{ name, pass, score, durationMs }，score 0-100。
   b. 现有 probes/md_probe.js（D:\PI\pi-webui\probes/md_probe.js，Playwright 模式）可作 WebUI 相关探针样板；extensions 自身的探针针对扩展行为写断言（扩展能否加载、命令是否注册、skill 是否可调用等，以仓库实际功能为准）。
   c. 评分必须便宜：单次全量探针 < 2 分钟；禁调贵模型；能用断言就不用 LLM 评判。
   d. 先建 2-3 个覆盖核心功能的探针，再跑第一个进化周期。
3. 进化循环（由你 Pi 自己驱动，不是常驻进程）：
   a. 提议：选一个进化目标（来自日志里的失败模式、TODO 或用户指定），在分支上实现。
   b. 评估：跑全量探针，记录基线分 vs 候选分。
   c. 裁决：候选分 > 基线分且无探针从 pass 掉 fail → 合并进 main（快进或 squash）；否则删分支，轨迹写回。
   d. 写回：无论成败，在仓库 evolution-log.md（或既有等价物）追加一条：目标/假设/改动摘要/探针前后分/结论。
4. 回归红线：任何进化不许让已有探针从 pass 变 fail；出现即自动回退该分支。
5. 模型分工：常规循环用 MiniMax/ark（默认模型）；涉及架构重构的一次性设计可用贵模型，但只在动手前用一次。

约束：
- 只在 D:\PI\workspace\extensions 仓库内操作，不碰其他目录；不动用户其他 git 仓库。
- 分支命名严格遵循规范；合并前必须全量探针通过。
- 不引新 npm 依赖；探针用仓库现有工具链。
- 每次进化结束在对话里汇报：目标/分支/探针分变化/合并或回退/日志条目。

验收：
1. probes/ 下有 2-3 个可运行探针，全量跑完 < 2 分钟，输出机器可读分数。
2. 完整跑 1 个进化周期演示：开分支 → 实现一个小改进 → 探针前后分对比 → 按裁决合并或回退 → 日志有一条完整记录。
3. 故意制造一次让某探针 fail 的改动→ 验证自动回退红线生效。
4. evolution 日志结构可检索（按目标/日期能找到条目）。
```

## S3：诊断 skill + 回归门禁（EvoTrainer 落地，S2 积累 5+ 案例后启动）

```text
任务：为 harness 自进化建「诊断 skill + 回归门禁」——把 S2 积累的失败案例提炼成可复用的诊断技能，每次进化必跑回归断言，失败样本入库不丢弃。

项目：D:\PI\workspace\extensions（harness-extensions 仓库）。前置：S2 候选树+探针评分引擎已运行并积累至少 5 个进化案例（含至少 2 个失败/回退案例）。

背景（EvoTrainer 论文思想）：失败样本是资产不是废料——低分分支里蕴含诊断线索；把"症状→假设→验证→修复"的排查路径沉淀为 skill，后续进化直接调用；多维信号判断进化健康度而不只看最终分。

第一步：读 S2 的 evolution 日志和 probes/ 目录，统计已有案例的失败模式（探针 fail 类型、回退原因）。

要求：
1. 诊断 skill（skills/harness-diagnosis/ 或仓库既有 skill 机制，先读仓库确认 skill 的组织方式）：
   a. 内容：从 S2 日志提炼的排查路径——按症状分类（加载失败/断言回归/性能下降/行为异常）给出假设树与验证步骤。
   b. 每条诊断路径必须来自真实失败案例，注明出处（日志条目日期），禁止凭空写通用建议。
   c. 新失败案例出现时更新 skill（追加路径或修正权重），保持 skill 与日志同步。
2. 回归门禁：
   a. 每次进化（分支实现完成后）必须跑全量探针 + 一条新增的针对性断言（针对本次改动的最小区间测试）。
   b. 门禁结果结构化写入日志：baseline / candidate / regression（哪些探针 fail 了）。
   c. 连续两次门禁 fail 同一目标 → 该目标标记为"需人工介入"，不再自动重试。
3. 失败案例库（evolution/failures/）：
   a. 每个回退分支记录：症状/探针输出/当时的假设/为什么假设不成立/最终诊断结论。
   b. 库按症状标签组织，供诊断 skill 引用。
4. 多维健康信号（每次进化记录，哪怕只是日志字段）：探针分变化/回归数/耗时变化/改动行数——四个维度都记录，便于发现"分涨了但耗时暴涨"这类隐性退化。

约束：
- 只动 D:\PI\workspace\extensions 仓库；诊断 skill 的触发方式遵循仓库既有 skill 机制。
- 失败案例库只追加不删改（保留原始证据）。
- 不引新依赖；门禁脚本必须能在仓库现有 Node 环境跑。

验收：
1. skills/harness-diagnosis/（或等价位置）存在，且每条路径可追溯到 S2 日志的具体案例。
2. 回归门禁脚本一键运行，输出结构化结果；模拟一次回归 → 门禁拦截 → 自动回退 → 失败案例库新增一条。
3. 连续两次 fail 同一目标 → 正确标记"需人工介入"并不再自动重试。
4. 从失败库任选一条 → 30 秒内能定位到对应日志条目和探针输出。
```

---

## P1-⑨ 审批对话框（最高优先级：当前 plan mode / 权限审批在 UI 无法响应）

```text
任务：给 Pi WebUI 补齐审批/确认对话框（extension_ui / dialog 渲染）。

项目：D:\PI\pi-webui。架构：server.js ↔ pi --mode rpc 子进程（JSONL），前端 public/（index.html/app.js/style.css，零依赖仅 ws）。

第一步：先读 RPC 协议文档，确认事件名和载荷结构：
C:\Users\lewie\.workbuddy\binaries\node\versions\22.22.2-6\node_modules\@earendil-works\pi-coding-agent\docs\rpc.md
重点搜 extension_ui / dialog / confirm / approve / permission 相关的入站事件和出站响应方法（以文档为准，不要猜）。

现状：app.js 目前没有处理任何 UI 交互事件，Pi 发出的 dialog/审批请求在网页里无感知，plan mode 和权限审批会被动卡住或走默认。

要求：
1. server.js：把 rpc 收到的 UI 交互事件（按文档确认的准确事件名）通过 WebSocket 透传给前端，并把前端的响应原样转发回 rpc 子进程。注意 JSONL 的 id 对应，别串消息。
2. 前端：新增模态对话框组件（复用已有 lightbox 的遮罩模式），展示请求内容（标题/描述/选项），提供确认/拒绝（或多选项）按钮；流式输出进行中也要能弹出。
3. 样式进 style.css，与现有深色主题一致。
4. 若协议里响应需要特定字段（如 requestId），严格按文档结构回传。

约束：
- 只改 server.js / public/app.js / public/index.html / public/style.css。server.js 改完跑 node --check server.js 验证语法，但不要重启服务（重启会杀当前任务进程），完成后告知用户手动重启。
- 保持零依赖。
- 不透传、不执行任何协议之外的逻辑。

验收：
1. 在 WebUI 里触发一个需要审批的操作（例如让 Pi 执行一个可能危险的命令或进入 plan mode），界面弹出审批框。
2. 点「允许」后操作继续执行；点「拒绝」后 Pi 收到拒绝并停止对应操作。
3. probes/md_probe.js 同款探针（Playwright，headless Chrome）加一轮断言：模拟一次 dialog 事件 → 弹框出现 → 点击 → 响应正确回传。无 JS 错误。
```

---

## P1-⑧ steer 队列（流式中插话，排队自动发出）

```text
任务：给 Pi WebUI 加 steer 队列——assistant 流式输出期间，用户发的消息进入排队，本轮结束后自动按序发出。

项目：D:\PI\pi-webui。架构：server.js ↔ pi --mode rpc 子进程，前端 public/ 零依赖（仅 ws）。

第一步：读 RPC 协议文档确认是否已有 steer / queue / follow-up 类能力：
C:\Users\lewie\.workbuddy\binaries\node\versions\22.22.2-6\node_modules\@earendil-works\pi-coding-agent\docs\rpc.md

现状：输入框发送即走 prompt；流式输出中发送会怎样按现状处理（先读 app.js 里 send 相关逻辑确认）。

要求：
1. 前端：流式进行中（有活跃 assistant 块 / tool 卡片在跑）时，输入框照常可打字，发送按钮行为变为「加入队列」；composer 上方显示排队消息 chips（可移除）。
2. 监听一轮结束的信号（app.js 里已有 agent_settled 或等价逻辑），结束后自动按 FIFO 发出队首消息，发完出队，直到队列清空。
3. 若协议原生支持 steer（文档确认有），优先走协议；否则纯前端排队 + 自动发送实现。
4. 空输入、非流式状态行为完全不变（回归不能坏）。

约束：
- 只改 public/ 下文件（若需 server 配合，同样只做 node --check 不重启，并告知用户）。
- 保持零依赖。
- 队列状态不进会话持久化（刷新即清空，可接受）。

验收：
1. 发一个长任务（会流式 10 秒以上），流式中输入第二条消息 → 显示排队 chip → 本轮结束后自动发出并开始第二轮。
2. 排 3 条 → 依次自动发完。
3. 非流式时发送行为与现在完全一致。
4. 探针（Playwright，参考现有 probes/md_probe.js）模拟：流式中连发 2 条 → 第二条出现排队 UI → 两轮都完成。
```

---

## P1-⑥ 分支 / 编辑重发（edit & re-ask）

```text
任务：给 Pi WebUI 加「编辑重发」——点击任意一条 user 消息可改内容，确认后从该条截断重来，后续旧回复被替换。

项目：D:\PI\pi-webui。架构：server.js ↔ pi --mode rpc 子进程，前端 public/ 零依赖（仅 ws），会话持久化在 sessions/<encoded-cwd>/*.jsonl（Pi 原生格式）。

第一步：读 RPC 协议文档，确认是否有截断会话 / 回退 / fork 类方法：
C:\Users\lewie\.workbuddy\binaries\node\versions\22.22.2-6\node_modules\@earendil-works\pi-coding-agent\docs\rpc.md

现状：消息渲染后只读（app.js 的 renderHistoryUser / renderHistoryAssistant）。

要求：
1. 每条 user 消息 hover 显示「✎ 编辑」按钮 → 点击变成可编辑状态（contenteditable 或回填输入框二选一，你评估哪种对现有代码改动小）。
2. 确认后：把该条之后的全部消息从界面移除，用新内容作为 prompt 重新发送。
3. 持久化：若协议有截断/重放方法优先用；若没有，前端截断显示 + 发送时带上历史截止标记，保证刷新后会话文件不出现新旧并存的错乱（最次也要让 JSONL 以追加一条新 user 消息的方式保持 Pi 可加载，不能写出损坏文件）。
4. 二次确认防误触（「重发将丢弃该条之后的 N 条消息」）。

约束：
- 只改 public/ 下文件；若必须动 server.js，改完 node --check 不重启，告知用户。
- 保持零依赖。
- 绝不允许写坏 sessions/ 下的 JSONL（写完用 node 解析一遍验证）。

验收：
1. 对一条历史 user 消息点编辑 → 改文字 → 确认 → 后续回复被替换为新生成结果。
2. 会话文件仍可被 pi --session 加载（用 node 跑 JSON.parse 验证每行）。
3. 探针加断言：编辑第 N 条 → 重发 → DOM 中该条之后旧回复消失、新回复出现。
```

---

## P1-④ 轨迹审计视图（Trajectory）

```text
任务：给 Pi WebUI 加「轨迹」审计面板——把当前会话按时间线平铺展示所有事件（user / assistant / tool / system），支持按类型过滤和关键词搜索。

项目：D:\PI\pi-webui。架构：server.js ↔ pi --mode rpc 子进程，前端 public/ 零依赖。会话文件：sessions/<encoded-cwd>/*.jsonl，Pi 原生 JSONL 格式，每行一个事件（先读一个真实文件确认字段结构，不要猜）。

现状：聊天区只渲染最终消息和工具卡片；没有全量事件视图。

要求：
1. 顶栏加「≡ 轨迹」按钮 → 打开全宽/侧滑面板。
2. 数据来源优先用前端已加载的会话数据（app.js 里切会话时加载的消息数组）；不够就新增只读 HTTP 端点 GET /api/sessions/trace?file=<name> 由 server.js 直接解析 JSONL 返回结构化事件。
3. 每行事件：时间戳、角色 badge（user/assistant/tool/system，分色）、摘要（截断）、点击展开完整载荷（JSON 高亮，可复用 markdown.js 的 highlight）。
4. 过滤 chips：全部 / user / assistant / tool / system；搜索框实时过滤（匹配展开后的全文）。
5. 大会话（500+ 事件）虚拟滚动或分页，不能卡死浏览器。

约束：
- server.js 只加只读端点（如需），改完 node --check 不重启，告知用户；其余纯前端。
- 保持零依赖。
- 只读！面板里任何操作都不许写会话文件。

验收：
1. 打开一个 200+ 事件的会话 → 轨迹面板 1 秒内渲染完。
2. 过滤「只看 tool」只剩工具事件；搜一个已知关键词只剩匹配行；展开行看到完整 JSON。
3. 探针加断言：面板打开、过滤生效、搜索生效、展开生效。
```

---

## P1-⑤ 每轮 git 锚点（rounds 模式，不碰用户分支）

```text
任务：给 Pi WebUI 加「每轮 git 锚点」——每轮 assistant 回复结束后，把工作目录当前快照记为一个 git 对象，挂到 refs/piweb/rounds/<session>/<round-n>，供事后回看任意一轮的完整状态。参考 PiWeb 的实现思路。

项目：D:\PI\pi-webui。server.js 里 spawn pi --mode rpc 子进程，工作目录由启动参数 --cwd 决定。前端 public/ 零依赖。

现状：无任何 git 集成。注意：--cwd 指向的用户工作目录不一定是 git 仓库。

要求：
1. server.js：监听每轮结束（assistant 回复完成的事件，先读 rpc.md 确认准确信号）。结束时对 --cwd 执行：
   a. git rev-parse --is-inside-work-tree 确认是 git 仓库；不是 → 静默跳过（记 debug 日志，不报错、不弹窗）。
   b. 是 → 用 git stash create（只创建 commit 对象、不改工作区、不动 index、不碰 HEAD）生成快照对象，再 git commit-tree <该对象> -m "piweb round N <session>" 挂 refs/piweb/rounds/<session>/<round-n>。绝对不要 git add / git commit / git checkout，绝不移动用户分支。
   c. 每轮一个 ref，序号递增；ref 名含 session 标识。
2. 全部用 child_process.execFile 同步或异步执行 git，加超时（5s），git 不存在或命令失败只静默跳过。
3. 前端：状态栏或侧栏加一个小徽标显示「anchors: N」（N=该会话已挂 ref 数，server 提供一个只读查询），点击可展开最近几条 ref（hash + message）。不加复杂 UI。
4. 在 README.md 补一节说明这个功能、如何用 git show refs/piweb/rounds/<session>/<n> 回看。

约束：
- 这是 server.js 改动：改完跑 node --check server.js，不要重启服务（重启会杀当前任务进程），完成後告知用户，并提醒用户：只有重启后新逻辑才生效，重启前确认当前无运行中任务。
- 保持零依赖（用 Node 内置 child_process，不引 simple-git 之类）。
- 绝不修改用户工作目录的任何文件与 git 状态（stash create 之后 git status 必须干净如初——写个自测：连跑两轮，前后 diff git status 输出）。

验收：
1. 以 git 仓库为 --cwd 启动，跑 3 轮对话 → git for-each-ref refs/piweb/rounds/ 出现 3 个 ref，编号连续。
2. git show 任一 ref 能看到那一轮结束时的完整文件快照。
3. 跑完后 git status 与跑之前逐字节一致。
4. 以非 git 目录为 --cwd 启动 → 功能静默跳过，无报错、UI 无异常。
5. 探针/脚本验证以上 4 条。
```

---

## P1-⑦ 文件树 + 预览

```text
任务：给 Pi WebUI 加文件树面板——浏览 --cwd 工作目录，点击文件预览内容（图片走已有灯箱，文本/代码新开预览），目录/文件显示 git 状态标记。

项目：D:\PI\pi-webui。架构：server.js ↔ pi --mode rpc 子进程，工作目录 --cwd，前端 public/ 零依赖（仅 ws）。已有图片灯箱组件可复用。

要求：
1. server.js 新增只读端点：
   - GET /api/files?path=<相对路径>：列目录（名字/类型/大小/ mtime），默认排除 .git、node_modules、.pi-uploads。
   - GET /api/file?path=<相对路径>：返回文本内容（限 1MB，超限返回提示）；二进制/图片返回合适的占位信息由前端走灯箱（图片用 /api/file/raw 或 base64，你定，注意 25MB 上传上限的既有约定）。
   - 安全：路径必须 join 后校验仍在 --cwd 内（防 ../ 穿越），拒绝绝对路径。
2. 前端：侧栏加「文件」区块（或右侧可收拢面板），树形缩进展示，目录可展开/收起；文件旁显示 git 状态圆点（M/A/??，通过 server 调用 git status --porcelain 一次拿全量映射，不是 git 仓库则不显示）。
3. 点击图片 → 已有灯箱；点击文本/代码 → 预览面板（代码用 markdown.js 的 highlight 着色，带复制按钮）；点击 .md → 直接用 PiMD.render 渲染。
4. 树只懒加载展开的目录，不一次性递归。

约束：
- server.js 只加只读端点 + 一个 git status 查询，改完 node --check 不重启，告知用户手动重启（重启会杀当前任务）。
- 保持零依赖。
- 所有端点只读，禁止任何写/删/重命名。
- 路径穿越必须有测试（构造 ../ 请求确认被拒）。

验收：
1. 文件树渲染 --cwd 顶层 → 展开子目录 → 点击 .md 渲染预览、点击 .png 灯箱打开、点击 .js 高亮显示。
2. git 仓库下修改一个文件 → 树里对应文件出现 M 标记。
3. GET /api/file?path=../../etc/passwd 被拒（400/403）。
4. 探针加断言覆盖以上 3 条。
```

---

## P2-⑩ 并行后台会话

> **状态：已完成（v0.9，2026-10-16）**。三次小步提交，每步可回退：
> `f29da0e` server 进程池 → `ac38b91` 前端多会话视图 → `9db6cc7` 会话文件轮换修复。
> 新增 `probes/parallel_probe.js`（26/26）；全量回归 edit 20/20、steer 15/15、ui 26/26、
> trace 25/25、gitfiles 36/36、md 7/7。还原点 `6dc9804`。
> 上线需用户在无任务时段重启 server（重启会杀当前任务进程）。

```text
任务：把 Pi WebUI 从单会话升级为并行后台会话——多个会话可同时运行，各自独立的 pi --mode rpc 子进程，互不干扰，可随时切换查看。

项目：D:\PI\pi-webui。当前架构：server.js 全局 spawn 一个 pi --mode rpc 子进程，全部 WebSocket 客户端共享这一个进程。前端 public/ 零依赖。会话文件在 sessions/<encoded-cwd>/*.jsonl。

这是架构级改动，风险最高，务必小步提交、每步可回退。

要求：
1. server.js：把「单个 rpc 子进程」重构为 Map<sessionId, RpcProcess> 子进程池；每个会话按需 spawn（首次打开/发送时），空闲可保留（设 idle timeout 如 30 分钟可配）。
2. WebSocket 协议加 sessionId 路由：客户端消息带目标 session，服务端按 session 分发到对应子进程；子进程输出只推给订阅了该 session 的客户端。
3. 生命周期：新会话/切会话/删会话/服务关闭时正确 spawn/kill，不能泄漏子进程（写个自测：开关 20 个会话后 ps 一下 pi 进程数）。
4. 前端：侧栏会话项显示「运行中」动效；切到后台会话能看到它的实时流式输出继续滚动；未读会话加角标。
5. 兼容：单会话时的全部现有行为不能回归（探针 probes/md_probe.js 全绿）。

约束：
- 这是 server.js 大改：先 git commit 当前状态留还原点（在 D:\PI\pi-webui 里 git init 一个本地仓库或确认已有），再动手。
- 改完 node --check + 单会话回归 + 探针全绿后才算完成；绝对不要带着回归上线。完成后告知用户，由用户选无任务时段重启验收（重启会杀当前所有任务进程，提前告知用户保存）。
- 保持零依赖。

验收：
1. 同时开 A/B 两个会话各发一个长任务 → 两边都正常流式 → 互不串消息。
2. 切到 A 时 B 的输出不丢（后台继续累积）。
3. 关掉 B → B 的 pi 子进程退出，A 不受影响。
4. probes/md_probe.js 既有断言全绿 + 新增并行断言。
```

---

## P2-⑪ 设置面板

```text
任务：给 Pi WebUI 加设置面板——模型/默认参数/OAuth 状态集中管理，改设置免重启生效。

项目：D:\PI\pi-webui。已有 model-select 可在会话中切模型（set_model）。RPC 协议文档：
C:\Users\lewie\.workbuddy\binaries\node\versions\22.22.2-6\node_modules\@earendil-works\pi-coding-agent\docs\rpc.md

要求：
1. 先读 rpc.md + get_available_models 的返回结构，确认哪些设置可通过 RPC 热更新（模型、温度、max tokens 等，以协议为准，没有的别硬造）。
2. 侧栏底部加「⚙ 设置」→ 弹出面板：当前模型（含 provider 分组，复用 get_available_models 数据）、协议支持的热参数、OAuth/登录状态显示（只读）。
3. 修改即通过 RPC 生效，无需重启；面板显示当前值与默认值。
4. 设置持久化到 server 端一个 config.json（放 D:\PI\pi-webui\ 下，不进 sessions/），下次启动读取为默认值。

约束：
- server.js 如需加配置端点：只做 node --check 不重启，告知用户。保持零依赖。config.json 加 .gitignore 防泄漏密钥。
- 只暴露协议真实支持的参数。

验收：
1. 面板改模型 → 立即生效（下一轮用新模型）。
2. 改温度等参数 → 生效且重启服务后仍保持。
3. OAuth 状态区显示正确（未登录/已登录+账号）。
```

---

## P2-⑫ 内置终端

```text
任务：给 Pi WebUI 加内置终端面板——在网页里直接对 --cwd 执行 shell 命令，看输出。

项目：D:\PI\pi-webui。架构：server.js ↔ pi --mode rpc 子进程，工作目录 --cwd，前端 public/ 零依赖（仅 ws）。

现状：工具调用卡片能看 Pi 执行的命令结果，但用户不能主动开终端。

要求：
1. 先评估两条路，选改动小且不破坏零依赖的：
   a. node-pty 真 PTY + xterm.js（要引 2 个依赖，评估是否值得）；
   b. 轻量版：输入框 + 输出区，server 用 child_process.spawn 跑命令流式回传 stdout/stderr（零依赖，推荐先做这个）。
2. 轻量版规格：底部或右侧可开合面板；输入命令回车执行；输出流式追加、区分 stderr 颜色；支持 Ctrl+C 中断当前命令；命令历史（↑↓）；工作目录固定为 --cwd，不许 cd 逃逸（cd 命令直接拒绝并提示）。
3. 长输出限制（如 5000 行）防内存爆炸。
4. 安全：仅监听 127.0.0.1（确认 server 现有绑定行为，别改成 0.0.0.0）；命令以 pi 子进程同权限运行——在 README 明示风险。

约束：
- server.js 改动只做 node --check 不重启，告知用户。保持零依赖（选 b 路线则零新依赖）。
- 禁止持久化命令历史到磁盘。

验收：
1. 面板里跑 ls / git status / 一个 10 秒的 sleep → 输出流式出现、Ctrl+C 能中断。
2. 输入 cd .. → 被拒绝。
3. 探针加断言。
```

---

## P3-⑬ 语音 / 通知 / i18n（打包做）

```text
任务：给 Pi WebUI 做体验增强三件套（按优先级，可分别交付）：① 任务完成桌面通知 ② TTS 朗读 assistant 回复 ③ 界面 i18n（中英切换）。

项目：D:\PI\pi-webui。前端 public/ 零依赖（仅 ws），当前界面全中文硬编码在 index.html / app.js。

要求：
1. 通知：每轮 agent_settled 且页面不在前台（document.hidden）时弹 Notification API 桌面通知（含会话名+摘要）；设置里可关。
2. TTS：「朗读」按钮（assistant 消息 hover 显示）→ SpeechSynthesis API 朗读纯文本（先剥 Markdown 标记，用 markdown.js 的渲染结果提取 textContent）；播放中再点停止。
3. i18n：抽取界面文案到 public/i18n.js（zh/en 两语言包），index.html/app.js 里硬编码中文改为 t('key')；语言选择存 localStorage；默认跟随 navigator.language。不改会话内容本身的语言。
4. 三个功能都要能在设置面板（若 P2-⑪ 已做）或顶栏直接开关；没做设置面板就放顶栏下拉。

约束：
- 只改 public/ 下文件，浏览器强刷即生效，不碰 server.js。
- 保持零依赖（全用浏览器原生 API：Notification / SpeechSynthesis / Intl）。
- i18n 抽取不许改坏任何现有功能——抽完跑 probes/md_probe.js 回归。

验收：
1. 切到别的标签页等一轮完成 → 桌面通知弹出。
2. 点朗读 → 出声；再点 → 停。
3. 切 English → 界面全部变英文；刷新后保持；切回中文恢复。
4. probes/md_probe.js 既有断言全绿。
```

---

# P4 · 暂缓区：IDE 集成与迁移体系

> **状态：[暂缓]** —— 用户 2026-10-15 决定：等 Pi 底层能力（P1-P3）完善后再启动本节。
> 标签：`#IDE集成` `#ACP` `#迁移` `#WebUI转型`。方案与任务卡已备好，启动时直接取用。
> 完整方案图与论证见当日会话记录；以下为浓缩版。

## 方案摘要（三层解耦）

Pi 的底座（`--mode rpc` JSONL）本就是多客户端设计，WebUI 只是客户端之一。IDE 化 = 增加 IDE 客户端 + WebUI 换角色：

- **主方案：pi-acp 适配器**。ACP（Agent Client Protocol，JetBrains+Zed 联合开源，"AI agent 界的 LSP"，v1 stable）= JSON-RPC 2.0 over stdio，agent 作为 IDE 子进程，与 pi rpc 模式同构。核心方法仅 7 个：initialize（版本+能力协商）/ session/new（绝对路径 cwd + MCP servers）/ session/prompt / session/update（流式消息块·工具调用·计划）/ session/request_permission（审批）/ session/cancel / stopReason。官方有 TypeScript SDK，与 Pi Node 栈匹配。**一次实现覆盖 JetBrains 全系 + Android Studio + Zed + Neovim/Emacs**
- **接入零开发**：JetBrains 系 AI Chat → "Install From ACP Registry"；自定义 agent 写 `~/.jetbrains/acp.json` 指向 pi-acp 启动命令。用用户自己的 key，无需 JetBrains AI 订阅（国内有地区限制，此路绕开）
- **DevEco 专项**：DevEco 是 IntelliJ 内核，ACP 支持待实测（AI Chat 有无 ACP Registry 入口 / 手动 acp.json）；native 路径是 `@deveco/deveco-cli`（官方明确"适配业界 AI Agent"，提供工程创建/编译构建/运行验证原子能力+知识库+Skills）写 skill，或把 Pi 包成 MCP server 接 CodeGenie 自定义 Agent（支持 MCP Tools）
- **MCP Steroid（配套）**：JetBrains 插件，把 IDE 语义能力（PSI/重构/inspections/调试器/测试运行）经 MCP 暴露给任何 MCP agent；devrig 一键注册 Claude Code/Codex/Gemini。与 ACP 互补：ACP 管 UI，Steroid 管 IDE 能力。Android Studio 在支持列表
- **WebUI 不废弃，角色转变**：远程/手机监控任务、后台长任务独立窗口、多会话总览、演示分享。P2 里"并行后台会话"降优先级，"手机配对远程"升优先级
- **T0 零成本**：Android Studio / DevEco 内置终端直接跑 `pi`，鸿蒙动作经 deveco-cli 暴露

## 任务卡 A：pi-acp 适配器（P4 主任务）

```text
任务：为 Pi 写一个 ACP（Agent Client Protocol）适配器，让 Pi 能作为 ACP agent 跑进 JetBrains 全系 IDE（含 Android Studio）、Zed、Neovim、Emacs。

项目：D:\PI\pi-webui（Pi WebUI，server.js ↔ pi --mode rpc 子进程桥接，前端 public/ 零依赖仅 ws）。ACP 协议权威文档：https://agentclientprotocol.com/protocol/（v1 stable，v2 draft）。官方 TypeScript SDK 有现成 example client 可参考。

背景：ACP = "AI agent 界的 LSP"，JetBrains 与 Zed 联合开源。传输为 JSON-RPC 2.0 over stdio，agent 是 IDE 的子进程。WebUI 的 server.js 已有成熟的 pi rpc 桥接逻辑（流式事件分发、会话管理、dialog 事件处理），本任务是把那套桥接"换个外壳"接到 ACP 协议上。

第一步：读 ACP 协议文档的 Initialization / Session Setup / Prompt Lifecycle / Transports 四节；读 D:\PI\pi-webui\server.js 的 rpc 桥接部分，列一张映射表再动手。

要求：
1. 新组件放 D:\PI\pi-acp\（独立目录，独立 package.json，依赖 acp typescript-sdk + ws 之外尽量零新增）。
2. 实现 ACP agent 侧最小方法集：
   - initialize：返回协议版本、能力（session/prompt 支持 image+embeddedContext、mcp stdio+http）、agent 信息（name=pi, version）。
   - session/new：接收绝对路径 cwd 与 MCP servers 列表；spawn pi --mode rpc 子进程（cwd 用客户端传来的）；把 MCP servers 配置透传给 pi（按 pi 的 MCP 配置方式，先读 pi 文档确认）。
   - session/prompt：把 prompt 内容块（text/resource-link）转成 pi rpc 的 prompt 消息。
   - session/cancel：转发中断。
   - session/list / session/resume：映射 pi 的会话列表与恢复（如 pi rpc 支持则做，不支持就明确返回不支持，别假装）。
3. 流式回传：pi rpc 的 text chunk → session/update 的 agent_message_chunk；tool call → tool_call / tool_call_update（带状态与输出）；plan（如 pi 有）→ plan update。session/prompt 最终返回 stopReason（end_turn / cancelled / max_tokens 等，按协议枚举）。
4. 审批：pi rpc 的 extension_ui/dialog 事件 → session/request_permission（选项映射成协议的 permission options），客户端点选后回传 pi。复用 server.js 里已有的 dialog 处理逻辑。
5. 全部文件路径用绝对路径（协议要求）；stdout 只输出合法 ACP 消息，日志一律走 stderr。

约束：
- 零依赖原则：除 ACP TS SDK 外不引新包；SDK 装不上就按协议手写 ndjson 流（协议不复杂）。
- pi 子进程生命周期严格管理：session/close / IDE 断开时必须杀干净，不许泄漏（写自测：连开 20 个 session 后检查进程数）。
- 不改 server.js / pi-webui 现有代码，只读复用。

验收：
1. JetBrains 系 IDE（Android Studio 或 IntelliJ）：AI Chat → 配置 ~/.jetbrains/acp.json 指向本适配器 → 新线程 → 发消息 → 流式回复 + 工具调用卡片正常渲染。
2. 触发一次审批操作 → IDE 弹出权限框 → 允许/拒绝都正确回传 pi。
3. 中断按钮 → pi 停止且 stopReason=cancelled。
4. 关线程 → pi 子进程退出，无泄漏。
5. 写一个 ACP Test Compatibility Kit 风格的脚本客户端（照协议手写，50 行以内）跑通 initialize→session/new→prompt→update 流→stopReason 全链路。
6. 附 README：各 IDE（JetBrains/acp.json、Zed、Neovim 插件）接入步骤。
```

## 任务卡 B：MIGRATE.md 迁移清单（P4 轻量任务，可提前做）

```text
任务：为 Pi 全家桶写换电脑迁移清单和半自动迁移脚本。

项目：Pi 生态资产分布在 D:\PI\（pi-webui、workspace\extensions 等）、全局 npm 包、用户配置目录。

要求：
1. 在 D:\PI\MIGRATE.md 写清单，分四类：
   a. git 化资产（clone 即用）：harness-extensions（已是 GitHub private repo）、pi-webui（如未 git init 先 init 并推 GitHub）、未来的 pi-acp。
   b. npm 全局包：@earendil-works/pi-coding-agent（锁版本号写进清单）、ws 等 pi-webui 依赖（package.json 已在）、deveco-cli（如装了鸿蒙开发）。
   c. 拷贝资产：sessions/ 目录（pi-webui 的会话 JSONL）、workspace 下的用户数据。
   d. 重配资产（绝不迁移）：所有 API keys / OAuth token，列一张"需要重新登录/填 key 的服务清单"占位。
2. pi 的用户配置目录（MCP 配置、模型配置等，先找到实际位置再写，不确定就写"以 pi docs 为准"并留待确认标记）。
3. 写 D:\PI\migrate.ps1（PowerShell）：检查清单逐项打勾——git 仓库是否干净、npm 包是否安装、目录是否存在、keys 是否已配；输出"迁移就绪度"报告（缺什么列什么）。只检查不安装，安装步骤指向 MIGRATE.md。
4. MIGRATE.md 顶部写"新电脑 30 分钟复原"快速路径。

约束：
- 脚本只读检查，禁止任何自动安装/拷贝/删除。
- 清单里不出现任何真实 key 值。

验收：
1. 在当前电脑跑 migrate.ps1 → 输出各项状态。
2. 按 MIGRATE.md 快速路径在人造干净环境（或虚拟机/容器）实测一遍，计时 ≤30 分钟，把实测时间写进文档。
```

## 启动条件检查（满足后再启用 P4）

- [ ] P1 六项全部完成并验收（尤其 ⑨ 审批对话框——ACP 的 request_permission 直接复用它的事件结构）
- [ ] server.js 的 rpc 桥接层稳定（pi-acp 要从它抄逻辑，源不稳则适配器不稳）
- [ ] DevEco ACP 入口实测有结果（AI Chat 有无 ACP Registry / acp.json 是否生效）
- [ ] pi-webui 已 git 化（迁移前置）
- [ ] 鸿蒙开发实际提上日程（决定 deveco-cli skill 的优先级）

---

## 附：每条任务的通用收尾模板（Pi 完成后应回复的格式）

```text
【完成报告】
- 改动文件：<列表 + 各自行数变化>
- 静态检查：node --check server.js（如动过）/ 浏览器无 JS 错误
- 验证结果：<逐条对验收标准打勾>
- 待用户动作：<如：需在无任务时段重启 server.js 后生效>
- 遗留/风险：<如有>
```

## v0.9.1（2026-10-16）

- **侧栏样式整理**：`.s-meta` 强制单行 ellipsis；`.session-item` 补 `min-width: 0` 让 ellipsis 真正生效；item padding 收紧。标题不再裸用 firstMessage 截断——`smartSnippet()` 去 URL/markdown 符号/emoji 后再截 40 字，无内容时回退本地短时间戳。
- **未读角标语义**：当前活跃会话不再显示未读角标（正在看 = 无未读）。
- **刷新丢历史修复（真回归）**：v0.9 多视图后，刷新页面的 `get_state` 响应携带真实会话 key（≠前端的 "default"）→ 走后台分发，历史渲染进后台视图且 finally 回切空视图。修复：初始装载 adopt——首个 get_state 响应分发完成后停在真实会话视图（`pendingAdoptKey`），孤儿 default 视图清理并留 alias；历史加载条件放宽（`sessionFile || messageCount>0`，兼容 ephemeral）。
- **md_probe 安全重写**：旧版直连 3210 且 guard 只查 `msgs>40`，压缩过的 live 会话形同虚设——累计 4 次把测试 prompt 注入用户会话（其中一次落成独立 jsonl，制造"凭空多出的会话"）。新版自起 3211 `--ephemeral` 隔离实例，PHASE A 自造历史再刷新验证，19/19。
- **探针路径修复**：探针移入 `probes/` 后 `path.join(__dirname, "server.js")` 全部失效，改为 `../server.js`。
- 新增 `reload_probe.js`（4/4）：非 ephemeral 刷新恢复历史 + 二次刷新幂等。
- 回归：parallel 26/26 · edit 20/20 · steer 15/15 · ui 26/26 · trace 25/25 · gitfiles 36/36 · md 19/19 · reload 4/4。
- 教训：探针必须完全隔离自起实例；串行后台跑探针前必须确认 3211 无残留（`netstat -ano | grep :3211`）。
