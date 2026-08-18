# 更新日志

本项目所有值得记录的变更都会记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.6] - 2026-08-18

### 新增

- 打开时会话锁:打开会话(`--session`、`/resume`、`/sessions`)时,若另一
  个存活的 dsh 进程已持有该会话则拒绝——会话日志旁的 `owner.lock`
  文件记录持有者的 pid 与 `/proc` starttime;崩溃持有者的陈旧锁会被
  自动接管。这封堵了一条损坏路径:第二个打开者的 resume 会让持久化层
  把中断回合的合成 closers 写进共享日志,而第一个进程继续用自己内存
  中的 seq 追加(写入期 guard 看不到这个冲突——第二个打开者的内存与
  文件一致)。分歧 guard 仍然是那些不了解锁的界面的兜底。
- 纯 `exit`(精确去除首尾空白后匹配)在创建会话或 busy-Enter 门禁之前退出
  TUI;`/exit` 行为不变。
- `/login` 与 `/logout` 解析凭据目标:deepseek 官方凭据加上每条
  llm-pi-ai 路由的 `apiKeyEnv`(选择器、路由/首词匹配、环境变量名
  原样+转大写,未知目标列出可选列表)。
- 按工作目录(cwd)保存的输入历史,存储为
  `$DSH_HOME/user-history/<md5(cwd)>.jsonl`(kimi-code 模式)的 JSONL:
  只追加、连续重复跳过、100 条上限、容忍损坏行、启动预读,
  以及从旧设置键的一次性安全迁移。
- 待办面板与队列面板之间的目标(goal)行(仅展示,设置目标时渲染)。
- 编辑器内联技能自动补全(`/` 在空白后或后续行触发;Enter 应用带
  `data.inlineSkill` 标记的补全而不提交)——来自 vendored fork
  同步到 kimi-code 44a6c70e6。
- Web 对齐的工具卡片:`card:'web'` 结果视图(搜索的答案 + 来源列表、
  fetch 的 URL + HTTP 状态);对象型 rawInput 的逐工具单行形态
  (todo_write 清单、terminal 会话目标、session_event seq)取代
  格式化 JSON;计划评审卡片在待调用与已完成两条路径都渲染内容块。
- 任务浏览器面板:状态圆点、对齐列与实时跳动——↓/Ctrl+J 与 `/tasks`
  列表渲染任务状态(running/stopping/completed/failed)、每秒更新的
  已耗时、带实时计数的分组标题——web JobListAction 对齐。

### 变更

- 后台子代理的结算通知(可续接的子代理已结算、工具任务的一次性完成)
  移出队列面板——任务浏览器才是它们的归宿;失败按消息 id 只通知一次。
- 编辑器区域布局:待办摘要移入 dock 条(单行暗淡信息,无边框线);
  dock 中逐任务/逐子代理的详情行移除(仅保留页脚徽章 + ↓/Ctrl+J
  浏览器);目标槽位移出页脚;面板边框每侧缩进一格。
- Vendored fork 同步到 kimi-code 44a6c70e6;两条新上游分叉修改
  已登记在 `packages/pi-tui/AGENTS.md`。

### 修复

- 问题对话框方向键在滚动视口边缘滚动,因此把光标走进选项永远不会
  在小终端上把问题概览挤出屏幕。
- `todo_write` 的数组型 `rawInput` 渲染为清单,而非格式化 JSON 转储。
- 会话修复剥离 `zstdCompressSync` 可能产生的尾部空 zstd 帧,
  修复后的日志对所有读取者保持有效。
- 评审轮次的会话锁加固:接管路径上的租约泄漏、swap 失败修复缺口
  (重取检查、顺序)与探针修复——swap 修复逻辑被提取为纯的、
  无头测试的函数。

### 移除

- 失效的 `@deepseek-ai/dsh-session-query` peer 依赖(选择器以结构化
  类型引用它,并从实时上下文中读取服务)。
- `packages/pi-tui` 中脚手架时期的 `vitest.config.ts`
  (不包含任何测试,node --test 才是测试套件)。

## [0.1.5] - 2026-08-17

### 新增

- 表面目录协调器,支持恢复会话预取;延迟启动时的 standing-scope
  冷技能读取;无会话的 preset/重载刷新。
- 统一的问题页滚动视口(问题 + 详情 + 每个选项及其描述 + 自由文本行),
  支持展开(`e` / 全屏点击)与切换标签页时的滚动位置保持;`e` 在小屏
  上展开被截断的选项描述。

### 变更

- 问题面板滚动视口、展开与全屏点击;提示行适配循环保留 `esc cancel`。
- 评审加固:单点技能适配器、不完整观测守卫(保留 last-good)、
  preset 身份精确性、settle 顺序。

## [0.1.4] - 2026-08-16

### 新增

- Busy-Enter 设置——代理运行时 Enter 改为 steer(与网页端 `busyEnter`
  对齐);Ctrl+Enter 始终强制队列模式;技能命令同样 steer,
  只有 LOCAL 命令直接执行。
- `!` shell 把命令 + 输出提交进会话;`!!` 保持本地执行。
- 子代理查看器以只读查看条覆盖编辑器。
- 任务浏览器把可续接子代理与任务注册表合并;以仅含子任务的会话打开。
- `/rename` 作为 `/title` 的别名——无参数时重新生成并覆盖会话标题。

