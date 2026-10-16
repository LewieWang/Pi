# Pi

Pi WebUI + harness 自进化扩展的 monorepo。换一台电脑 clone 下来即可部署。

- `pi-webui/` —— Pi 编码代理的 Web 前端（会话进程池、多会话并行、轨迹审计、git 锚点、文件树预览、Markdown 渲染），完整提交历史保留。
- `workspace/extensions/` —— harness 扩展（Action Fusion / Observation Pack / Evidence Reducer / Online Compact / Harness Journal 等自进化能力），完整提交历史保留。
- `workspace/NOTES/` —— 技术笔记。

## 新电脑部署（从 GitHub 到跑起来）

前置条件：

- Node.js ≥ 22（LTS）
- pi CLI：`npm install -g @earendil-works/pi-coding-agent@1.2.0`
- Windows 下建议 Git Bash（本文命令通用）

步骤：

1. `git clone https://github.com/LewieWang/Pi.git && cd Pi`
2. `cd pi-webui && npm install && cd ..`                    # WebUI 依赖（ws）
3. `cd workspace/extensions && npm install && npm run build && cd ../..`
   # ↑ `npm run build` 必须执行：evolution 探针和测试都读 dist/，跳过会全红
4. `cd workspace/extensions && pi install . && cd ../..`    # 加载 harness 能力
   （或在 pi settings 的 packages 里加本目录绝对路径）
5. `pi list`                                                # 验证 User packages 出现本仓库路径
6. 配置 `~/.pi/agent/sol-pi.json`（actionFusion / harnessJournal.enabled 按需，格式见 workspace/extensions/README.md）
7. `cd pi-webui && start.bat`                               # Windows：双击或命令行；其他平台：`node server.js --port 3210`
8. 打开 http://localhost:3210
9. （可选）`cd workspace/extensions && npm test`            # 回归全绿再正式使用

不随仓库走的（每台机器独立，见下方内容地图）。

## 目录结构

```
Pi/
├── pi-webui/                 # WebUI 本体
│   ├── server.js             # 桥接层：静态托管 + WebSocket ↔ pi --mode rpc + 会话进程池
│   ├── public/               # 前端（app.js / trace.js / files.js / markdown.js / style.css）
│   ├── probes/               # Playwright 回归探针（每项功能一个 *_probe.js）
│   ├── start.bat / stop.bat  # 启动/停止脚本（路径自适配 %~dp0）
│   └── README.md / ROADMAP.md
├── workspace/
│   ├── extensions/           # harness 扩展（pi User package）
│   │   ├── bundle/           # 扩展统一入口
│   │   ├── action-fusion/ observation-pack/ evidence-reducer/
│   │   ├── online-compact/ footer-override/ harness-journal/ image-paste-fix/
│   │   ├── evolution/        # S2 探针引擎 + append-only evolution-log.md
│   │   ├── shared/ tests/    # 共享层 + node:test 回归
│   │   └── README.md
│   └── NOTES/                # 技术笔记
├── README.md                 # 本文件
└── .gitignore
```

## 内容地图

必须提交（已全部收录）：

| 内容 | 为什么 |
|---|---|
| pi-webui/ 全部 | WebUI 本体（server + public + probes + 启动脚本） |
| workspace/extensions/ 全部源码 + tests + evolution/ | harness 能力本体 + 回归门禁 + 自进化记忆（evolution-log.md append-only，丢了新机器从零开始） |
| workspace/NOTES/ | 技术笔记 |
| 各 package.json / package-lock.json / tsconfig.json | 可复现构建 |

不提交（用户数据 / 可重建 / 公开上游）：

| 内容 | 位置 | 理由 |
|---|---|---|
| node_modules/ dist/ | 仓库内 | install/build 重建（部署第 2-3 步） |
| pi-webui/sessions/ | 仓库内 | WebUI 会话历史，使用数据不是能力 |
| ~/.pi/agent/harness-history/、decisions.jsonl | 用户主目录 | harness 运行数据，每机器独立累积；要迁移手动打包 |
| workspace/pi/、workspace/SoL-Pi/ | 本地保留 | 公开上游克隆（earendil-works/pi、NVlabs/SoL-Pi），备份无意义 |

## 开发注意事项

- 以后所有改动在 Pi 仓库根统一 git commit/push；pi-webui/ 和 workspace/extensions/ 不再有独立 .git
- 改 extensions 代码后：`npm run build` + `npm test` 再提交（探针读 dist/）
- 回归探针在 `pi-webui/probes/`，运行方式见各文件头注释（自起 3211 隔离实例，不碰正式 3210）
