# 更新日志

本项目所有值得记录的变更都会记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.0-alpha.2] - 2026-09-03

### 安装与版本对应

当前预发布页面建议按以下顺序安装，先安装匹配的 DSH，再将 TUI bundle
加入 profile：

```sh
npm install -g @deepseek-ai/dsh@0.1.2-alpha.5
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@next
dsh --profile pi-tui
```

需要保留 DSH `0.1.1-rc.2` 的用户应改用 `@xmoon76/dsh-pi-tui@0.3`；DSH
`0.1.2-alpha.2`/`alpha.3` 用户应固定 `@xmoon76/dsh-pi-tui@0.4.0-alpha.1`。
完整版本矩阵和更新/卸载命令见 README 的「安装」。

### 新增

- **任务中心（Task Center）。** `/tasks` 重构为三层任务表面：footer 徽标 →
  Quick Tasks（footer 下方向键，Active 范围）→ 完整任务中心（`/tasks`，
  All 范围）。支持显式搜索模式（可打印键只作为查询文本，绝不触发破坏性
  操作，Esc 先退出搜索再关闭面板）；`Stop`（`S` → `Y` 确认）取代原来的裸
  `i` 中断，并在派发时重新校验会话栅栏与 agent 注册表；footer 徽标分别
  显示运行/总数与未确认的失败提醒，打开任一表面只确认实际可见的失败行。
- **终端完成通知。** 主 agent 在终端失焦时完成回合，会通过系统通知提醒
  （OSC 9 / OSC 777 / 铃声，按终端环境自动选择）。只在真正 settle 时触发，
  不会在重试、压缩、队列续跑或子代理结束时打扰。`/settings` 新增
  `Completion notification` 模式（Unfocused / Always / Off）与方式
  （Auto / OSC 9 / OSC 777 / Bell）两行。
- **`/settings` 新增 Subagent model selection。** 开关与 "Subagent allowed
  models" 路由选择器直接读写官方 `subagent-model-selection` 设置（默认
  关闭；开启需要至少一条路由；在新会话组合时生效，不改写运行中的会话）。
- **工具卡 action payload 成为一等公民。** 紧凑工具卡直接展示 action 载荷，
  展开保留空行，窄宽度与零宽行有明确处理。

### 改进

- **`/sessions` 与 `/resume` 更快、可取消。** picker 输入优先打开（加载中
  Enter 绝不触发 resume）；每个会话只有一次合并投影读取（live 行读内存
  快照、冷行读持久化缓存、真正的 cache miss 才做有界 observe）；渐进富化
  可取消，关闭/退出/重开都会中止扫描；`/resume <参数>` 共享同一生命周期。
- **粘贴处理更可靠。** 大粘贴后 `Ctrl+G` 外部编辑器不再丢内容（`$EDITOR`
  看到展开后的完整文本）；出站草稿（steer / submit / queue / 子代理提交）
  统一展开 paste marker，不再把字面 marker 泄漏到 wire。
- **编辑器提交键独立。** 新增 `tui.editor.submit` 绑定（仅编辑器消费），
  question/搜索框不再被 `submit: ctrl+x` 类配置误提交。

### 修复

- **终端 resize 后各表面保持状态。** 队列窗格 / Todo 面板 / 历史搜索
  overlay / 审批弹窗在缩放与全屏切换后重建内容而不丢失组件状态、焦点与
  叠层语义。
- **diff 视图不再显示无法证明的行号。** DSH 的 FileDiff 契约不带 hunk
  锚点时隐藏行号 gutter，绝不猜测绝对行号。
- **Focus 展开视图的 initial user prompt 保持在 Thought 之前。** 系统行
  注入不再把首条用户消息挤到 Thought 下方。
- **Todo 面板关闭后内置 summary 恢复。** 扩展宿主存在时，关闭面板不再让
  dock 的 todo 摘要永久为空。
- **稳定性加固。** 进程槽持有至最终 dispose、编辑器挂载/组件 dispose
  硬化，减少退出与 HMR 场景下的竞态。

### 兼容性

- **最低 DSH 版本提升到 `>=0.1.2-alpha.4`**（原为 `>=0.1.2-alpha.2`）。
  低于 alpha.4 的运行时收到启动提示：alpha.2/alpha.3 回退到
  `@xmoon76/dsh-pi-tui@0.4.0-alpha.1`，更旧的运行时回退到 0.3。