### 变更

- 问题对话框位于编辑器 seat(kimi 的 `mountEditorReplacement` 模式)
  而非居中浮层;宽问题对话框与 N-more 截断标记。
- 会话记录(markdown)在终端尺寸变化时重新换行;bash 命令与审批提示
  保持可见。
- 文档重组为带索引的文档集(AGENTS.md + `docs/`)。

### 修复

- `/preset` — 无会话名单、英文文案、一次 Enter 选择。
- 全屏模式下的主题自动检测 + 过期/迟到结果竞态;CI 在自动检测测试中
  清除 `NO_COLOR`/`FORCE_COLOR`/`CI`。

## [0.1.3] - 2026-08-16

### 新增

- 后台任务拥有独立表面:队列通知标记、页脚徽章、任务浏览器、输出查看器。
- 主题检测链(OSC11 → COLORFGBG → dark)与 diff 令牌。
- `@` 文件提及,带 `fd` 检测与有界的递归回退。
- `/quit` 作为 `/exit` 的原生别名;斜杠退出走统一的退出契约。
- 可重复的打包门禁:prepack 构建+校验、postpack tarball 冒烟、
  CI 任务(完整矩阵通过后才发布)。
- 退出 flush 契约与可测试的 detached-task 原语。

### 变更

- 多行工具卡片,带命令/diff 预览;问题对话框换行而非截断。
- 工作指示器通过回调重绘;实时调色板切换重着色每个表面。
- tmux 测试指南与可复用脚本。
- 性能:与历史无关的窗口投影;跨轮读取分组保持快速窗口一致;
  消息组件缓存限制并裁剪到实时会话记录;带已保存基线的基准工具。

### 修复

- CI 发布路径(标签上不依赖 cwd);npm/pnpm 从 tgz 文件名剥离 `@`
  作用域后的 tarball 发现。
- 评审循环收敛:带全量异步边界的自有生命周期、草稿合并、逐流解码器、
  诚实的强制提示、截断。
- 问题流 FIFO 串行化;Esc 后模型菜单的迟到 resolve/reject 永不生效。
- 旧会话的异步工作与状态永不泄漏进新会话。
- 会话修复:撕裂的 zstd 尾部安全、显式布局扫描、fsync 备份、
  拒绝歧义引用;段引用解析到实际同帧出现位置。
- 本地 shell 输出有界,带截断标记与 0600 全量输出文件;健壮的外部编辑器。

## [0.1.2] - 2026-08-15

### 新增

- 队列输入面板与 `/queue` 管理;Ctrl+S 整体 steer 队列;
  通过 `inbox.splice` 插到指定位置。
- 出队快捷键从 Ctrl+Q 改绑为 Alt+Up。
- `ask_user_question` 重做为可导航、带复核的流程。
- 会话创建推迟到第一条用户消息。
- 工作流运行卡片长出成员树;编辑器上方 dock 条。
- `/yolo` 作为 `/permission danger-full-access` 的别名;权限模式徽章
  与 Shift+Tab 循环。
- edit/write 工具卡片的真实 LCS diff 渲染。
- 交互退出时打印恢复提示(pi 对齐)。
- 无会话斜杠命令;跨进程守卫 + 诊断。
- Vendored fork 同步到上游 v0.84.3;浮层叠放逻辑移到 dsh。

### 修复

- 通知在重绘后存活,默认 info;错误通知显式选择加入;权限徽章位于页脚。
- 浮层边框与叠放浮层合成。
- 斜杠命令自动补全不再滞后一次按键。
- 工具注册表作用域传入 agent 对象。
- tok/s 与令牌统计对齐 Web 的采样语义。
- 队列面板 splice 竞态;修复后的日志以 dsh 帧布局写出。

## [0.1.1] - 2026-08-15

### 修复

- `@deepseek-ai/*` 声明为 peerDependencies 而非 dependencies——
  profile 中不再出现重复副本(首个工具调用报
  `Cannot read properties of undefined (reading prepare)`)。

## [0.1.0] - 2026-08-15

### 新增

- 首个公开版本:`@xmoon76/dsh-pi-tui`,面向 DeepSeek Harness profile
  (`dsh --profile pi-tui`)的 TUI 界面,构建于 vendored pi-tui fork
  之上,打包为单一自包含包。
- 会话记录引擎:窗口化、增量折叠、配对、事件折叠;web 对齐的工具卡片、
  实时最新行思考、鲸鱼工作指示器。
- 审批对话框与权限模式(`/permission`、危险标志、预览);斜杠命令齐全:
  `/status`、`/sessions`、`/preset`、`/model`、`/plan`、`/search`、
  `/export`、`/subagents`、`/reload`、`/resume`、`/skill-<name>`,
  以及会话切换器。
- 固定编辑器的全屏布局;Ctrl+F 会话记录搜索;Ctrl+D 像 `/exit` 一样
  退出;全屏鼠标支持(pi 对齐)。
- 主题系统:自定义调色板文件、终端背景检测、语义令牌、折叠,
  以及按生产者标注的上下文注入卡片。
- 单包发布模型:构建时把 fork 打进发布包;tarball 自包含。

[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/XMoon/dsh-pi-tui/releases/tag/v0.1.0
