# dsh-pi-tui

[English](README.en.md) | 简体中文

[![npm](https://img.shields.io/npm/v/@xmoon76/dsh-pi-tui.svg)](https://www.npmjs.com/package/@xmoon76/dsh-pi-tui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

基于 Pi TUI 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 终端前端。

`dsh-pi-tui` 作为独立的 dsh bundle 安装到 profile 中，提供流式对话、工具调用、会话管理、Subagent、历史搜索、Shell、审批与设置等终端交互。模型、工具、Session、权限、Skills、Plan、Goal、Subagent 等运行时能力仍由 DeepSeek Harness 提供。

![dsh-pi-tui](docs/dsh-pi-tui.png)

## 安装到 DSH Profile

### Stable / latest

稳定版是普通用户的推荐渠道。请先安装 DSH，再将 TUI 添加到 `pi-tui` profile：

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@latest
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@latest
dsh --profile pi-tui
```

### Next / npm 线（验证）

预览安装使用 DSH 的 `alpha` channel 与 TUI 的 `next` channel；安装 DSH
时需要显式允许其原生安装脚本：

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@alpha
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@next
dsh --profile pi-tui
```

> **这两个 channel 今天不构成可安装的兼容 pair。** 它们只是通道指针：当前
> `@deepseek-ai/dsh@alpha` 指向 `0.2.1-alpha.5`，而 `@xmoon76/dsh-pi-tui@next`
> 仍指向 `0.5.2-rc.1`（peer floor `>=0.2.0-rc.2`，npm semver 不接受不同
> major.minor.patch tuple 的 prerelease）。请以下方版本对应表和
> [兼容性指南](docs/guides/dsh-compatibility.md) 的通用匹配原则为准；稳定版 `0.5.3` 发布在
> `@latest` 而不是 `@next`，因此这两个移动 channel 上没有可安装的兼容组合。
> 本 checkout 的精确验证请使用 `pnpm compat:dsh:npm`。

隔离的 npm 驱动仍按本 checkout 声明的精确 DSH 版本运行，并执行完整的
build/test/package 路径：

```sh
pnpm compat:dsh:npm
```

具体的稳定版最低版本、next 兼容范围和回退路径见[兼容性指南](docs/guides/dsh-compatibility.md)。

### 环境要求

* DeepSeek Harness
* Node.js `^22.19.0 || >=24`

### DSH 与 TUI 版本对应（重要）

| TUI 包版本 | 对应的官方 DSH tags | 说明 |
|---|---|---|
| `0.5.3`（stable / `@latest`） | `dsh-v0.2.1-rc.2`、`dsh-v0.2.1-rc.3` | 当前已发布稳定版；peer floor 仍是 0.2.1-rc.2，本仓库当前 checkout 的精确验证目标已前移到 0.2.1-rc.3 |
| `0.5.1`（stable，历史） | `dsh-v0.2.0-rc.2` | 上一稳定版；最低与精确验证目标均为 0.2.0-rc.2 family |
| `0.5.2-rc.1`（next 通道预览，已发布） | `dsh-v0.2.0-rc.2` | 上一轮 next 预览：已发布到 npm `next` 通道（2026-10-17）；整套 peer floor 仍是 `>=0.2.0-rc.2`，不覆盖 0.2.1-rc.2 |
| `dsh-v0.2.1-rc.1`（无配对 TUI） | 无 | 该中间版本没有本矩阵宣称兼容的已发布 TUI；不要为它复用 `0.5.3` |
| `0.5.0`（stable，历史） | `dsh-v0.1.7-rc.2`、`dsh-v0.2.0-rc.1` | 上一稳定版；最低 0.1.7-rc.2，精确验证目标 0.2.0-rc.1 |
| `0.4.9`（stable，历史） | `dsh-v0.1.7-rc.2` | 上一稳定版；0.1.7-rc.2 runtime 的兼容 TUI |
| `0.4.8`（stable，历史） | `dsh-v0.1.7-rc.1` | 上一稳定版；0.1.7-rc.1 runtime 的兼容 TUI |
| `0.4.6`（stable，历史） | `dsh-v0.1.5-rc.1`、`dsh-v0.1.5-rc.2` | 上一稳定版；0.1.5 runtime 的兼容 TUI |
| `0.4.7-alpha.2`（next，历史） | `dsh-v0.1.6-alpha.2` | 上一条 next 线；0.1.6-alpha.2 runtime 的兼容 TUI |

不要把稳定线与 `@next` 预发布线混装。`0.5.3` 是当前已发布稳定版：它的最低 DSH
版本（peer floor）仍是 `0.2.1-rc.2` family，而已发布的 `0.5.3` 与后续的
`0.2.1-rc.3` 也已实测配对（官方 preset assembly 在 rc.3 下通过）；本仓库当前
checkout 的精确验证目标前移到 `0.2.1-rc.3`，这不改变 `0.5.3` 已发布包的身份与
floor。中间的
`dsh-v0.2.1-rc.1` 没有配对 TUI，`0.5.2-rc.1` 是上一轮已发布到 npm `next` 通道的
预览身份（配对 0.2.0-rc.2；它不覆盖 0.2.1-rc.2，因此新的稳定线使用 `0.5.3`
身份）。上一稳定版 `0.5.1` 继续配对 0.2.0-rc.2：它把整个 DSH peer floor 提升到
`>=0.2.0-rc.2`（Question 生命周期消费 rc.2 才发布的公开契约）。更早的 `0.5.0`
保持 `>=0.1.7-rc.2` floor 不变（精确验证目标 0.2.0-rc.1）；旧 runtime 会在正常的
不兼容边界以非零状态失败，请按上表安装配对的 TUI 线。上方的版本对应表是已发布
线的摘要；通用版本匹配原则与回退/诊断流程见[兼容性指南](docs/guides/dsh-compatibility.md)；要查看 `@next` 的最新集成
状态，请看 [next 分支 README](https://github.com/XMoon/dsh-pi-tui/blob/next/README.md)。

新的 Agent preset 使用当前 roster 中选定的 id。DSH 允许合法的自定义
`code` preset；只要当前 roster 存在它，显式输入和持久化状态都会保留 `code`。
DSH V3 migration 负责历史 session header/selection 的 `code -> ptc` 转换；
当前 projection 会原样保留合法的自定义 `code`。省略请求的 legacy settings
default 不再做任何别名映射：当前 roster 没有声明就是无效偏好。

### Profile management

更新已安装的 TUI：

```sh
dsh plugin --profile pi-tui -- update @xmoon76/dsh-pi-tui
```

查看已安装插件：

```sh
dsh plugin --profile pi-tui -- list
```

卸载：

```sh
dsh plugin --profile pi-tui -- remove @xmoon76/dsh-pi-tui
```

恢复已有 Session：

```sh
dsh --profile pi-tui --session <session-id>
```

## 功能

### 对话与工具

* 流式 Markdown 输出
* Thinking 折叠与展开
* Tool Call 卡片及运行状态
* Tool / System 详情折叠
* Transcript 全文搜索
* 长会话历史折叠
* Context、Token、模型和运行状态显示
* Approval 与 `ask_user_question` 交互
* Plan Review
* Todo / Goal 状态展示
* 可读的终端窗口标题
* 长会话按有界窗口浏览，并保留翻页与实时跟随位置
* 超长用户 Prompt 默认折叠为 head + marker + tail；普通与全屏非 Focus 下 `Ctrl+O` 展开、收回
* Compaction / prune 后不会出现重复的幽灵 Tool Card

`Ctrl+O` 控制工具和系统详情，并在普通模式与全屏非 Focus 下展开/收起超长用户 Prompt;全屏 Focus 下它整体展开最近几个 Thought root 或全部收起，超长用户 Prompt 改用点击提示行（或搜索命中）展开、`Ctrl+O` 收回。`Alt+T` 单独控制 Thinking。

### Conversation display

`/display` 在三种展示预设间切换：`full`（默认）是普通 Transcript 展示；`focus` 将当前回合的 Thinking、Tool Call 和中间回复聚合为一个实时更新的 Thought 区块；`compact` 把连续的过程折叠为带 Header + `Think:` / `Action:` 预览的 `Activity` 段，会话与 assistant 的中间输出仍按时间顺序可见，注入的 notice / relay / recall 改为独立呈现（相邻的环境类注入合并为可展开的 Context 簇），展开用鼠标点击或 `Ctrl+O`。`/settings` 的 `Display` 行提供同一组取值并持久化；`/focus` 仍作为兼容命令保留。

需要查看过程时可以展开，关闭 Focus 后恢复普通 Transcript 展示。全屏 Focus 中可以按 Thought root 批量展开/收起,也可以单独点击卡片;切换或缩放时会保留 viewport。展示预设只影响界面投影，不修改 Session 中保存的事件。

### 沟通策略

`/settings` 提供两个独立的沟通设置。**Progress updates** 控制 Agent 工作时的中途更新节奏：`milestones`（默认）只在完整的阶段结束、方向实质变化或需要用户输入时简短汇报，不为「刚发现一个局部结论」而打断；`frequent` 在较长的多步工作中持续带用户跟进；`off` 完全不做过程叙述。**Response style** 控制可见回复的密度：`default` 不附加表达指导，`concise` 紧凑且结果优先，`explanatory` 补充原理、架构与取舍。两项切换都在下一次提示词组装时生效，无需重启 Agent，并跨会话保存。Focus 是展示能力而非第三个偏好：进入 Focus 时进度更新节只是暂时失效（不生成只含进度的中间消息），保存的节奏偏好不变，Response style 在 Focus 下仍然生效。

### Session

支持 DSH 持久化 Session，包括：

* 新建和恢复 Session
* Session 切换
* 重命名
* Fork
* Rewind
* Session lineage
* `/export` — 完整 Session 归档(含子代理与附件),保存到 Client 本地目录
* `/transcript` — 可读 Markdown 对话记录,保存到 Client 本地目录

使用：

```text
/sessions
/fork
/rewind
/export
/transcript
```

空闲且编辑器为空时也可以快速按两次 `Esc` 打开 Rewind。

Rewind 会从选中的历史 User Turn 创建新的 Child Session，并把对应 Prompt 放回编辑器。原 Session 不会被修改。

### 输入历史

`Ctrl+R` 打开输入历史搜索。

支持三个范围：

* Current session
* Current directory
* All directories

历史结果包含 Prompt、工作目录、时间和 Session 信息。选中历史后只恢复到编辑器，不会立即发送。

普通的 `↑` / `↓` 仍用于快速浏览最近输入。

### Subagent 与 Task Center

`/tasks` 打开完整 Task Center，显示当前 Session 中仍由 Job Registry / Subagent catalog 跟踪的工作；Footer 的 `↓`（仅在光标位于编辑器最后一个可视行时）打开按需的 Quick 窗口，它默认不占行、出现在整个 Footer 之下。选中 Job 后进入全屏 Job 工作区：顶部一行显示 Job 身份、主题状态与大写状态及 `[GAP]`/`[ERROR]`/`[SETTLED]` 事实，下面是真实进度/说明、命令摘要与 `Output`/`Command` 阅读标签。Output 是官方非消耗式的实时输出预览（可滚动、可搜索，并明确标注为保留尾部而非完整历史），Command 页可阅读并按原文复制 shell 命令。工作区不会消耗模型的 `job_output` 游标，也不写入会话历史。

Task Center 的 `ACTIVE` / `TRACKED` 是展示范围：`ACTIVE` 只显示当前活动项，`TRACKED` 显示当前跟踪源（Job Registry / Subagent catalog）仍列出的全部项；`TRACKED` 不是 Session 执行历史。DSH `0.1.7` 会在普通前台 `bash` / `pwsh` 执行期间临时注册 Job，使其可以在 Task Center 中观察和停止；如果命令在前台等待内完成，DSH 会移除该临时记录，最终结果仍保留在 Transcript 的 tool card 中。显式 `run_in_background: true` 或被提升为后台的 Job 在完成后，只要 Job Registry 继续保留其记录，就仍可在 `TRACKED` 中查看。

`/plugins` 是 `/settings → Plugins` 的深链：两者使用同一个 Settings 全屏 lease 与同一个 Plugin Manager 页面，不再有独立的插件全屏界面，也不会新建或切换 Session。目录固定为 TUI & Extensions / Official DSH / Third-party / Experimental（实验组最后），可搜索、筛选、查看来源与状态，并从官方目录执行安装、启用/禁用与删除；结果以 Host 实际返回的版本、重启要求和错误为准。≥120 列且能留出至少 6 行真实业务正文时同屏显示 `类别 | 插件列表 | 详情`；76–119 列按键盘焦点显示 `类别 | 列表` 或 `列表 | 详情`（`列表 | 详情` 同样要求至少 6 行真实业务正文，不足则退化为单栏），<76 列单栏；安装、危险确认与 Diagnostics 始终占满整宽，以免压缩风险文案。顶部身份/元数据/分隔线/面栏和最后一行操作栏由 Settings 统一绘制，插件只占业务正文。正在提供当前界面的 `dsh-pi-tui` 只读且不可从自身界面禁用或移除。从 Settings 的 `Plugins` 分类预览或 `/plugins` 进入都保留同一个页面实例与后台安装请求：Esc 从列表回到 Settings 分类，再按一次 Esc 关闭。页面内按 `d` 打开只读的 **Diagnostics**：按 owner 分组显示 extension 贡献的 `active/failed/shadowed` 状态与完整 `lastError`、各 registry 计数、实际 capabilities，以及无法证明 Loader entry 归属的贡献（单列 `Unassociated extension contributions`）；`c` 复制所选事实、`C` 复制全部、`r` 重新读取、Esc 返回。Diagnostics 只读 extension ledger，不把 Host 包安装状态或安装日志混入其中；`copy` 仍只证明已发送，不证明操作系统剪贴板已收到。

Experimental 组的 14 个官方 rc.2 实验包在 Detail 中给出固定的终端可用面与限制/风险说明（Web-only、Host-only、B04 的 WEB_ONLY/Host 行未挂载（Owner 已接受）、B13/B14 的已验证 one-shot/provider 边界等），这些说明只随精确官方包身份出现，不随启用状态伪装成 Host 能力通过；升级指引按 Host 事实区分「随 DSH 发行升级」「profile 包先 Remove 再显式 Install」「官方 on-demand 目标」和「当前 TUI 由外部管理」，不提供原地更新、版本选择器或静默重装。

Subagent 按完整 lineage 显示，包括嵌套创建的 descendant：

```text
main
├─ subagent A
│  └─ subagent B
└─ subagent C
```

浏览器会区分：

* `continuable`
* `one-shot`
* running / inactive
* nested descendant
* Job Registry 跟踪的 Job（含运行中的前台 shell）

Footer `↓` 打开的 Quick 窗口默认不占行，只在编辑器最后一个可视行按 `↓` 时展开到 Footer 之下：`↑↓` / `PgUp` / `PgDn` 选择，`Enter` 用真实任务身份打开既有详情，`↑`（首行）或 `Esc` 返回编辑器并保留草稿；列表末尾的 “Open Task Center” 行进入完整 Task Center。

完整 Task Center 额外提供 `A` 切换 Active / Tracked、`/` 搜索、`Tab` / `Shift+Tab` 双向切换类型、`S`（确认后）停止所选任务以及 `R` 刷新 / 重试。Quick 窗口只消费上述导航键，其余输入一律 no-op，不会进入搜索、停止确认或任务管理状态，因此 `Esc` 始终一层关闭。

已经结束的 one-shot Subagent 仍可以打开并查看持久化 Transcript。

对于当前 Session 的直接 `continuable` Child，可以进入交互式 Viewer，并直接向该 Subagent 发送后续消息（走 DSH 官方 `subagents.prompt()` 人类输入通道——按顺序排队为 Child 自己的下一个 turn，并保留 user 来源）。Child 使用自己的 Transcript、Draft 和运行状态，不会修改主 Session 的输入。

更深层的 nested Subagent 默认以只读方式查看。

官方 Subagent 模型选择（DSH `subagent-model-selection` 设置）可在 `/settings`
中开关并维护 allowlist：开启后**新建** Session 的官方 `subagent` 工具可以按调用
选择子 Agent 的 provider/model（受 allowlist 限制）。设置在 Session 组合时采样，
不会改写已在运行的 Session 的工具。

### Shell

编辑器支持两种 Shell 模式：

```text
! git status
```

在宿主（Host）环境执行命令，并把输出提交到当前 Session。

```text
!! git status
```

同样在宿主环境执行，但输出不进入模型上下文（仅卡片展示）。

`!` / `!!` 是独立的编辑器模式，而不是普通文本前缀。进入 Shell 模式后 Prompt 和补全行为会同步切换。

Shell 卡片默认只显示有限的输出预览，`Ctrl+O` 可以展开完整保留内容——全屏 Focus 除外:那里 `Ctrl+O` 负责 Thought root 的整体开关,Shell 卡片保持折叠。

### Git 提交署名（可选）

开启后，dsh-pi-tui 会指示 Agent 在创建 Git 提交时加上官方项目署名：

```text
Co-Authored-By: @xmoon76/dsh-pi-tui <dsh-pi-tui@xmoon.org>
```

默认 **关闭**。支持三种模式：

```text
off            不添加署名指引（默认）
product        官方 Co-Authored-By 署名
product-model  官方署名 + Assisted-By: <provider>/<model>
```

这是 **Agent 指引（prompt policy），不是仓库级强制**：dsh-pi-tui 不会安装 Git
钩子、不改写任何 `git commit` 命令、也不探测仓库。`product-model` 的
`provider`/`model` 由 DSH 官方模型选择直接注入（切换模型后下一次请求生效）。

边界说明：

- `!` / `!!` 用户 Shell 和你自己终端里的手动提交完全不受影响；
- 不安装任何 `prepare-commit-msg` 钩子，不修改已有钩子；
- **使用 `minimal` preset 时不生效**：该 preset 的 persona 是完整 system prompt
  （`complete: true`），会替换掉其它全部 section；既有的 TUI 指引（Progress updates、
  Response style、Focus）在该 preset 下同样是这种既有行为；
- 不需要 GitHub 凭证/API；不修改 Author/Committer 身份；
- 模型理论上可能忽略或写错指引——这是有意的取舍：用低侵入的指引替代一整套
  Git 生命周期子系统。

### 文件引用与图片

输入 `@` 可以搜索和补全工作区文件：

```text
@src/index.ts
@"path with spaces/file.ts"
```

`/attach <path>` 是统一的 Client-local 图片/文件入口；`/image <path>` 保持图片专用兼容语义。两者都支持文件与目录补全；带空格、引号或 Windows 分隔符的路径会保留输入方言，目录可以继续展开。

能够解析的相对路径会在提交时转换为明确的文件路径。

支持通过 `Ctrl+V` 添加剪贴板图片，并使用 DSH Attachment 能力保存到 Session。

### 模型与运行设置

TUI 使用 DSH 提供的模型和设置服务。

常用入口：

```text
/model
/settings
/status
/login
/permission
/plan
/goal
/compact
/footer
/statusline
```

模型切换、Reasoning Effort、权限 Preset、Plan 和 Goal 都沿用 DSH 对应的运行时语义。`/model` 的候选完全来自 Host 的模型目录：rc.2 的 `deepseek-flash` 以精确 `(provider, model)` 身份出现（显示名 `DeepSeek-V4.1-Flash` 不当作 ID），选择后写回官方 Session/global 默认；部署覆盖目录不再提供该 ID 时不会凭空显示。

`/settings` 打开一个真正的全屏工作区，三栏 / 两栏 / 单栏只是同一套
`分类 → 设置行 → 详情` 三层的投影：宽屏同时显示三栏，中屏按当前层显示
`分类 + 设置行` 或 `设置行 + 详情`，窄屏只显示当前层。所有宽度上 `Right` 只前进一层，
`Left` 返回一层（在最外层无效）；`Enter` 遵循相同层级，`Esc`/`Backspace` 逐级返回，
最外层关闭工作区。`Tab`/`Shift+Tab` 不承担导航，底部操作栏始终固定在最后一行。多栏编辑态仍
保留 `[Details]` 焦点标识；只有标题会占掉唯一内容行时才让位。
它展示 Appearance / Conversation 的真实事实：主题的 source-qualified 原始值与友好名称、
Icon style、Transcript display 的运行时当前值与持久偏好、Thinking detail 的当前运行
态，以及每个条目的配置来源 Scope 与 backend 就绪状态；`R` 重新读取；浏览与选择本身都不写入配置。
普通配置详情只保留查看：它没有内置复制动作，也没有替代的复制入口。About 的 `c`/`C` 只
复制 About 自己的事实（运行时、Session 身份、统计、性能与 Context），不会复制配置页字段。

About 的复制入口只留在键盘上：选中一事实按 `c` 复制该事实的精确原始值（动作栏只在它真的
画在屏幕上时提示 `c copy fact`），按 `C` 把整份 About 报告复制到剪贴板；正文里最多只有
一个 `Copy All [C]`，每条事实后面不再有 `Copy [C]` 按钮，点击普通事实也不会复制。
`Shift+C` 在分类栏焦点下同样可用。复制仍只证明已交给本地剪贴板交付路径，不写入任何配置。

`/status` 是 `/settings` 的真实别名：同一 handler、同一初始 About 焦点与同一套读取；无 Session
时两者都不创建会话、不读统计。`/footer` 与它的别名 `/statusline` 直接打开同一个 Settings
全屏工作区的 Appearance → Configure footer layout 页；裸 `/keybindings` 同样直接打开
Input & Terminal → Keyboard shortcuts 页。两者共用唯一 Settings lease、唯一底栏和原有
的 Footer / Keybinding 保存权威，不再打开第二个 overlay。关闭这两个编辑页会直接回到所属设置行的
Rows 列表（不经过中间的 Detail 面板），下一次返回键即到分类栏。在两个页面的根状态（Footer 行选择器、
键盘快捷键在搜索为空时的列表）按 `←` 与 `Esc` 一样返回来源设置行，底栏会显示 `← Back`；Footer
有未保存修改时 `←` 先打开 Save/Discard/Keep 确认，进入行编辑器后 `←` 仍是切换左右分区，
搜索框非空时 `←` 仍只移动光标。
Settings 的一级分类是固定的 `About / Models / Account / Agent / Appearance / Conversation / Input & Terminal / Tools / Plugins`，
并且只在扩展设置注册表确实有设置行时才在末尾追加 `Extensions`；`/settings`
（以及 `/status`）默认落在 About。`Extensions` 的增删与同一 id 重新注册都会先作废旧帧的
键盘与鼠标授权，重绘完成前只有 `Esc` 还能安全返回。

`Extensions` 是真实配置分类而不是过渡入口：Rows 每次只显示**一个注册 owner** 的实时设置；
组序按该 owner 在注册表全局 `order ASC, id ASC` 流中首次出现的顺序，组内保持注册表原顺序。
至少两组时 `Tab` / `Shift+Tab` 循环切换组（落在目标组第一行），`↑↓`、Home/End、翻页与滚轮
只移动组内设置；只有一组时保留原有区域焦点键。标题栏先显示 `[i/N]` 再显示组名，窄屏先截断
组名而不是位置；Rows 面栏按宽度退化为 `Rows (m) · 组名` → `Rows (m) · i/N` → `Rows (m)`。
每行进入原生 Detail/Choice：Owner 与 ID 显示原始值，未注册候选值的设置只读，当前值不在候选里
会明确说明而不会自动选中；只有显式 Confirm 才经 `SettingsRegistry.applyDetailed` 写入运行中的
扩展，`accepted` 后回读一致才 `Verified`，插件拒绝显示 `Not saved` 并把健康错误只记在发起调用
的 owner 上，被更新版本取代或已卸载则如实报告而不伪装成插件拒绝。扩展设置只作用于运行中的
插件，不写 TUI 设置文档或 Host profile；同一 id 的 HMR 重注册会作废旧确认/重试/结算。`Models` 是原位页：列出 Host 的 provider 目录、API key 是否已配置（只是存在性，
不是连通性测试）与 DeepSeek Account 入口；可查看 provider 事实、在遮蔽输入中写入/清除 API key、
完成 Add Provider 草稿向导，以及发起 provider-native 登录（页面内持续显示 URL、提示与取消）。
`Account` 是独立的 DeepSeek Account 页：显示 Host 的登录状态、浏览器授权 URL 与 SSH 隧道提示、
以及各自独立的 Profile / 充值钱包 / 赠送钱包状态（失败不伪造为 0），可显式取消当前 attempt、刷新，
并在二次确认后 sign out；关闭页面不会取消已经开始的浏览器登录。`/login` 与 `/logout` 现在只解析目标并
打开对应页面（`/login` 打开 Models、已知 route 进详情、已知/新 ref 进 API Key Reference、新 route
预填 Add Provider、`deepseek-account` 进 Account；`/logout` 打开已存凭据列表或单一清除确认），最终
写入/清除必须在页面里明确确认。Account 授权与普通 provider flow 分开：Account 只通过官方
PlatformAccount 与 Host 的 loopback `/oauth/callback` 登录，不会被当作普通 credential record 清除。

其中 **Theme、Transcript display、Icon style、Transcript detail、Thinking detail、Progress
updates、Response style 七行，以及 Tools 里的 Visual tools 开关，都可以直接修改**：在 L1 设置行按
`Right` 或 `Enter`，或点击 `[Change…]` / 可见的 Detail 内容，即可在同一 L2 详情中打开
候选选择；当前值与 Runtime / Persisted 事实留在同一详情事实区，并与候选列表独立滚动。`Up`/`Down`/`Home`/`End`
移动候选，`PgUp`/`PgDn` 和事实区上的滚轮只滚动详情事实，候选区滚轮独立滚动候选；
选择期间的复制键不复制任何内容，也不会提交候选。
`Enter` 或点击 `[Confirm]` 明确确认，`Left`/`Esc`/`Backspace` 或 `[Cancel]` 取消并直接回到
L1，零写入。L2 浏览/已结算时，`Enter` 可重新打开可写行的选择；pending 写入时不触发新选择。若当前候选身份已滚出可见区域，第一次 `Enter` 只将其重新显示，之后才能确认；
44×8 短屏在长身份需要空间时先省略可选的 `Choose value` 标题；若仍不足，再将事实区压到只保留旧 `Value` 的一行。只有完整身份、`Confirm` 与 `Enter confirm` 同屏可见时才能确认，超过剩余容量仍拒绝写入。只有实际绘制出来的
按钮与候选行可以点击。确认后走既有的串行整文档写入路径落盘，再从权威来源重读目标字段核对：
详情把两类事实分开显示：以运行态为主的行（`Icon style`、`Transcript display`、`Progress updates`、
`Response style`、`Git attribution`、`Home/End keys`、`Mouse wheel lines`、`Notifications`、
`Notification method`、`Terminal progress`）用 `Value` 呈现已生效的运行值、另用 `Persisted` 呈现存储值；
主事实是持久值的只有 `Configured theme`、Tools 下的 `Visual tools`、`Submit while busy` 与
`Fullscreen`，它们因此额外画出 `Runtime` 行（如当前 palette、下一次忙时提交策略、当前 transcript 模式）。
`[current]` 是另一件事：`Configured theme` 与 `Transcript display` 按持久偏好标记，`Icon style`、
`Progress updates`、`Response style` 按实时值标记；Tools 下的 `Visual tools` 单独一类，它的候选项
`[current]` 反映 **Host 配置值**（`state.enabled`），运行态注册是否生效另由 `Runtime` 行表达。
两类行都会显示
`Saving…` / `Verified` / `Not saved · 原因` / `Commit accepted · verification unavailable` /
`Outcome unknown · 原因`，只有写入完成、backend `ready` 且权威回读一致才显示 Verified；
被拒绝的写入会先重读权威：仍停留在请求起点值才报 Not saved，出现第三个值、已是目标值或无法读取
则如实报 Outcome unknown；写返回成功但权威可读地不一致同样按失败显示，而不是
"verification unavailable"。backend 不 ready 时主题不会被应用或写入；显示预设可以先在本机生效，
此时会明确说明未能保存，而不是假装保存成功。插件主题在确认时再次按 source-qualified 身份解析，
已卸载的插件主题标记为 unavailable 并拒绝确认，不会退化成同名文件主题。这三类写入器互不混同：
`Icon style`、`Progress updates`、`Response style` 先作用于各自的实时 owner（图标调色板；Agent
提示词实际读取的同一份 progress/response state 对象），再经唯一串行整文档写入落盘；`Transcript
detail`（与 `Ctrl+O` 同一份开关）与 `Thinking detail`（与 `Alt+T` 同一份开关）是纯运行态，
没有持久字段，详情里明确写 `not applicable — runtime-only`，其 Verified 只代表运行态已生效。
三者的 `[current]` 标记实时生效值（先应用后落盘），`Persisted` 另行显示文档里的原始存储值
（未声明显示 `not set`，文档不可读显示 unknown）；归一化后的回退值永远不会伪装成已保存值。
`Configured theme` 与 `Transcript display` 保持原有语义不变：主题在 backend 非 ready 时先拒绝、
不应用运行时，二者的 `[current]` 依据持久偏好而不是实时值。`Progress updates` 与
`Response style` 的切换在下一次提示词组装时生效，不重新注册 section、不重建 Agent；Focus
只是暂时抑制进度叙述，不修改已选择的节奏。

`/settings → Tools` 提供一个 profile 级 **Visual tools** 总开关（默认 On）：它对应 Host 的
`pi-tui-visual-tools.enabled` 配置，一处开关同时管三个模型工具 —— 生成图的 `dsh_pi_tui_chart`、
`dsh_pi_tui_svg`，以及显式发布的 `present_visual`。关闭后三者会从该 Host 的全局工具注册表一起
注销，之后新的模型请求不会再看到它们；重新打开会一起恢复原定义。三个注册保证的是**收敛后**的
一致性：一次成功的开启最终持有全部三个，成功的关闭最终一个都不持有，任一注册失败会把本次已
注册的定义回滚掉；官方工具注册表每次注册都会同步发出一次变更通知、没有事务化接口，所以同步
观察者可能看到过渡中的中间状态，但收敛后不会留下半启用状态。设置属于整个 DSH Host profile（跨会话、
跨 Agent，不只是当前 TUI）；关闭只影响未来的工具可用性，已经记录在 transcript 里的图表/SVG
结果、模型可见的 `visual-ref-v1` 引用与历史发布记录仍可正常显示、复制、搜索与导出。Direct
后端会同时核对 Host 注册表状态后才显示 `Verified`；Remote 没有注册表读取通道，只如实显示配置
已保存，不宣称运行态已生效。

Conversation 与 Input & Terminal 的八个历史设置现在都在工作区里直接编辑：Conversation 顺序固定
为 Transcript display → Transcript detail → Thinking detail → Progress updates → Response style →
Submit while busy → Git attribution；Input & Terminal 固定为 Home/End keys → Fullscreen →
Mouse wheel lines → Notifications → Notification method → Terminal progress →
Keyboard shortcuts…；最后一项打开的是与裸 `/keybindings` 相同的同 lease 全屏页，不再进入旧编辑器。

`Submit while busy` 与 `Fullscreen` 是**先写文档**的两项：只有写入完成且权威回读一致才显示
`Verified`，运行态不会被假装已切换。`Submit while busy` 的 `Value` 就是文档里的原始值（缺失显示
`not set`，非法显示 `invalid stored value: <原值>`），`Runtime` 明确写出下一次忙时 Enter 的策略，
默认值会标注为 `queue (default; no valid saved value)`，绝不冒充已保存值；确认后不影响正在进行的
回合。`Fullscreen` 的偏好确认后工作区照常可操作，**正常退出 Settings 后才切换 transcript 屏幕**；
被 Question/Approval 抢占、被强制关闭或写入未确认都不会切屏，已保存的偏好会在下次 TUI 启动时生效。

其余六项先改真实运行态再持久化（失败不回滚运行态，`Persisted` 单独显示文档原始值）：
`Git attribution` 改的是同一个 `tui:git-attribution` 提示词状态，仍只是提示词引导（不生成 Git hook、
不自动修改 commit，`minimal` persona 依旧不接收该引导）；`Home/End keys` 改的是全屏视口实际生效的
按键绑定，其他键位不受影响；`Mouse wheel lines` 只对**下一次**全屏生效，当前视口保持进入时的步进；
`Notifications` 与 `Notification method` 改同一个完成通知控制器，改 method 本身不会发出通知；
`Terminal progress` 只控制终端原生状态协议（OSC 9;4 / OSC 7501），与 `Progress updates` 的叙述节奏
互不影响；旧文档里的 `on` 只在读取时归一为 `9;4+7501`，不会在未确认时被写回。

`/settings → Agent` 现在直接编辑五项，不必再进旧编辑器，顺序固定为
`Approval policy (this session)` → `Default permission` → `Subagent allowed models` →
`Subagent model selection` → `User shell sandbox policy`。五项各有唯一权威，语义互不混同：
`Approval policy` 是**当前会话**的官方 approval override，本工作区打开时只捕获一次该会话，
之后即使切换会话也不会改投到新会话（确认被同步拒绝，需重开工作区）；它的 `Persisted` 明确写着
`not applicable — current session only`，`Runtime` 单独说明下一次审批实际会用的是会话 override
还是消费者的 `ask` 回退。`Default permission` 是 Host 的 `permission.defaultPreset`：候选就是
Host 公布的 preset 原始 id，只影响**以后新建**的会话，当前会话的 preset、sandbox 与 approval
不变；写入返回成功但 Host 回读不一致时不会显示 `Verified`，而缺少 settings 服务时会明确失败，
不再把 no-op 当成功。`Subagent allowed models` 用 `Manage allowed models…` 在**同一个工作区租约**
里打开原有的可搜索多选列表（同一套分组/过滤/滚动与 `Enter toggle`），
`Esc` 只回到 Agent 行而不是退出设置；`Subagent model selection` 是该官方 section 的 `enabled`：
没有 allowed route 时开启会**零写入**、给出提示并把选中行移到 allowed models 行，关闭则保留全部
已存 route。两个子代理入口与旧编辑器共用唯一一条写入队列，而且每个操作只写自己拥有的那一半
（picklist 只写 allowed route 列表、开关只写 enabled），另一半在轮到它时从官方 section 重新读取，
所以先前的慢写不会再被后到的旧快照覆盖。
`User shell sandbox policy` 存在 TUI 设置文档里，`Value` 是原始存储值（未设置/非法值/不可读都分别
如实显示），`Runtime` 说明下一次 `!`/`!!` 的实际效果（包括「无可信存档值，使用默认 bypass」），
只有写入完成且回读一致才 `Verified`；它是 Host 的用户 shell 执行策略，不是模型工具 sandbox 策略，
也不是权限 preset，因此不放在 Input & Terminal。

新的 Settings 工作区不再跳转旧设置编辑器：所有字段都在原生行里编辑，`Extensions` 也直接列出
真实动态设置行（按 owner 分组分页）。Theme、Plugin Manager、键位与扩展设置的写入路径全部不变；
Footer 与 Keyboard shortcuts 仍是同一 Settings lease 内的专页，`Appearance`、`Input & Terminal`、
`Agent` 与 `Extensions` 都不再有过渡入口。旧 `SettingsList` 仍由 `/help`、`/skill`、
`/preset`、`/keybindings conflicts` 这些独立消费方使用，它们各自提供自己的行；旧完整设置编辑器
不再是 Settings 的入口。

`/settings → Tools → Web Search / Fetch` 现在是**同一个 Settings 工作区里的专页**（不再先关工作区、
再进旧编辑器）。页面固定六行：搜索 Provider（`Messages`，官方默认，或独立计费的
`DeepSeek Search API`）、Fetch Provider（`HTTP`，官方默认，或 `DeepSeek Fetch API`）、Search API
结果数（官方范围 1–50，快选 5/10/20/50；Host 里已有的其他整数照原样显示、不会被改写）、
`Share Original Question`（官方默认开启；每次新的 Search API 调用附带最多 128 字符的触发人类问题
`ori_question`，不发送完整历史或系统提示词）与 API endpoint base（沿用原有 endpoint 编辑器：完整
URL 草稿 + 明确 Enter 确认，并警告凭据与查询会发往该 HTTPS 地址；URL 形状会校验，但目标是否可信
必须由人判断），最后是只读的 `DeepSeek API Key`。两套 API 都是独立的 opt-in 收费 provider：登录或
普通 Messages 套餐不保证覆盖其费用，默认的 `Messages`/`HTTP` 组合也不会调用收费 API。Web 配置是
base profile 所有的设置，不是 Bxx Optional Bundle；安装或启用任何其他 Bundle 都不会改变这两个
provider。

每个值只有**明确 Enter 确认**才写入，移动焦点、展开详情、Tab、刷新、退出都不会写入；写入后由权威
回读判定 `Verified` / `Not saved`（并显示 Host 保留的值）/ `Outcome unknown`，从不按提交意图伪造
成功。自定义的 provider id 原样显示、不提供可确认候选，也不会被导航悄悄替换成 `Messages`/`HTTP`；
确认一个 Host 已有的值不会产生多余写入。选择对下一次搜索/获取生效，运行中的操作不会被追溯切换。
DeepSeek API key 只显示是否配置与来源层，`Configure in Models…` / `Clear in Models…` 会在同一个
Settings lease 里跳到既有的 Models `API Key Reference` 页完成遮蔽输入或清除确认——Web 页自身从不
收集密钥，也不执行 `/login` / `/logout` 文本命令。按 `Esc` 从详情回到 Web 列表、再回到
`Web Search / Fetch` 行；Remote 或不可用的 Host 段仍可打开只读说明页，但不提供任何写入入口。
旧的完整编辑器仍然保留（入口只剩 `Extensions` 过渡行），其历史 Web 行在退休前与新页面共用
同一个写入队列与读取权威。

`/settings` 中的 `Icon style` 可切换 TUI 结构图标的风格(也可在 Appearance 里直接改):`Emoji`(默认,
彩色)、`Symbols`(紧凑的单格终端符号)、`Minimal`(隐藏装饰性图标,只
保留状态/交互标记);切换立即生效并持久化。

`/settings` 中的 `Terminal progress` 控制原生终端状态上报,共四档:
`9;4+7501`(默认,同时上报 OSC 9;4 进度条与 OSC 7501 语义状态)、
`9;4`(只保留进度条兼容协议)、`7501`(只上报语义状态:运行中 / 等待审批 /
等待回答 / 完成 / 出错)、`Off`(清除并停止上报)。切换立即生效;完成与出错
只在一次真实运行的最后一个 turn 结果被证实后上报,中断或取消会回到空闲。
旧的 `On` 配置读作默认双协议。

终端兼容性说明:不认识 OSC 7501 的终端会直接忽略它——目前 Ghostty 的 GUI
只显示 OSC 9;4 进度条、不显示 7501 语义状态,这是预期行为,不代表上报失败。
在 tmux 等终端复用器里,未知 OSC 可能不会被转发到外层终端(本功能有意不实现
tmux 的 DCS passthrough,也不修改复用器设置);需要跨复用器保留状态时请直接
使用支持它的外层终端。此外,OSC 7501 的语义状态只作用于当前 Main Agent。

本项目的 Remote(实验性、自有 Host 组合)同样上报这套状态:Host 侧由本扩展自带的
私有状态流提供,并与 Direct 共用同一份区间判定。**未安装本项目 Host 扩展的第三方
DSH Host 不支持**这套上报(它没有对应的事件源)。

其他插件注册到 `ctx.commands` 的 Slash Command 也会被自动发现。

### Footer 自定义

`/footer` 在同一个 Settings 全屏工作区中提供 Footer 编辑器（Appearance → Configure footer
layout）。你可以组合内置状态条目，调整左右位置、顺序、Style、Tone、Prefix/Suffix 和
Importance，也可以创建自己的 Footer 条目。

支持四类条目：

- **Builtin Item**：Model、Context、Token、Tasks、Git branch 等内置状态；
- **Custom Text**：用户创建的固定文本；
- **Custom Command Item**：用户创建的动态命令输出，可和其他条目一起排列；
- **Extension Item**：插件通过 Stable Extension API 提供的 Footer 条目。

在窄终端中，支持 compact 的内置条目会先自动缩短；空间仍不足时再按 Importance 隐藏低优先级内容。运行时 compact 不会修改你保存的 Style。

`/footer` 的 Custom Command Item 和 `footer: command` 是两种不同能力：前者只是一个可以与 Model、Context 等混排的动态条目；后者把整个 Footer 状态表面交给一个用户命令。

完整的 `/footer` 使用方法、Custom Text / Command、YAML 配置、安全模型和排错说明见：

- [Footer 自定义完整指南](docs/guides/footer.md)
- [Extension API（插件作者）](docs/extensions/stable.md)

`/statusline` 是 `/footer` 的别名。

### 图片

Ctrl+V 会读取系统剪贴板：剪贴板里是图片时得到规范占位符 `[image #N (宽×高)]` 并在输入框上方一行显示草稿缩略图（窗口过矮时客户端会把这一行隐藏，输入与发送不受影响，状态行仍报出真实草稿数），是文字时插在当前光标处。`/image` 与 `/attach` 也可以把图片或普通文件加入当前草稿；同一个占位符出现多次会显示多个位置，但只读取、上传一次。

用户消息、助手消息和工具结果里的图片都按原始顺序显示在各自的卡片中：一行身份信息（名称、像素尺寸、字节数）加一张图片。点开图片后的查看与缩放由终端客户端自己提供（相邻图片导航取决于客户端版本与能力），本项目不另外弹出窗口或页面。图片读取失败、格式不支持或超出单张 16 MiB 限制时，卡片会显示身份与真实原因，不会显示伪造的图片。在原生 Kitty 终端中，Transcript 缩略图、输入框上方的草稿预览卡以及从图片打开的全屏查看页都会先在后台把 JPEG/WebP 转换成受限的 PNG 再显示像素（WebP 只取第一帧、按 EXIF 方向摆正、最长边不超过 768 像素；身份行与查看页仍使用原始名称、尺寸、格式与字节数；草稿卡只处理当前最后一张有权限显示的本地图片）。折叠的缩略图不会触发转换；转换中或失败时只显示文字（失败为 `Preview unavailable`），只有真正画出像素的正文才能点击。全屏查看页展示的是同一份受限缩略图，不提供高清原图浏览；PNG、iTerm2、GIF、窄屏与不支持图形的终端行为不变。

## 常用按键

| 按键            | 功能                     |
| ------------- | ---------------------- |
| `Enter`       | 提交输入                   |
| `Ctrl+Enter`  | 与 Enter 的忙碌行为相反(默认 steer,`busyEnter=steer` 时入队) |
| `Shift+Enter` | 换行                     |
| `Esc`         | 取消当前交互 / 中断运行          |
| `Esc Esc`     | 空闲时打开 Rewind           |
| `Ctrl+C`      | 键盘退出确认;首次清空草稿       |
| `Ctrl+D`      | 空草稿时键盘退出确认;有内容时向前删除 |
| `Ctrl+S`      | Steer:把队列消息和草稿一起发送到正在运行的回合 |
| `Ctrl+T`      | 切换 Todo 面板              |
| `Ctrl+R`      | 搜索输入历史                 |
| `Ctrl+F`      | 搜索 Transcript          |
| `Ctrl+End`    | 全屏时跳到最新 Transcript 输出；离开 live tail 时底部显示可点击的 `↓ Latest` |
| `Ctrl+O`      | 展开 / 折叠工具和系统详情；普通与全屏非 Focus 下展开/收起超长用户 Prompt；全屏 Focus 下整体切换 Thought root（超长用户 Prompt 用点击/搜索展开） |
| `Alt+T`       | 展开 / 折叠 Thinking       |
| `Ctrl+G`      | 使用 `$VISUAL`/`$EDITOR` 编辑输入 |
| `Ctrl+V`      | 粘贴图片                   |
| `Tab`         | 补全斜杠命令与文件路径           |
| `@`           | 文件补全                   |
| `!`           | 进入 Shell 模式（结果进 Session） |
| `!!`          | 进入 Session 排除的 Shell 模式     |

完整按键和命令以 TUI 中的 `/help` 为准。表中的快捷键是默认值;用户自定义后,以 `/help` 和 `/keybindings` 显示的生效键位为准。

### 自定义快捷键

Host 快捷键是语义 action(`app.*`),通过 context-aware keymap 解析——
UI(页脚提示、`/help`、`/keybindings`)始终显示**生效**的按键,因此
改键后所有提示自动更新。配置入口是 TUI 里的 `/keybindings` 面板
(写入 `tui-app` 插件的 profile 配置的 `keybindings` 字段——DSH 0.1.7
起 TUI 偏好保存在 profile-owned Config,不再使用旧 `dsh-pi-tui`
settings 命名空间);保存后用 `/keybindings reload` 应用(显式
reload——配置变更后执行 reload 即生效,无需重启)。字段形状:

```yaml
keybindings:
  app.input.steer: ctrl+s          # 单个按键
  app.permission.cycle: [shift+tab, ctrl+shift+p]   # 多个按键
  app.history.search: ctrl+r
  app.transcript.toggleThinking: false   # 禁用该 action 的按键
  leader: ctrl+x                    # M6:leader 序列
  bindings:
    app.tasks.open: <leader>t
```

- 普通可打印键永远不能绑定到 Host action(会吞掉输入);坏配置只是
  警告,绝不会导致启动失败(fail-soft)。
- 任何用户声明都会**替换**该 action 的内置默认键:`app.input.steer:
  ctrl+x` 让 Ctrl+X steer、Ctrl+S 不再 steer;仅 leader 的
  `app.todo.toggle: <leader>t` 让 Leader T 成为唯一切换触发(Ctrl+T
  失效);`['ctrl+z', '<leader>s']` 同时保留两个用户触发;`false`
  移除该 action 的全部触发。若 effective editor-owned submit key 会在
  leader machine 之前消费某个 completion(例如 `<leader>enter`),该死序列会被
  拒绝而不会被展示。
- `DSH_PI_TUI_SAFE_KEYBINDINGS=1` 忽略所有用户覆盖(仅使用内置默认)。Safe mode
  开启时整个 `/keybindings` 编辑器只读,避免保存只会在关闭 safe mode 后才发现的
  冲突配置。
- 编辑器中未自定义 action 且仍然 effective 的默认按键可选择。`Add shortcut` 会把
  这些仍生效的默认键与新键一起写入;已被 shadow 的 definition default 仅作参考,替换
  或删除一个仍生效的默认键会保留其余 sibling。action 已有用户声明后,仍按上文规则
  替换内置按键集合。
- `/help` 仍是按键优先的只读帮助;`/keybindings` 是按 action 优先的
  可编辑 Keyboard Shortcuts Editor:按类别分组,搜索 action ID/描述/当前键和
  默认键,并标记 customized、conflict、Unbound、Disabled 和 fixed 状态。
  独立的 Leader key 行还可设置全局 leader key。
- `/settings` 的 Input & Terminal 只有一个 `Keyboard shortcuts…` 入口，打开与裸
  `/keybindings` 相同的同 lease 全屏页与同一持久化控制器（不再是 88 列 overlay）。
- 录制器读取真实终端按键,通过 `parseKey` 规范化为 `KeyId`;保存前会拒绝
  无法匹配、吞输入、终端歧义或已知冲突的按键。普通录制器按 `Esc` 立即取消;
  Host interrupt action 的 direct recorder 使用短暂双击窗口:一次 `Esc` 取消,
  两次 `Esc` press event 才录入物理 Escape。repeat/release 不算第二次,不再有单字母
  快捷方式;物理 Escape 保留给 Host 生命周期路径。
- 条件 affordance 会在编辑器中单独标注(例如空编辑器任务浏览器的
  `Down (conditional)`),不会伪装成普通已配置快捷键。
- `/keybindings conflicts` 列出冲突(同键 + 作用域重叠 + 同优先级——绝不
  静默 last-write-wins);`/keybindings reload` 重新读取设置(fail-soft:坏配置会
  被诊断并跳过,读取异常才会给出错误提示——都不会崩溃,keymap 保留
  last-known-good 配置);`/keybindings reset` 通过 settings 服务清除覆盖,并
  立即重建运行中的 keymap。
- 子代理查看器按 action id 阻止父级 action,因此改键后的父级快捷键
  在查看器内依然被阻止。
- 条件 affordance 是**累加**的:绑定 `app.tasks.open: ctrl+x` 是**增加**
  一个触发——空编辑器的 `↓` 任务浏览器仍然有效;只有 `false` 才会
  移除某 action 的全部触发。


## 从源码运行

```sh
git clone https://github.com/XMoon/dsh-pi-tui
cd dsh-pi-tui

pnpm install
pnpm build
```

使用 `file:` 安装：

```sh
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD
```

`file:` 会在安装时复制当前构建结果。修改源码后需要重新 build 并重新 add。

持续开发可以使用 `link:`：

```sh
dsh plugin --profile pi-tui-dev -- add @xmoon76/dsh-pi-tui@link:$PWD
dsh --profile pi-tui-dev
```

之后重新执行：

```sh
pnpm build
```

即可让开发 Profile 使用新的构建结果。

## DeepSeek Harness 集成

`dsh-pi-tui` 只实现终端交互层。

以下能力由 DeepSeek Harness 提供：

* Agent Loop
* LLM / Provider
* Session Persistence
* Tools
* Skills
* Approval
* Permission Presets
* Plan Mode
* Goal
* Jobs
* Subagents
* Credentials
* Settings

因此 TUI 不需要维护独立的模型配置、Session 格式或 Agent Runtime。

它可以和其他 DSH Surface 使用同一套运行时数据：

```sh
dsh --profile web
dsh --profile headless
dsh --profile pi-tui
```

## Extension API

除作为 TUI 使用外，`dsh-pi-tui` 还提供版本化的 Extension API，供其他 Cordis / DSH 插件扩展终端界面。

目前分为三个入口：

| Entry                                     | 用途           | 稳定性      |
| ----------------------------------------- | ------------ | -------- |
| `@xmoon76/dsh-pi-tui/extensions`          | 常规扩展         | Stable   |
| `@xmoon76/dsh-pi-tui/extensions/advanced` | 高级交互能力       | Advanced |
| `@xmoon76/dsh-pi-tui/extensions/unstable` | Low-level 能力 | Unstable |

可扩展的内容包括：

* Header / Footer
* Input Widget
* Slash Command
* Theme
* Setting
* Autocomplete
* Keybinding
* Message Renderer
* Tool Renderer
* Overlay
* Interactive UI
* Editor Control
* Replacement Editor

插件只需要依赖公开入口，不需要 import `TuiApp`、`TuiMainScreen` 等内部实现。

简单示例：

```ts
import {
  PI_TUI_EXTENSIONS_SERVICE,
  type PiTuiExtensionService,
} from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'my-plugin'
export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(
    PI_TUI_EXTENSIONS_SERVICE,
  ) as PiTuiExtensionService

  if (!service.api().capabilities.has('slot.chrome.header.badge')) {
    return
  }

  service.register(
    'chrome.header.badge',
    {
      id: 'my-badge',
      order: 100,
    },
    {
      text: 'my-plugin',
      tone: 'info',
    },
  )
}
```

详细文档：

* [Extension API](docs/extensions/stable.md)
* [Extension tiers](docs/extensions/tiers.md)
* [Advanced API](docs/extensions/advanced.md)
* [Unstable API](docs/extensions/unstable.md)
* [Plugin authoring](docs/extensions/authoring.md)

## 开发

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

测试包括 Pi TUI fork、自身 TUI 行为以及 Extension API 的 fixture / smoke test。

终端渲染和输入路由使用 `@xterm/headless` 做自动化验证，因此大部分 UI 测试不依赖真实 TTY 或模型连接。

性能基线：

```sh
node --expose-gc scripts/bench.mts
```

项目日常开发使用单独的 `pi-tui-dev` Profile 进行自测：

```sh
dsh plugin --profile pi-tui-dev -- add @xmoon76/dsh-pi-tui@link:$PWD
dsh --profile pi-tui-dev
```

## DSH 兼容性与验证

以下内容仅介绍 DSH 兼容性与 CI 验证细节；普通用户无需了解即可安装 TUI。

### npm 模式（当前 `next`）

当前兼容列车线是 npm 模式：以本 checkout 的 `package.json` 声明、
lockfile 解析的已发布 `dsh-v0.2.0-rc.2` family 为精确验证目标（运行时
peer floor 同为 `>=0.2.0-rc.2`）。隔离的 npm
驱动从公共 registry 安装该精确 family，并跑完整 build/test/package 路径：

```sh
pnpm compat:dsh:npm
```

### Source Mode（仅验证）

Source Mode 是面向未发布 DSH checkout 的验证专用 distribution，用于本地
兼容性检查与显式的 source 边界工作。它从 `test/compat/dsh-source.json` 的
完整 commit SHA 构建官方 DSH tarball family，通过临时 pnpm overrides 安装，
并在完成后清理临时状态。不要把 DSH 源码路径、`file:` 依赖或 workspace
symlink 写入发布 package。

安装包已经包含运行所需的 Pi TUI fork，不需要额外安装内部的 TUI package。

### CI 验证策略

CI 对 push 到 `next` 以及目标为 `next` 的 PR 遵循跟踪的 `test/compat/dsh-mode.json` 策略；`main` 和所有 tag 使用 npm Mode。Source Mode 从 `test/compat/dsh-source.json` 读取 source target 并验证完整的官方 DSH tarball family、TUI 预设和旧 runtime 边界；npm Mode 则使用 checkout 的 `package.json`/冻结 lockfile 中声明的 DSH 版本运行 registry lane。已发布 `pi2dsh` 的生态检查在两种模式下都运行，并且始终针对已发布生态（从 registry 安装已发布的 DSH 与 pi2dsh），遇到 source pack 会明确跳过而不是伪装成通过。详细流程见 [`docs/guides/dsh-compatibility.md`](docs/guides/dsh-compatibility.md)。

## 项目结构

仓库根目录是发布到 npm 的 `@xmoon76/dsh-pi-tui` bundle。

Pi TUI fork 位于：

```text
packages/pi-tui/
```

它作为内部依赖参与构建，并随根 package 一起打包，不单独要求用户安装。

具体的 upstream 来源、版本和本地差异以：

```text
packages/pi-tui/package.json
packages/pi-tui/AGENTS.md
```

为准。

贡献者相关的仓库结构和开发约定见 [AGENTS.md](AGENTS.md)。

## 文档

| 文档                                                     | 内容                           |
| ------------------------------------------------------ | ---------------------------- |
| [docs/README.md](docs/README.md)                             | 文档政策与完整索引               |
| [docs/architecture/overview.md](docs/architecture/overview.md) | 架构、分层与依赖方向           |
| [docs/architecture/host-client.md](docs/architecture/host-client.md) | Host/Client 边界与当前性契约 |
| [docs/architecture/surface-behavior.md](docs/architecture/surface-behavior.md) | 工作区/任务/插件界面行为 |
| [docs/guides/development.md](docs/guides/development.md)     | 本地开发、worktree 与性能重跑方法 |
| [docs/extensions/stable.md](docs/extensions/stable.md)       | Extension API                |
| [docs/guides/code-review.md](docs/guides/code-review.md)     | 仓库评审检查点               |
| [AGENTS.md](AGENTS.md)                                 | Contributor operating manual |

## Changelog

中文：

[CHANGELOG.md](CHANGELOG.md)

English:

[CHANGELOG.en.md](CHANGELOG.en.md)

## License

[MIT](LICENSE)