- 开发/测试依赖与 Source Mode pin 同步到 `dsh-v0.1.2-alpha.5`；发布包
  peer 下限保持 `>=0.1.2-alpha.4`。

> **已知限制：** 当前生产默认后端仍为 Direct；remote attach 暂不支持。

## [0.4.0-alpha.1] - 2026-09-01

### 安装与版本对应

```sh
npm install -g @deepseek-ai/dsh@0.1.2-alpha.3
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@next
dsh --profile pi-tui
```

需要保留 DSH `0.1.1-rc.2` 的用户应改用 `@xmoon76/dsh-pi-tui@0.3`。

### 新增

- **Footer 自定义命令项。** `/footer` 的 Add picker 新增
  `+ Create Custom Command`，可创建带刷新间隔、超时与语义色的自定义命令
  条目；命令只从 USER 层 trusted 来源激活（项目配置永远不能提供或激活
  命令），渲染路径永不 spawn。
- **`/model` 选择按 live Agent 持久化。** 每个 live Agent 拥有自己的模型
  选择引用，footer 与 `/model` 跟随当前 Agent；全局默认与 Session 本地
  选择分离，latest-wins 栅栏防止迟到操作覆盖新意图。
- **Focus 展开视图恢复 steer 时间线。** 展开的 Thought 中 initial user
  保持在 Thought 前，后续 steer/user 回到实际发生位置；折叠 Message 成为
  第三个 process slot（Think → Tool → Message），显示最新最多 3 行。
- **全屏鼠标滚轮步长可配置。** `/settings` 新增 `Mouse wheel lines`
  （1/2/3/5/8，默认 1）。
- **Todo 面板交互优化。** ≤5 条时两态（summary ↔ list）；快速连点合并为
  一次手势，不再"一闪就消失"。
