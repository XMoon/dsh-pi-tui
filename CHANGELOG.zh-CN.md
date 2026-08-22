# 更新日志

本项目所有值得记录的变更都会记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **用户输入渲染为品牌蓝气泡,输入框附带同款 `❯` 提示符。** transcript
  中用户自己的输入现在整行铺角色气泡背景(dsh-web
  `--dsw-specific-bubble` 同源:dark `#2C2C2F` / light `#E4EDFD`),并以
  DeepSeek 品牌蓝 `❯`(#679EFE dark / #4177E6 light)引导,取代 kimi 的
  琥珀色——真实用户输入呈现为浮起的色块,不再与工具卡片、上下文注入或
  思考行混淆。队列窗格与编辑器 prompt 使用同一品牌蓝 `❯`:用户自己的
  输入在界面各处都是同一个标记。气泡背景是可选的调色板 token
  (`roleUserBg`),自定义主题可覆盖。
- **`/image <path>` 支持路径补全。** 在 `/image` 后输入参数时会随击键
  提示会话工作区内的文件与目录,Tab 可完成(包括空参数——此前 Tab
  毫无反应),Tab 接受目录后立即列出其子项——与 `@` mention、`!` shell
  行已有的目录补全体验一致。支持 `~`、绝对与相对路径形式;补全挂载在
  fork 自带的 `getArgumentCompletions` 扩展点上,vendored 代码零改动。
- **图文混合消息的文本保留内联 `🖼️` 占位符——transcript 气泡内同样
  可见。** 形如 `check [image] done` 的用户消息现在在气泡内读作
  `check 🖼️ shot.png done`(缩略图作为附件行跟在下方),不再只有纯文字、
  图片被静默挪到单独一行:transcript 搜索可按图片名命中,不具备图片
  渲染能力的宿主也能看到图片原本所在的位置。标记边界始终带一个分隔
  空格,占位符前没有空格的草稿也不会让标记粘在文字上。
- **全屏模式:点击附件可将图片折叠回信息栏,再点展开。** 支持内联
  图片的终端上,每个缩略图现在都以一条**常驻**身份行开头
  (`🖼️ shot.png · 1490×1284 · 392.2 KiB`)——任何时候都知道是哪张
  图——图片本体渲染在身份行下方。点击附件(身份行或图片区域)只折叠
  该图片的行数,再点一次展开;多个附件互不影响,折叠状态与会话绑定
  (切换会话自动恢复展开);折叠 kitty 图片时通过 fork 既有的差分渲染
  机制自动擦除图块——vendored 代码零改动。常规(非全屏)模式按设计
  保持鼠标无关。

### 修复

- **注入上下文行展开时不再泄漏原始 XML 信封。** 加载 skill(TUI 回退或
  host 的 dsh-tool-skill 监听器)会把模型面 `<skill_content>` 正文作为
  上下文行注入,skill 目录与工作区指令也各自携带 `<system-reminder>`
  框架;此前展开这类行(Ctrl+O)会把原始信封直接倾倒进 transcript。
  现在展开后的上下文行渲染结构化内容——skill 指令正文、剥离包装与
  `<available_skills>` 标记行后的目录/工作区文本——模型面字节保持
  不变,畸形 skill 信封不渲染任何正文。折叠的 skill 行新增
  `— N lines of instructions` 后缀(与工具卡片一致),折叠状态下也能
  看出模型收到了什么。
- **图片摘要标记改为 `🖼️`(带 U+FE0F),emoji 字体下不再与文件名重叠。**
  标记在宽度计算中只占 1 格,而带 emoji 字形的字体实际渲染 2 格——
  字形右缘悬垂吃掉了空格并压住文件名(视字体而定)。变体选择符强制
  2 格渲染,与宽度计算一致;emoji 后的空格保留,transcript 缩略图
  降级行、队列预览与 markdown 导出三处统一。
- **write 卡片折叠时只显示动词,不再泄漏原始 XML 信封。** write 工具的
  result 是 XML 确认信封(`<path>…</path> <type>…</type> <content>Updated
  file</content>`);折叠行现在像 read 卡片显示行数摘要那样显示
  `— Created` / `— Updated`,无 presenter 的降级展开也渲染动词+路径行
  ——原始信封不再泄漏进 transcript。
- **skill 与 read_image 卡片同样折叠信封内容。** skill 工具的
  `<skill_content>` 指令块与 read_image 的
  `<path>/<type>image/<content>` 信封不再出现在 transcript 中:折叠行
  显示 `— N lines of instructions` 与图片摘要,展开卡片渲染指令正文
  (含解码后的 skill 名)与图片摘要+路径,image 载荷块渲染为 `[image]`
  而非倾倒 base64。防御性登记表(`XML_ENVELOPE_RESULT_TOOLS`)确保未来
  新增的信封工具不会把原始 XML 标签泄漏进折叠预览;成功调用但信封
  畸形时渲染为空,而非原始文本。

## [0.3.1] - 2026-08-21

### Changed

- **不支持的宿主版本现在有明确的启动提示。** 在早于 `dsh-v0.1.1-rc.1` 的
  DeepSeek Harness 上运行时,会先打印可操作的提示(检测到的版本、最低
  版本与升级命令),再出现 loader 自身的失败——而不再是一段原始的
  `ERR_MODULE_NOT_FOUND` 堆栈(旧宿主无法解析 profile 挂载的
  authorization 行)。提示按声明式兼容表(`HARNESS_COMPAT`)生成,后续
  版本约束只需在表中增加条目。
- **`/login` 的文案区分两个凭据平面。** 选择器分组为 API-key 目标加
  `API key ·` 类别前缀(provider 登录目标保留自己的分组),命令描述同时
  点明两种动词("Sign in with a provider or set an API key"),密钥输入
  问题改为 "Enter",成功/退出文案点名所在平面("API key X set" /
  "API key X cleared")。

## [0.3.0] - 2026-08-21

### Changed

- **Minimum compatible DeepSeek Harness is now `dsh-v0.1.1-rc.1` or later on
  the same compat line** — this release no longer supports `dsh-v0.1.0-rc.8`
  (the split credential events, the dual credential planes and the
  `ctx.authorization` seam it consumes do not exist there).

### 新增

- **兼容 dsh authorization 的 provider-native 登录。** `/login` 现在识别
  DeepSeek Harness `dsh-v0.1.1-rc.1` 的两个凭据平面:profile 显式声明
  `apiKeyEnv` 的路由保持原有 API-key 流程(即使同名 provider 存在
  authorization flow),而 keyless 路由则走 provider 原生登录——OAuth /
  device-code / 交互式 API key。notice(要打开的 URL、设备码)显示在常驻
  面板中,text/select 提示复用现有 question 与 picker 表面,且 **secret
  提示默认掩码显示**(真实值只留在输入内存,确认页同样掩码,绝不进入
  历史、日志、转录或 `/status`)。对尚未配置的 catalog 路由,登录成功后
  写入最小 keyless profile(绝不写 `apiKeyEnv`,运行时继续读取凭据
  record);手工声明的路由仍走 add-provider 向导。
- **`/logout` 覆盖两个凭据平面。** 命名 key 的路由照旧 unset 引用;
  keyless 路由删除已存凭据 record,并提示"signed out locally"——绝不明示
  服务端 OAuth 撤销。无参数的 `/logout` 现在打开一个选择器,聚合已存
  record 与已配置引用(只显示存在性与 key;secret 值绝不离开凭据服务)。

### 变更

- **兼容 DeepSeek Harness `dsh-v0.1.1-rc.1`。** 所有 `@deepseek-ai/dsh-*`
  peer 与 dev 依赖从 `^0.1.0-rc.8` 提升到 `^0.1.1-rc.1`,并新增
  `@deepseek-ai/dsh-authorization` peer。旧事件 `credentials/updated`
  已不存在——现在监听 `credentials/reference-updated` 与
  `credentials/record-updated`(两者都会刷新 footer 模型行与欢迎卡片)。
- **TUI profile 自行挂载 authorization 服务。** 没有任何 dsh bundle
  层提供 `ctx.authorization`,因此 `cordis.patch.yml` 插入该行,runner
  显式注入——llm-pi-ai 的 provider 登录 flow 随之注册。
- `/login` 的 API-key 输入框与 authorization secret 提示默认掩码显示。
- **header 版本徽标先显示 dsh 版本,再显示 `tui-` 前缀的插件版本**——
  `[dsh-0.1.1-rc.1 · tui-v0.3.0]`;当无法解析已安装 dsh 启动器版本时
  降级为仅显示 `[tui-vX.Y.Z]`。

### 安全

- authorization 的 secret 永不写入日志、输入历史、会话转录或 `/status`;
  掩码错误与提示载荷不回显 secret。

## [0.2.2] - 2026-08-21

### 新增

- **合并任务浏览器成为唯一的后台表面。** `/tasks` 现在打开一个可搜索的
  列表,同时覆盖 job 与子代理(直接输入即可按类型/标签/状态过滤——
  `subagent`、`bash`、`failed`…);`Enter` 打开详情(子代理为子转录,
  job 为状态查看器),`i` 中断选中的子代理。`/subagents` 成为 `/tasks`
  的别名,旧的逐行子菜单面板(及其 ghost-overlay 陷阱)已删除。空编辑器
  的 ↓ 触发同一个浏览器。
- **TUI 命令的别名注册(kimi 同款)。** `/quit`、`/resume`、`/rename` 与
  `/subagents` 分别是 `/exit`、`/sessions`、`/title` 与 `/tasks` 的
  别名——注册进 host 命令服务,因此执行、补全目录(输入 `resume` 会
  补全 `/resume`)与 busy-Enter 门控都能识别,而命令面只列出一个逻辑
  命令。
- **子代理家族工具卡显示模型。** `subagent`/`subagent_route`/
  `subagent_router`/`subagent_fork` 的卡片在调用参数带显式覆盖
  (顶层或 `agentOptions`)时渲染一行 `model · provider`;没有则完全
  不变(官方 subagent 工具的模型在配置侧,永不渲染)。
- **`!` / `!!` 行像真实 shell 一样补全。** 命令名来自 `compgen -A
  command` 桥(按工作目录 + PATH 缓存 30 秒),`$` 后补全 `$VAR` 名,
  `git` 子命令实时列出(带 git < 2.18 的静态回退);`!<Tab>` 列出缓存的
  命令。路径仍走现有 fd 补全。设计:`docs/input-and-card-polish.md` §1。
- **本地 shell 沙箱偏好。** `/settings` → Local shell sandbox:用户手动
  执行的 `!`/`!!` 命令默认不再经过 dsh 沙箱(bypass——pi/kimi 对齐:
  沙箱保护的是模型自动执行的命令,不是用户自己敲的),可选的 `sandbox`
  模式恢复策略路径。§2。
- **问题卡展示答案。** 折叠的 `ask_user_question` 卡预览 `N/M
  answered`(绝不显示裸 answers JSON),展开卡逐条列出答案(`● id →
  答案`,跳过的题目暗色显示)。§3。
- **Goal 卡可读。** `get_goal`/`create_goal`/`update_goal` 卡带命名标题
  (Read/Create/Update Goal)、折叠摘要(`phase active · revision 3 ·
  2/6 rounds`、`no goal set`)与展开字段行——绝不显示裸 goal JSON。§4。
- **schedule、cordis-inspect 与 ralph 的折叠预览不再泄露 JSON。** 结果
  预览行显示解析出的摘要(`1 scheduled`、`mode plugins`、ralph 的友好
  首行),解析不出就整行消失——展开体保持原样,与 web 对齐。§6。
- **全屏 todo dock 点击。** 点击 `☑` 摘要行打开 todo 面板;点击面板在
  紧凑 → 完整列表 → 回到摘要 之间循环,鼠标即可开关面板,无需 Ctrl+T。
  任务浏览器的提示行在存在可选子代理行时显示 `i interrupt`。

### 变更

- **队列窗格通知分类(web parity)。** 只有用户来源的消息渲染为可
  steer 的 `❯` 行;子代理汇报(relay)、注入指令、goal 消息与插件通知
  渲染为 `⏳` 通知行。通知行超过五条折叠为一行 `+N more notices
  pending`(用户行永不折叠),且一旦主 agent 接收即消失——子代理批量
  结算不再刷屏。
- **Todo 面板全屏点击。** 全屏时点击 todo 面板可在完整列表与折叠之间
  切换(小终端上几何已 clamp);Ctrl+T 仍然开关面板本身。
- **Ctrl+J 不再是 host 键位。** 传统终端把 Ctrl+J 当作 LF(编辑器的
  回车),任务浏览器和弦不可靠;浏览器改由 ↓(空编辑器)与 `/tasks`
  进入,插件现在可以自行绑定 Ctrl+J。
- **`!` / `!!` 在会话工作区执行。** Shell 命令在 live 会话的 cwd 中
  执行(pi 对齐)而不是启动目录,切换会话后补全与执行保持一致。
- **用户手动执行的 `!`/`!!` 命令默认绕过 dsh 沙箱。** 沙箱偏好默认
  `bypass`(见上方新设置行);设为 `sandbox` 可让用户命令重新走 dsh
  shell 能力的策略。

### 移除

- **`/queue` 命令彻底移除。** 逐条管理面板和它的兼容存根都不在了——
  编辑器上方的队列窗格是唯一的队列面(`Ctrl+S` 全部 steer,`Alt+↑`
  把排队消息拉回编辑)。名字已从宿主命令目录释放:输入 `/queue` 现在
  会和任何未知 `/行` 一样被 steer 给模型,下一个版本起插件可以占用
  这个名字。

### 修复

- **Alt+↑ 出队只拉回用户自己的消息。** 之前的过滤只匹配
  `source.form === 'notice'`,子代理汇报、注入指令与 goal 消息可能被
  拉进编辑器草稿变成可编辑的用户文本;窗格的分类(`isUserQueueInput`)
  现在同时驱动窗格与出队。
- **双击 Ctrl+C 退出和弦现在可见且更宽容。** 空输入时第一次 Ctrl+C 只会
  在静默中武装一个 500ms 的退出窗口,没有任何提示——人手的"连按"间隔
  往往在 0.6–1s,第二次按键会静默地重新武装而不会退出,紧接着按 Enter
  还会发出空消息,看起来就像和弦坏了。现在窗口改为 1.5s,第一次按键会
  显示 `Press Ctrl+C again to exit`,武装状态可见,自然的双击即可退出。
- **Ctrl+C 清空编辑器后立即重绘。** pi 语义的首次按下清空只改了内存中的
  草稿,却没有调度新帧——按键在应用层被消费,fork 的输入路径不会到达
  聚焦编辑器,其渲染也不会触发。真实终端里旧文本会一直留在屏幕上直到
  下一次按键,清空看起来像没生效(紧接着再按一次 Ctrl+C 反而会按
  "清空后退出" 和弦直接退出)。Ctrl+S steer 与 Ctrl+Enter queue 的草稿
  清空也补上了同样的显式重绘。
- **折叠卡不再泄露裸 JSON。** `ask_user_question` 与 goal 卡在结果无法
  解析出安全摘要时整行去掉折叠预览(失败调用也绝不显示成功摘要);
  schedule、cordis-inspect 与 ralph 的预览遵循同一规则。
- **问题答案计数与渲染行永远一致。** 畸形答案条目现在使整组作废(web
  `every-isAnswer` 对齐),而不是"计入总数却不渲染"。
- **失败的补全运行不再被缓存。** 超时、中止或失败的 `compgen` 运行不再
  让 `!` 补全在整个缓存 TTL 内失效——下一次按键会重试 shell。
- **无法提供的沙箱偏好会被提示。** Local shell sandbox 设为 `sandbox`
  但组合中没有 shell 能力时,每次 `!` 运行都会提示命令在无沙箱下执行,
  而不是静默降级。
- **问题模态期间的所有点击都被捕获。** 问题框外的点击(含宽度 resize
  后的过期几何)不再穿透到模态后面的 todo 面板或消息展开。

## [0.2.1] - 2026-08-21

### 变更

- **仓库根目录即发布包。** `@xmoon76/dsh-pi-tui` 的包根从
  `packages/dsh-pi-tui/` 提升为仓库根目录;`packages/pi-tui`(私有
  vendored fork,仍在构建时打进 `dist/`)成为唯一子 workspace 包。
  对 npm 消费者无行为变化——0.2.0 的完整契约原样保留:全部 8 个公开
  exports(含 `./extensions`、`./extensions/advanced`、
  `./extensions/unstable` 与 `./builtins`)、6 个 tsdown 入口、7 套
  postpack smoke,以及 CI exact-artifact 发布链(Node 22/24/26 tarball
  smoke 与 vim-plugin-smoke 仍是 publish 门禁)。源码安装路径从
  `@file:$PWD/packages/dsh-pi-tui` 变为 `@file:$PWD` / `@link:$PWD`,
  中文 README 现在随包发布。

## [0.2.0] - 2026-08-21

### 新增

- **扩展平台 v1——本版本的重头戏。** TUI 现在可扩展:第三方 Cordis
  插件可以贡献 chrome(标题徽标、dock 项、footer 段)、编辑器上下的
  widget、斜杠命令、主题、设置行、自动补全 provider、按键绑定、
  transcript/工具渲染器、托管 overlay,甚至替换编辑器本身——无需接触
  TUI 内部。插件只导入 `@xmoon76/dsh-pi-tui/extensions`,按能力特性
  检测(API 版本 1),并且完全生命周期化:插件卸载/HMR 只移除该插件
  的贡献,表面销毁后陈旧句柄永远无法再变更它。内置的版本徽标与
  轮次/步骤计数器现在也通过同一公开 API 自证
  (`@xmoon76/dsh-pi-tui/builtins`)。作者指南见
  `docs/extension-api.md`。
- `/login` 现在可以新增部署从未配置过的供应商。凭据选择器合并了 llm
  configurable-provider 目录(所有内置 pi-ai catalog 路由 + 手写 profile)
  与 settings section,按 已配置 / 可用 / 自定义 分组,并提供
  `[ Add New Platform ]` 动作行:进入引导向导——route、线协议、Base URL、
  显示名与 API key——自动探测端点公布的模型(失败可手填),通过
  `settings.mutate` 落盘 profile 并存储凭据。`/login <route>` 对全新
  route 直接进入同一向导并预填 route。catalog 路由保持一步到位:
  `/login anthropic` 仍只询问 key。供应商拓扑、llm-pi-ai/llm-deepseek
  settings 或任何凭据变化时(包括外部编辑 `settings.yaml` /
  `.credentials.yaml`),footer 模型行与欢迎卡片即时刷新。
- **真实插件验证(Phase 5)。**层级选择由真实消费者验证,见
  `packages/dsh-pi-tui/examples/plugins/`,由
  `scripts/examples-plugin-smoke.mjs` 对打包 tarball 门禁:
  **生产级 vim 模态编辑器**(insert/normal 模式、h/j/k/l、词移动、
  x/d/c、i/a/o、undo/redo、yank/paste、多行、光标同步、提交集成——
  全部经语义化 `EditorInputEvent`,绝不接触 raw 字节;Advanced editor
  SDK 足够,无需 Unstable)、**questionnaire 表单**(Phase-4 命令式 UI
  broker:select → 自由文本 → confirm → notify)与**交互式 shell**
  (Unstable raw seam:exclusive raw 所有权 + raw 渲染低层 mount;
  `exit` 或 Host 紧急 fail-safe 返回)。作者决策树见
  `docs/plugin-authoring.md`;API gap 过程与 Stable promotion review
  记录在 `examples/README.md`。
- **Pi 能力对齐(Phase 4)。** Advanced 层新增高价值 Pi 风格能力:
  **命令式 UI broker**(`advanced.ui.select/confirm/input/notify`——
  基于 Host 自有 picker/question/notify 基础设施的 Promise 化提示,
  caller-fiber 取消、surface 销毁结算)、**自定义交互 UI**
  (`advanced.ui.custom`——由 Host 挂载工厂构建的交互组件,通过公开的
  `AdvancedCustomHost` facade 报告结果,绝不传私有 TUI 对象)、
  **host-state facade**(`advanced.host`——theme 查询/选择、title
  覆盖、working 指示覆盖、tool 展开偏好)。Pi 能力矩阵
  (`docs/extension-capability-matrix.md`)记录层级映射作为路线图参考。
  打包验收:新增 `phase4-plugin` fixture + `scripts/phase4-plugin-smoke.mjs`
  门禁。
- **Unstable 扩展层(Phase 3)。** `@xmoon76/dsh-pi-tui/extensions/unstable`
  现在是可用层级(`UNSTABLE_API_LEVEL = 1`),不保证兼容:
  **raw 输入拦截**(`unstable.input.raw`——在 Host 解码之前对 RAW
  terminal 块做 observe/consume/rewrite、exclusive raw 所有权且冲突
  显式报错、handler 抛错 fail-open、每个块最多过一次拦截链)、
  **Host 紧急 fail-safe**(1.5 秒内三连 Esc 释放全部 raw capture 并
  关闭全部 unstable mount——在 capture 之前检测,插件无法改写或消费)、
  **低层 surface seam**(`unstable.surface.handle`——requestRender/
  几何/mountComponent 承载 raw 渲染组件;绝不暴露 TuiApp/屏幕/
  terminal)。facade 为 `unstable(service)`——Stable service 接口未动。
  所有资源仍为 caller-fiber 所有、surface generation 作用域;失败进入
  共享 health ledger。作者指南:`docs/extension-unstable.md`。打包验收:
  新增 `unstable-plugin` fixture + `scripts/unstable-plugin-smoke.mjs`
  门禁。
- **Advanced 扩展层(Phase 2)。** `@xmoon76/dsh-pi-tui/extensions/advanced`
  现在是可用层级(`ADVANCED_API_LEVEL = 1`),提供三类能力,全部仍由
  Host 中介(绝不接触 raw terminal 字节、绝不暴露私有屏幕):
  **规范化输入捕获**(`advanced.input.capture`——observe/capture/
  exclusive 模式、确定性优先级排序、exclusive 冲突显式报错、handler
  抛错 fail-open)、**聚焦交互表面**(`advanced.ui.interactive`——交互式
  托管 overlay 承载插件自有的交互组件,渲染由 Host 编译、输入由 Host
  归一化、focus/blur、resize 重编译与全屏迁移)、**高级编辑器控制**
  (`advanced.editor.control`——经 Host 编辑器座位的 get/set/cursor/
  insert/paste/focus)。facade 为 `advanced(service)`——Stable service
  接口未动。所有资源仍为 caller-fiber 所有、surface generation 作用域;
  失败进入共享 health ledger。作者指南:`docs/extension-advanced.md`。
  打包验收:新增 `advanced-plugin` fixture + `scripts/advanced-plugin-smoke.mjs`
  门禁。
- **分层扩展面。** 公开扩展 SDK 现在分三个层级:稳定的
  `@xmoon76/dsh-pi-tui/extensions` 入口保持其兼容契约,新增的
  `extensions/advanced`(实验性;minor 版本可破坏)与 `extensions/unstable`
  (不保证兼容)入口携带层级元数据与保留的能力命名空间(`advanced.` /
  `unstable.`)。所有层级共享同一个扩展运行时(caller-fiber 所有权、
  surface 生命周期、失效机制)。vim fixture 不再兼任生产级 Stable-API
  的证明;完整模态编辑器移入 advanced/unstable 路线图。
- **dsh 0.1.0-rc.8 适配。** 依赖基线整体升至 rc.8(全部
  `@deepseek-ai/*` peer 与 dev 依赖),`commands.execute` 调用补齐 rc.8
  新增的图片数组参数,内置 agent presets 对齐 rc.8:`minimal` 预设新增
  Windows/PowerShell 双胞胎 shell 行(bash 在 win32 关闭、pwsh 对
  win32 开启),`codex`/`claude-code` 子代理行从 `enableRunInBackground`
  迁移到 `backgroundMode: one-shot`(spawn/fork 行保持 `continuable`)。
- **`@dir/` 补全 Tab 接受后自动展开(kimi 对齐)。** Tab 接受目录
  (`@src` → `@src/`)后立即在子项上重新打开下拉,无需再按一次 Tab;
  Esc 关闭下拉且不重新触发。消费侧新 `TuiEditor` 宿主子类实现——
  vendored fork 保持原样。
- **`/sessions` 与 `/resume` 对会话列表分类。** 默认视图隐藏 subagent
  会话(resume 面是给人用的);picker 打开期间 Tab 在 Main / All /
  Subagents 间循环(实时搜索词跨类别保留),All 视图把 subagent 缩进到
  其父会话之下(`└─` 树形)。直接 `/resume <subagent-id>` 仍可精确匹配
  任意会话。
- **会话标题加载更快。** picker 的标题读取改为分批渐进——前 20 行立即
  落地,其后按 50 行一批刷新——并引入本地缓存
  (`$DSH_HOME/cache/pi-tui-session-titles.json`,0600):会话日志未变时
  直接用缓存标题,昂贵的全量日志标题扫描只对真正新增或变化的会话执行。
- **上下文压缩的进度与结果。** 压缩进行中 working 行显示
  `Working... · Compacting context…`(单次 Esc 取消——pi 对齐);结束时
  弹出 `Context compacted` / `Compaction failed` 通知,transcript 新增
  可展开的压缩卡片(标题 + `Compacted N history items (~M tokens)` +
  摘要正文——web CompactionItem 对齐)。中途压缩的会话恢复时还原进行中
  状态。
- **`/model` 选择 effort 后自动关闭。** 选定 effort(或 Default)后整个
  模型 overlay 一步关闭(web ModelSelect 对齐);Esc 仍逐级回退,无
  effort 选项的模型保持面板打开。
- **footer 在窄终端自动换行。** 宿主状态行不再硬截断到终端宽度:自动
  换行跨行显示(有界——宿主 ≤3 行 + stats ≤1 行,尾部以 `…` 截断),
  模型、cwd、分支、上下文条与轮次/步骤计数在手机窄屏上不再丢失。
  `/settings footer` 密度语义不变。
- **fullscreen 拖选复制去掉 emoji 列空格。** 选择从行首开始时,复制出的
  transcript 行不再携带 bullet 列的填充空格(`❯ ` / `🐋  ` / `🐳  `
  续行缩进);4 格及以上的内容缩进(代码块)保留,行中开始的选择不受影响。

### 变更

- **TUI surface 现在有显式的生命周期。** 一个 surface GENERATION 跨越
  `start()`/`stop()`、fullscreen 切换与外部编辑器往返;只有最终
  `dispose()` 才递增它,dispose 之后所有交互能力都是良性 no-op
  (approval 以 cancelled 结算、question flow 以 rejected 结算、进行中的
  工作不应用任何结果)。这是扩展平台陈旧句柄契约所依赖的基础。
- `/preset` 选择器中 `code` 预设的英文名改为 `PTC mode`,与上游 dsh
  0.1.0-rc.7 的重命名保持一致(预设 id 未变,已有组合不受影响)。
- **Ctrl+C 与 Esc 改为 pi 的编辑器语义。** 第一次 Ctrl+C 清空非空编辑器
  (并记录时间);500ms 内第二次按下(此时编辑器已空)退出。Esc 关闭打开
  中的自动补全下拉(此前被 app 级处理吞掉,下拉无法关闭),agent 忙碌时
  单次 Esc 停止当前活动——转、工具运行或压缩——部分内容保留在屏幕上
  (空闲时保持双击 Esc 取消)。working 行标签改为 `Working...`。

### 安全

- **插件文本不再能注入终端控制序列。** 插件文本曾是唯一原样到达终端
  的通道;现在 C0 控制符、8-bit CSI、C1 控制符与完整 ESC 引导序列
  (CSI/OSC/DCS/PM/APC)都会在渲染前的公开边界被剥离,纯文本与
  markdown 视图均生效。宿主自身的样式是输出中唯一的 ANSI。

### 修复

- **宿主永不会被插件遮蔽或拖垮。** 插件命令会对照权威宿主目录校验
  (精确与近义冲突都被拒绝,包括特殊处理的 `/plan`);保留的宿主
  生命周期键不能被按键绑定占用;插件按键绑定只在聚焦编辑器拒绝该键
  时才触发;抛错的渲染器或回调被隔离到它自己的贡献,记录在
  `/status` 健康行中,永不逃出渲染或输入路径。
- **编辑器替换是安全的。** 插件编辑器占席时,通过其 `handleInput`
  通道接收真实输入,Enter 走宿主提交路径;display-only 编辑器(无输入
  钩子)绝不会把普通打字静默路由进隐藏的宿主编辑器;交接是原子的
  (create/transfer/compile 抛错时当前编辑器继续工作);陈旧编辑器捕获
  的每个能力在交接或销毁后都变为惰性。
- **窄终端保持完好。** 水平 stack 真正并排渲染,frame 按显示单元格
  精确钳制到宿主预算(ANSI/CJK 精确),一到两格宽的 frame 安全让位
  而不是溢出。
- 已结算的 `ask_user_question` 卡片不再显示原始 `{"answers":[…]}` JSON:
  改为显示已答计数摘要(`2/3 answered`,跳过的题目不计入),取消或中断的
  流程显示结构化错误标识(`UserQuestionError: ASK_CANCELLED` /
  `ASK_ABORTED`),而不是空白或 JSON 正文——与 web AskQuestionRow 对齐。

## [0.1.8] - 2026-08-18

### 变更

- 问题卡片的 back/skip 动词改为方向键:`→` 前进(未答题标记为 skipped,
  已答题保留 draft),`←` 回到上一题,复核页用 `↑↓` 在 Submit/Cancel
  之间切换、`←` 返回问题列表。字母键(`s` skip、`b` back)已移除——
  左右方向键现在与行进方向一致。

### 修复

- 在应答 Kitty 键盘协议查询的终端(zellij、WezTerm、Windows Terminal、
  kitty)上,问题卡片和任务浏览器的方向键/Esc/Tab 恢复正常:这两个组件
  此前直接比较原始 legacy 序列(`\x1b[A`、`\x1b`、`\t`),CSI-u 终端上
  这些按键以 `\x1b[1;1B` / `\x1b[27;1u` / `\x1b[9;1u` 到达后被静默丢弃——
  方向键/Esc/Tab 全部失灵,而字母和 Enter 正常(字母经 StdinBuffer
  可打印去重保持原始字节)。按键匹配现在统一走 `matchesKey`
  (legacy + CSI-u + modifyOtherKeys,含 zellij 上报的 super 修饰位 128)。
- Skill 斜杠命令(`/name` 和 `/skill <名称>`)不再吞掉用户的参数:此前
  per-skill wrapper 丢弃了 `invocation.rawInput`,只注入一张手工拼装的
  body 卡片,导致 `/glab open issue 123` 到达模型时只剩裸的 skill 说明,
  请求本身丢失。现在调用与 web 对齐——用户的原始行(含任何
  `/name args`)以普通用户消息发出,加载的 body 作为注入的指令上下文
  紧随其后,使用官方的 `<skill_content>` 渲染和 `skill-invocation` source
  (宿主 dsh-tool-skill 的 pre-step 监听器可见时由其渲染;TUI 只在
  没有宿主 loader 的组合里自行注入兜底,因此 body 永远不会重复)。

## [0.1.7] - 2026-08-18

### 修复

- 用户加载的 skill(`/skill <名称>` 或 `/opip-ip-query` 这类 per-skill 斜杠
  命令)现在会真正执行了:此前加载内容用 `agent.inject()` 投递,它只进
  next-step 队列而**不唤醒 driver**——agent 空闲时 skill 内容就一直躺在
  队列面板里,直到有无关输入唤醒回合。现在加载与 `/queue` 的 steer 动作
  一致:运行中的 agent 在下一个 step 边界接收,空闲的 agent 用它开启新
  回合(与 web 对齐——web 端把 `/name` 提示作为普通 follow-up/steer 提交,
  由宿主 pre-step 监听器注入正文)。
- subagent transcript 查看器不再冻结主 transcript:查看子会话期间,主
  agent 的事件此前会被丢弃,导致主 transcript 停止更新(subagent 卡片
  一直停在 `[running]`)且 working 指示器永不熄灭。现在查看器打开时,
  主会话事件照常进入主 folder。当被查看的子代理结果返回时(按委托的
  description 匹配),查看器还会自动弹回主 transcript,并锚定到最新内容
  (全屏模式滚动到底;普通模式强制一次干净的全量重绘)。

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

[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.1...HEAD
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
