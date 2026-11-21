# dsh-pi-tui

[English](README.en.md) | 简体中文

[![npm](https://img.shields.io/npm/v/@xmoon76/dsh-pi-tui.svg)](https://www.npmjs.com/package/@xmoon76/dsh-pi-tui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**面向 DeepSeek Harness 的终端交互界面；一个 Host，让终端、Web 和 ACP 客户端访问同一个 Agent Session。**

默认以 **Direct** 模式运行，开箱即用；从 **0.5.7** 起，可在 Linux/macOS 显式选择 **Daemon**：独立的本地 Host 持有 Session 和执行中的工作，终端 Client 可以断开、重新连接；其他 TUI、官方 Web 与本地 ACP 客户端也可以访问同一 Host 的会话。

Agent Loop、模型、工具、持久化、权限和并发写入权威都属于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；`dsh-pi-tui` 是第三方前端，而不是另一套 Agent Runtime。

![dsh-pi-tui](docs/dsh-pi-tui.png)

![Direct TUI and a daemon Host shared by TUI, Web and ACP clients](docs/dsh-pi-tui-shared-session.svg)

> **核心能力：多入口共享会话，不是共享终端画面。** 多个 TUI 客户端可以查看同一 Session，Web 和 ACP 使用该 Host 的官方 Session/Agent 能力；提交、审批、取消和 Session 写入仍受 Host 的权限与并发控制。ACP 同一 Session 同时最多一个 ACP View（不限制 TUI View），且 ACP v1 只提供受限协议子集。Daemon 属于**同机、本地用户**能力，不直接暴露公共 TCP 远程服务。

## 安装到 DSH Profile

### Stable / latest

普通用户使用当前已经发布的 stable 版本。先安装 DeepSeek Harness，再将 TUI 添加到 `pi-tui` Profile：

~~~sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@latest
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@latest
dsh --profile pi-tui
~~~

### 精确版本配对（0.5.7 候选 / 尚未发布）

目前 npm `@latest` 对应 **0.5.6 × DSH 0.2.2-rc.1**。正在准备的 **0.5.7** 要求 **Node.js ≥24.9.0**、**DSH ≥0.2.2-rc.3**，当前精确验证目标为 **DSH 0.2.2-rc.5**。下面的 0.5.7 命令用于正式发布后的安装；**发布前不要把它当作已经可下载的版本**：

~~~sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@0.2.2-rc.5
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.5.7
dsh --profile pi-tui
~~~

当前 checkout 可以运行 `pnpm compat:dsh:npm` 验证仓库锁定的 npm DSH 配对。

| TUI | DSH | 状态 |
|---|---|---|
| `0.5.7` | `>=0.2.2-rc.3`；以 `0.2.2-rc.5` 为精确验证目标 | 候选，未发布 |
| `0.5.6` | `0.2.2-rc.1` | 已发布 stable |

**升级注意**：跨 DSH Runtime 升级必须先完成正在运行的 Turn/Job、停止旧 Host 并备份 Profile、Session 与所需数据；不保证跨 DSH 数据 Schema 的原地回退。不要将 0.5.7 配到 DSH rc.2 或更早版本。完整配对和恢复方法见[兼容性指南](docs/guides/dsh-compatibility.md)。

### Next / npm 线（验证）

`@next` 与 DSH `@alpha` 是独立移动的验证渠道，不承诺始终互相兼容；安装前确认实际版本及 peer/engine 范围：

~~~sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@alpha
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@next
dsh --profile pi-tui
~~~

从本仓库验证候选的精确配对：

~~~sh
pnpm compat:dsh:npm
~~~

## 功能

### 两种运行方式，同一套 DSH 会话语义

| | Direct（默认） | Daemon（0.5.7 起，可选） |
|---|---|---|
| 启动 | `dsh --profile pi-tui` | `DSH_PI_TUI_BACKEND=daemon dsh --profile pi-tui` |
| 进程 | TUI 与 Host 同进程 | Host 独立运行，TUI 是可断开的 Client |
| 多入口 | 当前进程内的交互界面 | 多个 TUI + 官方 Web + 可选本地 ACP 访问同一 Host/Session |
| 退出 | 结束 Direct 程序 | 默认仅断开 Client，Host 不因此自动停止 |
| 系统服务 | 无需额外管理 | Linux systemd --user / macOS LaunchAgent **可选安装** |

Daemon 的选择也可以在 `/settings → General → Backend` 保存，**下一次冷启动**生效；`DSH_PI_TUI_BACKEND` 仅覆盖本次启动、不写回设置。安装系统服务不是 Daemon 的前提，切换后端也不会热迁移 Host。所有实例仍由同一 Profile 和 DSH 官方 Session/Agent 权威管理。

### Agent、任务与会话

- **Agent 与工具**：流式 Markdown、Thinking / Tool / Context 展开、审批与 Question、模型与 Reasoning Effort、Plan、Goal 和 Todo。
- **Session 与 Workspace**：`/sessions` 浏览工作区与会话；`/new`、`/resume`、`/fork`、`/rewind`、`--session` 和 `--continue`；可只读预览后再选择恢复。
- **Team / Subagent / Job**：`/model` 可控制 Root Agent Team；`/tasks` 显示 Work/Team、嵌套 Subagent 和 Job。Subagent 默认展开，已完成的 Job 历史可以按需展开。
- **输入与终端操作**：`@file` 补全、图片/普通文件附件、`Ctrl+V` 图片粘贴、`!` 和 `!!` Shell、外部编辑器和可编辑的 Footer。
- **阅读与搜索**：`/display` 切换 Full / Focus / Compact；Transcript View / Full 搜索、卡片折叠、`Ctrl+R` 历史输入召回。Current session 历史可跨工作目录读取同一 Session 的历史记录。
- **Settings / 插件**：Provider 登录和凭据、审批、MCP Server 管理、Web Search/Fetch、Plugin Manager、动态 Extension Settings，以及 Client-local `./tui` 扩展加载。
- **图像与交付**：受终端能力约束的图片、静态 SVG、图表、`/view-image`、`/deliverables`、`/export`；支持 Kitty、SIXEL 和受支持的 iTerm2 图像路径。
- **可选实验渲染器**：`DSH_PI_TUI_RENDERER=tsp` 使用 Tern TSP，提供部分原生 Transcript/Work Hub 体验；不是所有 PiTui Settings/Plugins 的替代品。

### 常用命令和快捷键

| 入口 | 用途 |
|---|---|
| `/sessions` · `/resume` · `/new` | 找回或开始会话 |
| `/model` · `/tasks` · `/plan` · `/goal` | 模型、任务和 Agent 工作模式 |
| `/settings` · `/plugins` · `/keybindings` | 配置与扩展 |
| `/display` · `/export` · `/deliverables` | 阅读与导出 |
| `Ctrl+F` · `Ctrl+Shift+F` | 已绘制文本 / 可用 Session 历史搜索 |
| `Ctrl+R` · `Ctrl+G` | 历史输入 / 外部编辑器 |
| `Ctrl+O` · `Alt+T` | Tool / Context 与 Thinking 折叠 |
| `Ctrl+C` · `Ctrl+D` | 工作中取消、或空闲时遵循实际键位/确认退出 |
| `!` · `!!` | Host Shell：结果入 Session / 不入 Session |

这里列出的是默认键位和常见入口；自定义后以 `/help`、`/keybindings` 显示的**实际生效键位**为准。`/transcript` 当前的官方 Markdown 导出路径属于 Direct；`/export` 是独立的 ZIP 归档，产物落在 Client 本地目录。`PI_IMAGE_PROTOCOL=none` 只禁止像素预览，不影响附件发送。

## Daemon 快速上手（Linux / macOS）

不安装系统服务也可以启动独立 Host。一次性体验：

~~~sh
DSH_PI_TUI_BACKEND=daemon dsh --profile pi-tui
~~~

离开 Daemon TUI 的普通 `/exit`（或 `/quit`）只断开 Client，**不等于停止 Host**。当前 Session 正在工作时会出现明确的退出选择；如果你选择继续运行并断开，Host 工作仍由 Host 管理。管理命令只影响指定 Profile：

~~~sh
dsh --profile pi-tui daemon status
dsh --profile pi-tui daemon logs --lines 200
dsh --profile pi-tui daemon start
dsh --profile pi-tui daemon stop
dsh --profile pi-tui daemon restart
dsh --profile pi-tui daemon install
dsh --profile pi-tui daemon uninstall
~~~

`daemon install` 仅选择性地创建/验证当前 Profile 的用户服务定义，**不会**自动启动、启用或迁移 Host。`daemon stop` / `restart` 可能中断所有连接 Client 的进行中 Turn/Job；manager 显示运行中不代表 Host 已 Ready，须以认证身份确认。

同一 **DSH Runtime + Profile** 下，先通过官方插件命令更新 TUI；旧 Host 可以继续提供服务。需要让 Host 采用新包的代码时，再显式 `daemon restart`（会中断在途工作）；无需为同 Profile 的旧安装构建例行先卸载服务定义。**更换 DSH Runtime** 则不是热升级，必须走停止、备份和冷启动流程。详见 [Daemon 用户指南](docs/guides/daemon.md)。

## Web、ACP 和其他客户端：共同访问 Host Session

**官方 Web** 与本地 ACP 不是另一台 Host，也不是另一份 Session 记录。它们与 Daemon TUI 同样使用当前 Profile 的 Host Authority。Web 默认关闭，可在已运行 Host 上显式开启：

~~~sh
dsh --profile pi-tui web enable
dsh --profile pi-tui web url
dsh --profile pi-tui web status
~~~

还可使用 `web disable` / `web open`。这些命令**不会启动 Host**，也不会自动创建 Session；`web url` 输出的地址含认证 Token，必须作为敏感凭据处理。官方 Web 页面选择/打开 Session，并与 TUI 访问同一 Host 数据。

**ACP v1** 是默认关闭的、同机同用户 Unix Socket 接口。Daemon TUI 的 `/acp` 可以查看和切换当前 Listener；`/settings → General → Start ACP automatically` 控制下次 Host 冷启动。Headless 客户端可用 `daemon status` 查询已验证的 `acp` 状态与端点。ACP 支持有限的 `initialize`、`session/new|resume|prompt|cancel|close` 和协商后的图片输入；不支持 `session/list`、`session/load` 或通过 ACP 管理 MCP Server。一个连接只持有一个 Session View，同一 Session 最多一个 ACP View，而多个 TUI 仍可访问它。可运行的 [ACP SDK 例子与连接流程](docs/guides/daemon.md#local-acp-v1-sdk-client-example) 位于 Daemon 指南。

在 [Herdr](https://github.com/krisajenkins/herdr) Pane 中运行时，TUI 可以上报 Agent 工作状态；对有持久 Session ID 的场景可提供经 Profile 约束的恢复命令，实际能力取决于 Herdr 客户端。

## 设置、扩展与开发

`/settings` 是统一的全屏设置入口；`/plugins`、`/footer`、`/keybindings` 是对应页面的快捷入口。Host 配置写入会经过官方回读确认；当前 Client 的插件 `./tui` 激活状态与 Host 包是否启用是不同事实。

扩展按 **Stable / Advanced / Unstable** 三层发布，详见 [扩展作者指南](docs/extensions/authoring.md)、[Stable API](docs/extensions/stable.md) 和 [兼容性分层](docs/extensions/tiers.md)。0.5.7 增加了 Client-local `./tui` 加载与按包持久设置，但**不代表 Forge 或 Plugin Marketplace 已交付**。

从源码开发：

~~~sh
pnpm install
pnpm build
pnpm typecheck
~~~

请先阅读 [AGENTS.md](AGENTS.md)、[开发指南](docs/guides/development.md) 与[文档索引](docs/README.md)；完整发布与验证步骤见 [Release checklist](docs/guides/releasing.md)。

## 更新日志与许可证

- [中文 CHANGELOG](CHANGELOG.md) / [English CHANGELOG](CHANGELOG.en.md)
- [MIT License](LICENSE)