- **长会话搜索改为稳定的索引化投影。** 全屏搜索基于稳定条目身份与单一
  语料源，查询只遍历脏条目（O(#dirty)），跳转按稳定 turn 锚定。
- **状态行与 `/status` 上下文读数统一去重。** 普通刷新读缓存，`/status`
  强制一次测量进缓存，面板与 footer 读数不再分叉。

### 修复

- 显式 cold resume 在 TUI mount 前显示启动进度（`Resuming session…` /
  `Preparing conversation…`），不再让空白终端看起来像卡死。
- 搜索 overlay 的 Next/Prev 不再跳过新出现的匹配。
- 实时尾部追加刷新整个读组，搜索跳转不锚定旧窗口。
- 立即退出的 footer 命令子进程不再崩溃 TUI（EPIPE 吞掉）。

### 迁移说明

- **0.4.0-alpha.1 切换到 DeepSeek Harness 0.1.2。** 声明支持范围
  `>=0.1.2-alpha.2`；保留 DSH 0.1.1 的用户固定安装
  `@xmoon76/dsh-pi-tui@0.3`。
- Agent preset 身份按 roster 解析；旧数据中省略的 `code` 默认值在 roster
  不含 `code` 时回退到 `ptc`。
- 上游 alpha 注意事项：DSH 0.1.2-alpha.1 的 subagent dispose 行为仍有
  上游 caveat。

## [0.3.6] - 2026-08-31

### 新增

- `@` 提及与 `/image` 参数共用统一的文件补全引擎（路径解析、排序、引号、
  目录续补）。
- 长会话支持有界的转录窗口（重叠翻页、`Ctrl+End` 回最新、窗口锚点保留）。
- 提交即时反馈与可观测延迟时间线（`Submitting…` / `Queued…`）。

### 变更

- `/footer` 保存流程可发现且事务化（Save changes / Unsaved 状态、Esc
  确认）。
- 会话写入安全模型改为 fail-closed（owner lock + 单写者边界）。

### 修复

- 异步补全结果始终重绘当前活动屏幕。
- Footer 在窄终端/全屏切换/command surface 下遵守真实可用预算。
- 转录窗口切换、搜索与实时跟随不再丢失 viewport 锚点。

> **已知限制：** 当前生产默认后端仍为 Direct；M2–M8 尚未完成，暂不支持
> remote attach。

## [0.3.5] - 2026-08-28

### 新增

- **`/footer` 配置器重构为层级式 status-line 编辑器。** Row Selector →
  Edit Row → Item Editor 三级；`A` 打开可搜索 Add Picker；Preview 与帮助
  成为固定 shell；保存键改为 `S`。
- **Footer 支持用户自定义静态文本条目。** `+ Create Custom Text`，只从
  USER 设置层读取。
- **内置 Footer 条目提供有意义的有限 Style。** Model / Permission /
  Working directory / Context / Token usage / Performance / Turns 等条目
  新增可区分变体。
- **插件主题选择身份改为 SOURCE-QUALIFIED（`plugin:<owner>/<id>`）。**
  插件与文件主题不再共享裸名字空间；插件卸载后确定性回退到内置 dark。
- **`Icon style` 设置。** Emoji / Symbols / Minimal 三种结构图标风格，
  切换即时生效。
- **快捷键可用户编排。** 语义 action + context-aware keymap；
  `/keybindings` 显示生效表、`conflicts` 列冲突、`reload` 重读、`reset`
  清除；`<leader>X` 多键绑定；`DSH_PI_TUI_SAFE_KEYBINDINGS=1` 忽略所有
  覆盖。
- **`/help` 与 `/settings` 按键文案语义化。** 不再写会因改键而过时的物理
  键文案。
- **受信任的命令状态行（Claude/Kimi 风格）。** `footer: command` 把状态
  表面交给用户配置的命令（JSON 快照进 stdin、stdout 渲染、周期刷新、失败
  回退原生布局）；只有 USER 层的 `footerCommand` 会被执行。

### 变更

- Footer 成为可组合、可用户配置的表面（`custom` 预设 + 版本化
  `footerLayout`）。
- 插件可贡献可配置的 Footer 条目（`chrome.footer.item` 槽位）。
- 问题流与任务浏览器改经语义组件 action 路由按键。

### 修复

- 空输入不再制造消息或副作用（Enter / Ctrl+Enter / Ctrl+S 静默 no-op）。
- 编辑器 ↑/↓ 历史按当前会话投影。
- 终端窗口标题改为人类可读（`dsh · <title>`，清洗 ANSI/OSC）。
- compaction/prune 后的幽灵 Tool Card 不再出现。

## [0.3.4] - 2026-08-25

### 新增

- **Ctrl+R 搜索输入历史。** 模态面板实时过滤，`Tab` 循环 Current session /
  Current directory / All directories；有界最近优先扫描（全局 5000 行
  预算）；分页 continuation；`Enter` 放回编辑器继续编辑。
- **`/tasks` 树形展示完整 subagent 世系。** 深度缩进 + `├─` 连接符，稳定
  pre-order；嵌套后代只读。
- **选中行超长标签横向滚动（marquee）。**

### 变更

- **Thinking 块是 disclosure 不再是 visibility。** `Alt+T` 是唯一 bulk
  拥有者；`Ctrl+O` 只拥有 tool/system/compaction detail。
- **`!` / `!!` shell 行升级为一等公民编辑器模式。** 提示符变为 `!`/`!!`，
  粘贴 `!git status` 落成模式+命令。
- **本地 shell 卡片改为预览。** 运行中折叠为最新 5 行，已结束最多 20 行；
  `Alt+K` 快速清除已结束卡片。

### 修复

- 启动期 TDZ 修复（footer command 生命周期槽声明过晚）。
- Linux Wayland/X11 下 Ctrl+V 图片粘贴恢复（强制 buffer 编码）。
- Task 弹层不再在边框旁出现黑色遮罩。

## [0.3.3] - 2026-08-24

### 新增

- **continuable 子代理查看器可交互。** 实时对话界面、子代理自己的草稿、
  FIFO 投递、失败合并回草稿；one-shot 保持只读。
- **任务浏览器显示子代理 mode。** `continuable` / `one-shot` 标注。
- **Focus Mode。** 运行中 turn 的中间过程折叠进 live Thought 区块，点击
  展开持续接收流式内容。
- **`/settings` 新增 `Home/End keys`。** Input / Viewport 两种习惯。
- **`@` 文件提及以绝对路径发给模型。**
- **任务浏览器按行类型过滤。** Tab 循环 All → subagent → bash → pwsh。
- **Pi 风格 rewind：`Esc Esc`（或 `/rewind`）。** 从更早的用户回合 fork
  对话；原会话从不修改。
- **`/fork` 与 `/rewind` 共用同一条 fork 链路。**

### 变更

- Esc 不再清空队列（keepInbox 语义）。
- `/sessions` 按目录限定范围（Current directory / All directories）。
- 问题 Review 页回归纯审阅（Enter 提交、Esc 取消、`←` 返回）。

### 修复

- 会话切换改为单写事务：切换等待当前活动结束、失败不留半成品分支、同一
  会话不会被两个进程同时写入。
- Double-Esc rewind 和弦真正连续。
- fullscreen 拖选与 `/copy` 不再假报复制成功（tmux / 平台工具 / OSC 52
  兜底）。
- `Press Ctrl+C again to exit` 提示只存在于 footer 且与退出窗口同生命周期。
- 已结束的后台任务卡片保留命令行。
- `@dir` 补全不再依赖尾部斜杠。

## [0.3.2] - 2026-08-22

### 新增

- **用户输入渲染为品牌蓝气泡**，输入框同款 `❯` 提示符（可覆盖调色板
  token）。
- **`/image <path>` 路径补全。**
- **图文混合消息保留内联 `🖼️` 占位符。**
- **全屏点击附件折叠/展开图片**（常驻身份行）。

### 修复

- 注入上下文行展开不再泄漏原始 XML 信封。
- 图片摘要标记 `🖼️`（U+FE0F）不再与文件名重叠。
- write / skill / read_image 卡片折叠时不再泄漏原始 XML 信封。

## [0.3.1] - 2026-08-21

### 变更

- 不支持的宿主版本有明确的启动提示（版本、最低要求、升级命令）。
- `/login` 文案区分 API-key 与 provider 两个凭据平面。

## [0.3.0] - 2026-08-21

### 新增

- **provider-native 登录。** `/login` 识别两个凭据平面：API-key 流程与
  OAuth / device-code 原生登录；secret 提示默认掩码。
- **`/logout` 覆盖两个凭据平面。**

### 变更

- **最低兼容 DSH 提升到 `dsh-v0.1.1-rc.1`**（不再支持 0.1.0-rc.8）。
- header 版本徽标先显示 dsh 版本再显示 `tui-` 版本。

### 安全

- authorization secret 永不写入日志、历史、转录或 `/status`。

## [0.2.2] - 2026-08-21

### 新增

- **合并任务浏览器成为唯一后台表面。** `/tasks` 可搜索列表覆盖 job 与
  子代理；`/subagents` 成为别名。
- **TUI 命令别名注册。** `/quit`、`/resume`、`/rename`、`/subagents`。
- **子代理家族工具卡显示模型。**
- **`!` / `!!` 行像真实 shell 一样补全。** 命令名、`$VAR`、git 子命令。
- **本地 shell 沙箱偏好。** 用户手动命令默认 bypass 沙箱。
- **问题卡展示答案、Goal 卡可读。** 折叠预览不再泄露 JSON。
- **全屏 todo dock 点击。**

### 变更

- 队列窗格通知分类（用户行 `❯` / 通知行 `⏳`）。
- Ctrl+J 不再是 host 键位。
- `!` / `!!` 在会话工作区执行。

### 移除

- **`/queue` 命令彻底移除。** 队列窗格是唯一队列面。

### 修复

- Alt+↑ 出队只拉回用户自己的消息。
- 双击 Ctrl+C 退出和弦可见且更宽容（1.5s 窗口 + 提示）。
- 折叠卡不再泄露裸 JSON。

## [0.2.1] - 2026-08-21

### 变更

- 仓库根目录即发布包（对 npm 消费者无行为变化）。

## [0.2.0] - 2026-08-21

### 新增

- **扩展平台 v1。** 第三方 Cordis 插件可贡献 chrome、widget、斜杠命令、
  主题、设置行、补全、按键绑定、渲染器、overlay，甚至替换编辑器；插件只
  导入 `@xmoon76/dsh-pi-tui/extensions`，完全生命周期化。
- **分层扩展面。** stable `extensions` + `advanced`（实验性）+
  `unstable`（不保证兼容）三层。
- **`/login` 可新增未配置过的供应商。** 引导向导 + 端点模型探测。
- **真实插件验证。** vim 模态编辑器、questionnaire 表单、交互式 shell
  示例。
- **`@dir/` 补全 Tab 接受后自动展开。**
- **`/sessions` 与 `/resume` 分类会话列表。** Main / All / Subagents。
- **会话标题加载更快。** 分批渐进 + 本地缓存。
- **上下文压缩的进度与结果。** 通知 + 可展开压缩卡片。
- **`/model` 选择 effort 后自动关闭。**
- **footer 窄终端自动换行。**

### 变更

- TUI surface 显式生命周期（generation / dispose）。
- Ctrl+C 与 Esc 改为 pi 的编辑器语义。

### 安全

- 插件文本不再能注入终端控制序列。

### 修复

- 宿主永不会被插件遮蔽或拖垮。
- 编辑器替换安全（原子交接、陈旧句柄惰性化）。
- 窄终端保持完好。

## [0.1.8] - 2026-08-18

### 变更

- 问题卡片 back/skip 改为方向键（`→` / `←` / `↑↓`）。

### 修复

- Kitty 键盘协议终端（zellij、WezTerm、Windows Terminal、kitty）上
  方向键/Esc/Tab 恢复正常。
- Skill 斜杠命令不再吞掉用户参数。

## [0.1.7] - 2026-08-18

### 修复

- 用户加载的 skill 现在真正执行（空闲 agent 也会开启新回合）。
- subagent transcript 查看器不再冻结主 transcript。

## [0.1.6] - 2026-08-18

### 新增

- 打开时会话锁（拒绝第二个进程同时打开同一会话，崩溃锁自动接管）。
- 纯 `exit` 退出。
- `/login` 与 `/logout` 解析凭据目标。
- 按 cwd 保存的输入历史（JSONL）。
- 编辑器内联 skill 自动补全。
- Web 对齐的工具卡片（web 结果、todo 清单、计划评审）。
- 任务浏览器面板（状态圆点、实时跳动）。

### 变更

- 后台子代理结算通知移出队列面板。
- 编辑器区域布局（todo 摘要移入 dock 条）。

### 修复

- 问题对话框方向键在滚动视口边缘滚动。
- 会话修复剥离尾部空 zstd 帧。

### 移除

- 失效的 `@deepseek-ai/dsh-session-query` peer 依赖。

## [0.1.5] - 2026-08-17

### 新增

- 表面目录协调器（恢复会话预取、冷 skill 读取）。
- 统一的问题页滚动视口（展开、滚动位置保持）。

## [0.1.4] - 2026-08-16

### 新增

- Busy-Enter 设置（运行时 Enter 改为 steer）。
- `!` shell 提交命令+输出进会话；`!!` 本地执行。
- 子代理只读查看器。
- 任务浏览器合并可续接子代理与任务注册表。
- `/rename` 作为 `/title` 别名。

### 变更

- 问题对话框位于编辑器 seat。
- 会话记录 markdown 在 resize 时重新换行。

## [0.1.3] - 2026-08-16

### 新增

- 后台任务独立表面（队列通知、footer 徽章、任务浏览器、输出查看器）。
- 主题检测链与 diff 令牌。
- `@` 文件提及。
- `/quit` 作为 `/exit` 别名。

### 变更

- 多行工具卡片（命令/diff 预览）。
- 性能：窗口投影、跨轮读取分组、消息组件缓存。

### 修复

- 问题流 FIFO 串行化。
- 会话修复（撕裂 zstd 尾部安全、fsync 备份）。
- 本地 shell 输出有界。

## [0.1.2] - 2026-08-15

### 新增

- 队列输入面板与 `/queue` 管理；Ctrl+S 整体 steer。
- `ask_user_question` 可导航复核流程。
- 会话创建推迟到第一条用户消息。
- `/yolo` 别名；权限模式徽章。
- edit/write 工具卡片 LCS diff 渲染。

### 修复

- 通知在重绘后存活。
- 斜杠命令自动补全不再滞后。

## [0.1.1] - 2026-08-15

### 修复

- `@deepseek-ai/*` 声明为 peerDependencies（profile 中不再出现重复副本）。

## [0.1.0] - 2026-08-15

### 新增

- 首个公开版本：`@xmoon76/dsh-pi-tui`，面向 DeepSeek Harness profile
  （`dsh --profile pi-tui`）的 TUI 界面，构建于 vendored pi-tui fork
  之上，打包为单一自包含包。
- 会话记录引擎（窗口化、增量折叠、web 对齐工具卡片）。
- 审批对话框与权限模式；斜杠命令齐全。
- 全屏布局、Ctrl+F 搜索、主题系统。
- 单包发布模型。

[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.0-alpha.2...HEAD
[0.4.0-alpha.2]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.0-alpha.1...next-v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.6...next-v0.4.0-alpha.1
[0.3.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/XMoon/dsh-pi-tui/releases/tag/v0.1.0
