# 更新日志

本项目所有值得记录的变更都会记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **兼容 DeepSeek Harness `0.1.7-alpha.2`：设置迁入 profile 持有的插件配置，Agent preset 切换到官方声明式 registry。** TUI 偏好（主题、页脚、显示预设、通知、按键绑定等）现在保存在 `tui-app` 插件的 profile 配置中，`/settings` 修改即时生效且按字段持久化；旧版 `settings.yaml` 中的既有偏好会在首次启动时自动迁移（含 Focus 偏好到显示预设的收敛），迁移只读旧文件、可重试且不会覆盖迁移后修改过的新值。Agent preset 列表改为官方 `standard` / `ptc` / `minimal` / `cordis` 声明（默认选择与「设为默认」由 Host 统一裁决），已移除对旧 `code` 默认值的猜测式别名映射。运行最低要求提升到 `dsh 0.1.7-alpha.2`。

- **两个独立的沟通设置：Progress updates 与 Response style。** 在 `/settings` 分别控制工作时的中途更新节奏（Milestones 默认 / Frequent / Off）与可见回复的密度（Default 默认 / Concise / Explanatory）；下一次模型步骤即生效，无需重启 Agent。偏好跨会话保存、互不影响，也不改变展示预设；Focus 只暂时抑制进度更新节（保存的节奏不变），Response style 在 Focus 下仍生效。

### 改进

- **Compact 与 Focus 的折叠过程统一为 `Think:` + `Action:` 两个槽，头部统一按 `actions` 计数。** 折叠卡不再只认识「真实工具调用」：`Action:` 槽按时间顺序显示最新的**属于某个 turn 的**非思考过程证据——真实工具调用、正在 Preparing 的调用、llm 重试，以及无法配对的工具结果诊断（诚实显示为 `Unpaired … result`，绝不伪装成成功调用）。头部随之统一为 `N actions · 子类型 ×次数`（如 `7 actions · read ×3 · bash ×2 · +1`；`+1` 计的是剩余**子类型种类**）：真实工具按其 `callCount` 计入（合并的 read 分组仍是 2 次调用），每次重试计一次，孤儿结果与 Preparing 不计入，`ask_user_question` / `exit_plan_mode` 仍由其交互面板独占、既不占据 Action 槽也不计入。Focus 与 Activity 共用同一套分类、选择、格式化与子类型排序规则；`1 action · read ×1` 这类单次计数不会被特殊隐藏。Tool 仍是严格的底层语义：重试不会因此变成工具。
- **`subagent/descriptor` 不再产生任何转录卡片。** 它是**子会话的身份记录**（version / mode / provider / label）：continuable 子会话的 descriptor 位于其首个 `turn/start` **之前**（上游断言 `descriptorIndex < turnStartIndex`），因此它不属于任何 model turn。子会话查看器的 label/mode/activity 仍由其自身权威状态展示，转录正文则不再出现合成的 `Subagent` 身份卡；真正的父侧委派证据本来就是那条 genuine `tool/call name=subagent`，由它承担 Action。旧窗口的 `N tool calls` 计数也不再包含描述符行。
- **斜杠命令成为真正独立的 transcript 节点，拥有自己的披露。** command 的生命周期属于会话级：DSH 以 `command/run`/`command/done` 直接追加日志事件，**不为它开启 model turn**，结算结果在模型历史之外渲染（`/compact [running]` → `/compact [ok]`）。命令卡是**独立行**：不再成为任何 Activity 的成员（它会切断相邻过程段的连续性）、不进入 `N actions`/`N tool calls` 统计、也不会被折叠 Focus 的 `Action:` 槽或 Thought 吞掉——「Agent 答完、用户空闲时执行 `/compact`」场景下反馈依然可见。其折叠与 Focus root 相互独立，长结果可操作（折叠单行预览、展开完整正文）；纯命令会话保持可见、可搜索，Ctrl+F 可通过锚定窗口揭示回合前/回合间/尾部的命令。手动 `/compact` 仅通过官方 `sourceCommandId`/`sourceEventSeq` 关系与压缩卡合一（绝不按名称/文本/相邻匹配）：压缩卡成为唯一可见 owner，命令的名称/参数/结果仍可通过它搜索到。
- **Activity 卡不再有独立身份图标，容器外层也不再缩进。** 用户可见名称仍为 `Activity`（内部 owner 类型不变），但其身份不再随图标风格变化：`▸ Activity` / `▾ Activity`（`🧰` / `✦` 及其图标语义一并移除），身份由折叠标记与名称表达；Focus、Activity、待定 Activity 卡与 Context 簇的外层两格缩进移除，折叠容器头部与其展开后的原始行共享同一转录左边缘（不再出现「折叠缩进、展开顶格」的层级倒置）。卡片**内部**的父子缩进保留：Thinking 正文、Tool 的 payload/result、PTC 子调用树、assistant/user 换行续行，以及 standalone Context 卡（notice / relay / recall）自身的正文——其 header 顶格、summary/payload/relay 正文与长消息标记统一缩进 2 格，与 Tool 卡的 payload 内缩一致；该缩进在按缩减后的内容宽度换行之后再施加，窄屏下不会为凑缩进而超宽。
- **Activity 头部现在显示该过程段自己的实际耗时。** 计时是仅展示层的 wall-clock 侧账，全部取自会话事件时间（思考、工具调用/结果，以及重试的点证据），在既有的单次聚合遍历内完成；运行中的卡片随现有重绘心跳实时走秒（不新增每卡定时器），证据缺失时省略时长（绝不显示假的 `0s`）；跨回合合并的连续 read 分组会丢弃计时，一个 Activity 的时间跨度绝不跨越回合边界；Preparing → 正式工具调用沿用最早的权威开始时间，已过秒数不再从 `3s` 重置为 `0s`。token 用量只保留在 Focus 头部（按回合统计）；Activity 是按过程段聚合的，没有可信的按段用量归属，因此**绝不**显示、估算或分摊 token。
- **Compact 的 Action 槽现在与 Focus 一致显示 PTC 活跃子调用。** 例如 `Code · Bash ×2 running`；窄宽度降级时优先保留 running 状态、再舍弃根描述文本；嵌套子调用开始/结束会即时刷新折叠 Activity 卡。
- **转录细节词汇收敛。** `/settings` 的 "Tool output" 更名为 "Transcript detail"（Bulk expansion for recent collapsible transcript content）；Ctrl+O 的描述改为 "Expand/collapse recent transcript detail"，Alt+T 改为 "Expand/collapse thinking detail"（折叠语义，而非可见性开关）；Display 描述改为 "…Compact folds contiguous process into Activity spans"；`/help` 同步改用以上措辞与生效键位。
- **Advanced API 新增 `advanced.host.setTranscriptDetailExpanded()`。** 原 `setToolsExpanded()` 保留为 deprecated 别名，两者驱动同一运行时状态（不维护两个字段）。
- **全屏滚动在大会话与 Focus/Compact 下更流畅。** 纯滚动/纯重绘帧不再每帧重新测量整份转录几何并重建每行点击身份：快照只在内容、折叠、图片加载或窗口尺寸真正变化时重建（几何 epoch）。~1500 挂载块的会话滚动帧耗时约 −37%，Focus 展开约 −27%，Compact 约 −16%；点击与复制的命中判定语义不变（滚动导致单元格位移的按下/松开仍会被拒绝）。

- **转录折叠 / 搜索 / 视口现在收敛到一套 owner 与揭示模型。** 每个隐藏区域在当前界面上都有一个可操作的 owner：常规界面统一用 `Ctrl+O` 主开关操作 Work、Context 簇、普通折叠、长/待发用户折叠以及 assistant 尾部的 delivered files；当该快捷键不可用（被改键或禁用）时这些折叠全部 fail-open，不再渲染无法打开的折叠头或 `(ctrl+o to expand)` 提示。delivered files 另有单独的 per-owner 能力：fullscreen Compact/Focus 或禁用快捷键时直接全部展开；Thinking 由 Alt+T 单独拥有，regular 面禁用 Alt+T 时同样 fail-open（不产生 compact 卡片或 dead 提示）。展开的 Focus 现在把连续过程呈现为可独立折叠的嵌套 `Work` 容器（全屏默认折叠，可用鼠标或搜索临时揭示；常规界面在 Thought 展开时保持完整揭示），显式折叠 Thought 会让该回合的嵌套 Work 回到 Compact 深度。鼠标点击容器内部的空白行现在折叠“最近的共享容器”（嵌套 Work 优先于外层 Thought，簇内空白折叠簇，边界/全局空白无动作）。搜索揭示改为容器路径：导航期间临时打开所有隐藏祖先且不写入手动状态，普通关闭会原子提升这些 owner，显式折叠会撤销临时揭示；搜索只揭示当前真正隐藏的匹配（fail-open 或已经可见的行不会凭空产生 owner）。折叠/展开仍复用既有的语义视口事务（不新增第二套 viewport 模型）。
- **会话展示现在只有一个规范的 Full/Focus/Compact 预设状态。** `/display` 是主控制命令，`/focus` 保持兼容。
- **Compact 展示预设现已可用。** `/display compact`、设置项 `display-preset` 以及持久化的 `displayPreset: compact` 都会真正启用 Compact：会话和 assistant 中间输出保持按时间顺序可见，连续的思考/工具过程折叠为带 Header + Think + Action 预览的 `Activity` 段（鼠标点击或 `Ctrl+O` 可展开查看原始过程行，`Ctrl+O` 也是批量展开/折叠入口）；注入的 `notice` / `relay` / `recall` 上下文改为独立呈现（生产者摘要、Agent 消息、会话回忆），相邻的环境类注入（instructions/catalog/snapshot）合并为可展开的 Context 簇。Compact 仍是可选预设，默认值不变。
- **Context 簇头部现在同时显示展开状态与 Context 身份。** 折叠/展开标记（`▸`/`▾`）后新增 Context 身份图标：emoji 下为 `▸ 📎 Context · N injections`，symbols 下为 `▸ ⋅ Context · N injections`，minimal 下只保留 `▸ Context · N injections`（装饰图标自动隐藏，无多余空格）。`Activity` 头部则遵循「只有折叠标记 + 名称」的规则，不引入 Context 式身份图标。
- **折叠的 Focus 会把回合中途的过程通知收进 Thought。** Agent 已在工作期间到达的 `notice`（后台任务完成、子代理结算等过程反馈）不再独立占据一行，而是收进折叠的 Thought，展开 Focus 时按原始时间顺序完整恢复；唤醒本回合的开头通知仍然可见（用来说明 Agent 为何被唤醒），中途的 `relay` 也仍然独立可见。中途通知在折叠状态下仍可通过全文搜索临时定位，关闭搜索后恢复折叠，不产生新的手动展开状态。
- **长会话下打开搜索的展示重建不再随历史规模平方增长。** 大历史会话中搜索定位的重新投影改为每个投影周期只解析一次揭示归属，历史越长改善越明显。
- **已结束的 `ask_user_question` 与 `exit_plan_mode`（Plan review）卡片现在作为“人工交互证据”独立展示，不再被过程折叠吞掉。** 两者只按工具身份识别（恰好是这两个工具，不新增语义类别，也不因为卡片丰富或曾需要批准就扩大范围）：Compact 下成为 `Activity` 的边界并原地单独展示（不计入 `Activity` 的 actions 统计或 Action 槽）；折叠的 Focus 会把它们提到 Thought 之外（与 user/steer、surfaced Context 同类，保持原始相对顺序，不跨越已提交回答/steer 的顺序边界）；展开 Focus 时回到原始时间位置；Full 不变。卡片自身的展开/折叠与 Focus root 相互独立（折叠 Focus root 不会重置它），并复用已有 Tool 卡片交互（全屏可点击；常规面无可操作 owner 时按现有能力完整展示）。仍在等待回答/批准的问题不受影响——交互仍由其面板独占，不会重复出现一张已结束样式的卡片；部分作答、跳过、取消或出错的问题卡片同样保持独立可读。其余工具（todo/goal/subagent/workflow/schedule/cordis/bash/edit 等）仍属于普通 Process。
- **Question / Approval 保留响应所有权，同时允许只读上下文检查。** 模态打开时仍可通过直接或 leader 检查快捷键使用折叠、Thinking 展开、全屏回到最新位置、Todo 展示切换，以及已证明的全屏展示性鼠标目标；固定的 Question / Approval 响应键优先于冲突的全局检查快捷键，提交、会话切换和生命周期操作仍由模态保护。
- **长会话全文搜索显著更快。** 连续输入、`Enter`/`Shift+Enter` 跳转现在**每个操作最多
  重建一次**会话内容，不再重复重建、重复测量或整窗重绘；同一窗口内的跳转近似即时，
  跨窗口跳转只有一次必要的重新投影。
- **搜索会复用活动卡片的渲染命中索引。** 同一张卡片的渲染内容没有变化时，重复跳转会复用
  已有的命中结果；查询变化只重新计算命中，卡片内容变化时自动重新建立语料，不改变语义
  搜索的 `N/M` 和命中身份。
- **只能定位来源的搜索结果会尽量靠近渲染命中滚动。** 在能找到对应来源区域或卡片内渲染命中时，
  全屏搜索会把候选命中带入视口；已经完整可见的命中不会反复把视口吸回固定位置。近似定位
  不会升级为强高亮，来源无法映射时仍回退到诚实的来源锚点。
- **当前搜索结果的视觉更醒目，并且跟随主题。** 能证明对应关系的当前命中使用明确的
  主题前景/背景色块（不再依赖终端的反显属性）；只能定位来源的命中改用一层更浅的
  背景提示所属卡片/来源行，其余命中仍是弱下划线——不会为了醒目而把某次出现伪装成
  “已证明的当前命中”。
- **搜索框打开时，会话内容仍可浏览和操作。** 全屏下可以继续用滚轮 / `PageUp` /
  `PageDown` 滚动、拖动滚动条、选中复制、以及鼠标展开/折叠卡片，同时搜索框保持
  输入焦点（`Home`/`End`、`Ctrl+U`/`Ctrl+D` 等编辑按键仍归搜索框）；编辑器、
  提交和其它弹窗仍被搜索框阻断。

### 修复

- **折叠 Think 预览不再冻结在第一行。** 无论流式还是结算，Think 槽都读取有界推理尾部的最新逻辑行：流式时窗口贴右缘跟随最新 token，结算后显示最新逻辑行的开头截断（此前多行推理永远显示第一行，流式时 UI 看起来像卡住）。Focus 与 Compact 共用同一预览实现（新增共享的 compact-process-preview 权威模块）。
- **恢复旧会话时，来源信息缺失或损坏的注入上下文不再让整个会话折叠崩溃。** 当历史日志记录了空/非对象的上下文来源时，该行安全降级为独立的通用 Context；未知或未来版本的上下文形式不会被误判为环境类注入，也不会凭空生成摘要或发送者。
- **Ctrl+F 全文搜索现在按“命中位置”工作，而不是按卡片。** `N/M` 统计和 `↑`/`↓`
  逐个经过同一张卡片里的每一次出现。所有可见命中都会以弱样式标出；当前命中只有
  在能证明“语义 occurrence 与渲染 occurrence 对应”时才用最强样式，否则只把它定位
  到来源区域（不做强高亮，避免标错命中）。全屏下同样按此定位，不再滚到窗口底部。
- **关闭搜索会保留当前浏览位置和可表示的展开。** `Esc` 或再次按搜索键关闭时不再跳回
  打开搜索前的窗口；当前结果为显示命中而临时打开、且已有正常用户 disclosure owner 的
  卡片/Thought/PTC 路径/Workflow Run 或 Phase 会继续展开。搜索高亮、搜索专用临时行、
  无 durable owner 的展示以及搜索期间明确折叠的内容仍会清除；`Ctrl+End` 仍明确返回最新位置。
- **切换会话时不再残留上一次搜索的当前命中。** 新会话不会继承旧会话的搜索高亮或
  临时展开。

## [0.4.7-alpha.2] - 2026-09-18

### 安装与版本对应

本版本把 `next` npm 线的 DSH 兼容目标推进到 `0.1.6-alpha.2`（peer floor
`>=0.1.6-alpha.2`）；安装 DSH 时需要显式允许其原生安装脚本：

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.6-alpha.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.7-alpha.2
dsh --profile pi-tui
```

仍需保留旧版 DSH 的用户，请安装与该 runtime 配对的 TUI 线：
`@deepseek-ai/dsh@0.1.6-alpha.1` 使用 `@xmoon76/dsh-pi-tui@0.4.7-alpha.1`，
`@deepseek-ai/dsh@0.1.5-rc.2` 使用 `@xmoon76/dsh-pi-tui@0.4.6`。

### 改进

- **DSH 兼容目标推进到 `0.1.6-alpha.2`。** Client Session 生命周期改为官方的显式引用持有语义（`retain` / `release`），因此 runtime peer floor 升至 `>=0.1.6-alpha.2`。仍在 `0.1.6-alpha.1` 的 Harness 会在启动时收到可执行的升级提示（也可继续使用已发布的 `0.4.7-alpha.1` TUI 线）。
- **待处理输入改为读取官方持久 inbox projection。** 排队/steering 行不再依赖会话内瞬时队列快照，重连或重启后仍可恢复；被其他 DSH 实例或上下文占用 writer 时会给出可执行的退出指引，而不是内部诊断信息。
- **`/fork` 与 `/rewind` 采用 DSH 官方 Host 分支语义。** Host 负责完成回合截断、子会话身份、谱系、工作区和模型/预设组合；Direct 与 Remote 路径保持同一语义。
- **运行中的 `/fork` 在派生请求提交时确定截断点。** 不再等待旧回合结束；导航被后续操作取代时，已发布的子会话仍可在会话列表中打开。
- **工作区归属现在与 Web 端共享。** TUI 配置挂载官方 workspace 服务；对已归属某个工作区的会话执行 `/fork` 时，子会话加入同一工作区，Web 端会把它显示在该工作区下。
- **首个用户回合不再提供 rewind。** 官方 Host fork 无法表达空前缀子会话。
- **超长用户消息现在可以双向收起。** 全屏下展开后的消息尾部新增 `▴ Collapse · …`
  控件，点击即可收回（不再只能依赖 `Ctrl+O`）；`steering…` 阶段的长输入也按同一套
  视觉行规则折叠，状态行始终可见。折叠/展开会保持视口：跟随最新时继续
  跟随，历史浏览时停留在同一条语义行。该尾部控件只出现在全屏，且不会被复制进剪贴板；
  regular 仍由 `Ctrl+O` 收起，不会向 scrollback 注入可被终端原生框选复制的文案。

## [0.4.7-alpha.1] - 2026-09-17

### 安装与版本对应

本版本把 `next` npm 线的 DSH 兼容目标推进到 `0.1.6-alpha.1`（peer floor
`>=0.1.6-alpha.1`）；安装 DSH 时需要显式允许其原生安装脚本：

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.6-alpha.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.7-alpha.1
dsh --profile pi-tui
```

继续使用旧版 DSH `0.1.5-rc.1`/`0.1.5-rc.2` 的用户请留在稳定版
`@xmoon76/dsh-pi-tui@0.4.6`；更旧的 DSH `0.1.1-rc.1`/`rc.2` 使用
`@xmoon76/dsh-pi-tui@0.3`。

### 新增

- **超长用户消息默认折叠。** 纯文本 Prompt 超过 10 个终端视觉行时，只显示开头 4 行、
  一条 `── N rows compacted · … to expand ──` 提示和结尾 3 行，让尾部说明保持可见；
  `Ctrl+O` 展开并收回最近 3 个用户回合内的超长 Prompt，全屏下也可点击提示行或搜索
  命中展开单条。折叠按当前宽度换行后的视觉行判断（CJK / emoji 按真实占位），resize
  后重新计算。已知限制：搜索跳转只展开命中所在的整条消息，不会把视口定位到命中那
  一行。
- **全屏 `↓ Latest` 提示。** 全屏 Transcript 一旦离开实时尾部（手动上滚或浏览
  history 窗口），底部出现可点击的 `↓ Latest · <快捷键>`；点击与 `Ctrl+End` 语义
  相同，直接回到全局 latest，回到尾部后提示自动消失。
- **`/model` 改为即时打开的可搜索模型面板。** 输入 `/model` 后立即显示
  `Loading models…`，目录加载完成后原地填充；provider 仅作分组，一次搜索覆盖
  provider/model 的名称与 id；reasoning 模型按 `Enter` 进入同一行的行内 effort 编辑
  （`←→` 调整、`Enter` 提交、`Esc` 返回）。DSH 的 session / 全局默认模型语义不变。
- **`/settings` 的 “Subagent allowed models” 改为可搜索分组列表。** `Enter` 直接
  增删允许路由；官方整段写入、last-route 保护、写入串行与失败回滚语义不变。
- **Job 详情浮层有独立的底部操作提示。** 运行中的 Job 显示 `S stop · Esc back`；
  任务结束后 Stop 提示消失且该键失效；`Esc back` 在长内容、短终端或窄屏下始终可见。
- **已接受但未落地的输入保持可见。** 提交的 steering / 排队输入在 queue pane 或会话
  尾部显示本地回显，直到权威 transcript 落地才退场；回显与权威消息按请求 id 关联，
  不依赖文本匹配。

### 改进

- **Quick Tasks 收敛为纯导航。** Footer `↓` 打开的 Quick Tasks 只响应方向键、`Tab`、
  `Enter` 和 `Esc`，其余按键一律 no-op（`S` / `/` / `T` 不再触发停止确认、搜索或
  视图切换）；`N` / `Shift+N` 与 Quick 的 `T` 进入完整视图已改为底部 “Open Task
  Center” 行 + `Enter`，完整 Task Center 新增 `Shift+Tab` 反向遍历类型过滤。
- **被中断的 parked steering 准确呈现并给出恢复路径。** turn 被 Interrupted 后，仍在
  inbox 的 steering 行显示 `waiting for next turn…`，并在下一次普通消息唤醒时按官方
  语义消费；此时空的 Ctrl+S 会给出提示而不是静默无操作。
- **Focus 头部显示真实执行状态。** 未完成 turn 显示 `Working`、
  `Waiting for approval · 12s` 或 `Waiting for input · 12s`，完成后显示 `Turn complete`；
  等待用户的时间不计入运行时长。
- **Focus compact 工具行改为工具身份 + 官方描述。** 前台 Bash 显示
  `Bash · <description>`，后台卡片显示 `<工具名> · <content 描述>`；未知的自定义工具
  保留原始名字，完整命令仍保留在展开后的 tool card 中。
- **折叠 Thinking 预览追随推理尾部。** 运行中的 compact Thinking 单行始终显示最新
  token（超宽时从左侧裁掉），只由真实 reasoning delta 驱动；settled 仍从行首显示。
- **短屏全屏下 Todo 首次展开 3 项。** 终端行数 ≤16 时 compact Todo 面板显示 3 项
  （普通终端仍为 5 项），缩放时按当前高度重新推导。
- **全屏拖选与 `/copy` 统一 clipboard policy。** 二者同时尝试 terminal OSC 52 与本机
  helper 两条通道，helper 成功不再阻断 OSC 52；修复远端（如 ORCA/xterm.js）下选择被
  复制到远端主机剪贴板、本地粘贴不到的问题。
- **文件 edit/write diff 卡片对齐 DSH 0.1.6 的边界化上下文 diff。** 共享上下文行不再
  被误报为增删，大文件中的稀疏改动保持精确；只有超出官方边界化 edit search（每个
  fragment 256 次 edit）才退化为粗粒度替换，折叠处的 `+N/-M` 与展开内容同源。
- **Task Center 的 Job 详情按层级返回，捕获型浮层的焦点恢复统一。** 从 Quick Tasks 或
  完整 Task Center 打开 Job **状态详情**后，`Esc` 返回同一个 Task Center 实例（保留
  选中行、滚动、过滤、搜索与展开状态），再按一次才回到编辑器；能定位子会话的 subagent
  作业仍直接打开子会话 transcript。浮层关闭后被恢复的下层捕获型浮层重新取得键盘焦点
  与焦点席位，`nonCapturing` 提示浮层不自动夺焦也不压住同级浮层；Question / Save
  Location 结束与 fullscreen 切换只做内部恢复，保留当前逻辑层级、可见性与焦点意图
  以及前置顺序。

### 修复

- **TUI 启动失败不再被静默当作可选插件失败。** 启动提交就绪但 `tui-app` 从未挂载时，
  打印明确错误并**以非零状态退出**，不再出现「告警 + 成功 + 进程仍驻留」的假成功。
- **preset 选择可见性跟随部署策略。** 部署把 `modeSelectionEnabled` 设为 `false` 时，
  `/preset` 不再出现在斜杠候选与 `/help` 中，直接输入仍按官方策略拒绝；roster 不可用
  时保持原展示。
- **全屏历史滚动位置不再被拉回尾部。** 队列面板增删、其他 chrome 变化或终端 resize
  改变 viewport 高度时，已经滚离实时尾部的视图保持原位置；只有显式回到底部才恢复
  跟随。

### 兼容性

- **PTC / workflow runtime 对齐官方 0.1.6 组合。** `ptc` preset 通过官方 `ptc-runtime`
  行获得 PTC 运行时，TUI 不再插入已退休的 `code-runtime-worker-thread` 行，host 平面
  的 workflow 行也对齐到官方 `workflow-ptc`。

> **已知限制：** 当前生产默认后端仍为 Direct；remote attach 暂不支持。

## [0.4.6] - 2026-09-13

### 安装与版本对应

本稳定版与 0.4.5 使用相同的 DSH 兼容范围：最低兼容 DSH `0.1.5-rc.1`，同时兼容
`0.1.5-rc.2`。推荐安装 rc.2；安装 DSH 时需要显式允许其原生安装脚本：

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.5-rc.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.6
dsh --profile pi-tui
```

不要把本版本与历史 DSH `0.1.3-alpha.2` 线混用。仍需保留旧版 DSH 的用户，
请安装对应的历史 TUI 线：DSH `0.1.2-rc.1` 使用
`@xmoon76/dsh-pi-tui@0.4.1`，DSH `0.1.3-alpha.2` 使用
`@xmoon76/dsh-pi-tui@0.4.3-alpha.2`，更旧的 DSH `0.1.1-rc.1`/`rc.2`
使用 `@xmoon76/dsh-pi-tui@0.3`。

### 新增

- **显式交付文件呈现。** `present` 工具卡现在以人类可读的文件列表显示，最终回答尾部会汇总实际交付的路径与描述，并在折叠视图中保持紧凑。

### 修复

- **Focus 实时呈现高度与滚动稳定性。** 流式 Markdown 内容在展开 Focus 中增高或收缩时，不再因临时高度变化造成视口抖动；历史内容更新、工具准备/完成以及 Focus/fullscreen 切换会正确释放旧的高度基线，并保留用户主动滚动位置。

> **已知限制：** 当前生产默认后端仍为 Direct；remote attach 暂不支持。

## [0.4.5] - 2026-09-11

### 安装与版本对应

本稳定版最低兼容 DSH `0.1.5-rc.1`，同时兼容 `0.1.5-rc.2`。推荐安装
rc.2；安装 DSH 时需要显式允许其原生安装脚本：

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.5-rc.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.5
dsh --profile pi-tui
```

不要把本版本与历史 DSH `0.1.3-alpha.2` 线混用。仍需保留旧版 DSH 的用户，
请安装对应的历史 TUI 线：DSH `0.1.2-rc.1` 使用
`@xmoon76/dsh-pi-tui@0.4.1`，DSH `0.1.3-alpha.2` 使用
`@xmoon76/dsh-pi-tui@0.4.3-alpha.2`，更旧的 DSH `0.1.1-rc.1`/`rc.2`
使用 `@xmoon76/dsh-pi-tui@0.3`。

### 新增

- **PTC / `run_code` 嵌套工具树。** `run_code` 内的子调用现在会作为递归树显示在
  根 Code 卡片下，不再散落成顶层工具行；Focus、`/search` 和 Markdown 导出也会
  保留嵌套关系，并显示紧凑的活跃子调用提示。
- **会话呈现对齐 DSH Session 语义（兼容 V2/V3 持久化代）。** 实时回答、工具结果、
  Thinking 与冷恢复会话的显示更加一致；Focus、Transcript 和 Stats 不再把瞬态流内容重复展示。
- **`/search` 收敛进会话浏览器。** `/sessions`、`/resume` 与 `/search` 共用同一个
  全局搜索视图，同时匹配会话元数据和内容；早期会话也能被找到，内容搜索不可用时
  仍可用元数据筛选，浏览器不会关闭。
- **统一附件摄取。** `@` 提及、`/image` 参数与粘贴内容现在共享一条附件流水线，
  图片、普通文件、占位符和草稿提交的行为保持一致。
- **草稿中补全内联 `/skill` 引用。** `/名称` token 可从 detached skill 目录补全；
  接受后只插入引用，最终普通提问再由 Host 注入识别出的 skill。
- **Workflow 可扩展 UI。** Run/Phase 卡片在小规模运行中展示成员，在大规模运行中展示
  聚合摘要、异常预览和可筛选的 Task Viewer；completed、cancelled 与 interrupted
  状态也有明确的展示。
- **Workflow 生命周期/模型对齐 DSH alpha.2。** Workflow 保留完整运行与成员状态，
  冷回放、实时记录、搜索和 `/transcript` 使用同一套结果。
- **`/export` 现在保存完整 Session 归档。** 导出包含子代理与附件，并生成可恢复的完整
  Session 文件；旧的单日志 JSONL 导出已移除。
- **新增 `/transcript` 命令。** 将当前 Session 保存为可读的 Markdown 对话记录到 Client 本地目录,与 `/export` 相同的无参数/保存位置交互。
- **Welcome Card 视觉重构。** 首屏欢迎卡引入原创圆润鲸鱼 ASCII mascot(5 种变体,每次启动随机一个),按终端宽度使用三档响应式布局:72 列以上鲸鱼与 session facts 左右并排,24～71 列鲸鱼居中、facts 在下,24 列以下切换为紧凑文本布局(🐋 标题)。鲸鱼保留 cyan → blue 品牌渐变,不随主题切换改色;facts 继续完整显示(长值 wrap、不截断),idle 邀请、`setWelcomeCard()` 契约、fullscreen 滚动/锚点/点击映射均保持不变。

### 变更

- **内置 Footer 默认布局更新。** 未自定义 Footer 的默认 statusline 现在是两行:第一行左侧为权限、Model、Tasks、目录、分支与扩展条目,右侧为 Plan 状态和 Focus Mode;第二行左侧为 token 用量、cache 命中、TTFB、吞吐与 turn/step 计数(stats-line 的语义拆解),右侧为完整 Context 用量(`已用/窗口 (百分比)`)。已保存自定义 `footerLayout` 的用户不受影响。

### 改进

- **流式工具准备 UX 增强。** 准备卡片在块结束前的身份迁移更稳：延迟到达的
  名称保留有界前缀，空 id 在 block 结束时迁移到权威 id，并行预览独立累计
  字节与摘要。
- **内容块呈现完善。** 打开中的不透明 assistant 块立即渲染（不再等流结束），
  pending final 有栅栏防护，过期确认的 assistant 预览会刷新；continuable
  子代理查看器保留查看历史。
- **命令与普通输入按"整行"判定，不再按命令名判定。** DSH 的命令判定表
  （`CommandDescriptor.input`）区分两类命令：`leadingInput` 命令（如 `/goal`）把参数一起当作调用，
  无参数命令（如 `/compact`）只有**裸命令**才是调用。此前只要名字出现在命令表里，整行就会走命令
  通道——`/compact 任意内容` 会被当成命令执行，运行中也不跟随 queue/steer 策略，带图片时还会被按
  命令附件规则拒绝。现在这类"带参数的无参数命令"与普通提示完全一致：跟随忙碌策略（queue/steer、
  Ctrl+Enter 取反），图片作为多模态提示进入模型；而 `/compact`、`/goal <objective>`、`/plan <message>`
  等真正的调用仍然走命令通道，附件规则也只在"这一行确实被命令接管"时生效。
- **`!`/`!!` 本地 shell 行不再把占位符带进 shell。** 本地 shell 本来就不 admit/consume 草稿，`!echo [image #1]`
  会把占位符当普通 shell 参数执行、图片留在 store 里。现在与其它本地命令一致：直接拒绝，并把草稿（含附件）退回。
- **命令附件按命令自身的声明处理。** 只有 descriptor 声明了 `input.attachments` 的命令才允许带附件调用；
  其余命令在派发前直接拒绝（`/<name> does not accept attachments; remove them first`），不再把"只有占位符、
  没有内容"的行交给 host。声明过的命令会在 host 命令调用上收到编码后的图片附件；命令提交**只在 handler
  成功后才 consume 附件**——失败的命令会连同附件一起还原草稿。文件附件对命令一律拒绝（host 需要上传
  receipt，本 client 尚无该通道）。skill 调用不受影响：显式 `/skill <name> [image #1]` 与 skill wrapper
  仍属 agent-facing，图片随投递的 prompt 进入模型，而不是走命令通道。策略按**最终 authority** 复核：
  未知的 `/name [image #1]` 若其命令在 session 建立后才出现（session 级 host 命令），会在 session 解析后
  再判一次——未声明的命令会被拒绝，而不是带着空 payload 执行并把草稿 consume 掉。
- **带附件的 `/name args` 行不再被当成 client 命令。** client 命令 contribution 只 claim **裸 `/name`**，
  所以 `/deploy [image #1]` 这类带参数（附件必然引入参数）的行本来就**不是** contribution 调用：它作为
  普通多模态提交进入模型，插件 handler 不执行、也不会再报 "local command" 附件拒绝。
- **deferred start 期间插件重载不会串代执行。** 首次输入触发的 session 解析过程中，如果该 contribution
  被卸载/重载（即使 owner 与 id 相同），已提交的命令**不会**执行新一代的 handler，也**不会**降级成模型
  prompt：提交被中止、提示 `/<name> is no longer available`，草稿还原后可直接重试。
- **Ctrl+Enter 与 Web 提交语义对齐。** 运行中按 Ctrl+Enter 现在取"忙碌提交行为"的**相反值**：默认
  `busyEnter=queue` 时它 steer，`busyEnter=steer` 时它入队（空闲时一律入队）。旧的
  `app.input.queue` 动作保留为 deprecated、无默认键，已有自定义绑定仍然是"入队"，不会被悄悄改成
  相反行为；新的 `app.input.submitAccelerated` 独立拥有 Ctrl+Enter。

- **吞吐统计口径统一。** Footer 的 tok/s 现在按可观察到的 decode 输出 token 与对应观测时间窗计算；burst samples 不再与完整 LLM wall time 或其它阶段计数混合。
- **Focus 中的 steer 时间线更可靠。** 早到、迟到以及时间戳相同的 steer/answer 事件会按可证明的边界处理，跨 steer 的回答不会被错误吞掉或重复显示。

### 修复

- **过期的命令 handle 不再删除新一代注册。** handle 只代表**一次**注册：重复或迟到的 `dispose()`（HMR 重载后才到达的 fiber cleanup）不会删掉同 id 的新 contribution，也不会误清新一代的健康记录。
- **文本输入态的键盘所有权修正。** 自由输入编辑不再被父层抢走行编辑键：Question 的“Type something.”自由输入里 `←/→` 现在是文本光标（此前会误提交或翻页），`Home/End/Ctrl+A/E/B/F/Delete` 等编辑键统一进入共享输入。无选项的纯文本问题改为明确的两层状态：编辑层里 `←/→` 编辑文本、`↵` 提交、`Esc/Ctrl+C` 只退出编辑回到导航层，导航层里 `↵` 重新进入编辑、`←/→` 翻题（或跳过）、`Esc/Ctrl+C` 才取消整个流程（此前按 Esc 会把这类问题困在无法重新编辑的半死状态，或直接取消整个提问）。Question 编辑态与 Task Center 搜索态的底部提示改为只描述当前模式真实行为（不再宣传 `↑↓ select` / `A active/all` 等列表动作）。Transcript 搜索现在可用 Esc 或 Ctrl+C 关闭（`app.transcript.search.close` 默认键扩充，Ctrl+C 此前被搜索输入框吞掉），并在输入框下显示 `↵ next · ⇧↵ prev · esc/ctrl+c close` 指引。`/keybindings` 的搜索框改为共享 Input 渲染：支持光标移动/Home/End/删除/词移动等完整行编辑，提示随查询是否为空在 `Esc: clear` 与 `Esc: close` 间切换。
- **退出时完整回收 Direct 会话。** 退出 TUI 时，主 Agent、continuable subagent 与 Agent 作用域后台任务现在按固定顺序回收：取消主 Agent 并等待静默 → 排空 continuable 后代 → 最终持久化 flush → 释放 AgentHandle。此前退出后进程可能残留约 5 分钟（continuable subagent 仍存活）；现在退出在数秒内完成，且诊断日志能区分 surface 关闭、Host 回收与 launcher 退出。会话切换（/new、/fork、rewind、/sessions）提交后也会回收旧 owner 的 continuable 后代。
- **展示细节修正。** diff 展示对齐官方语义（折叠的多 hunk 有界、编辑 header 与结果 parity 保留）；`@` 文件补全保留完整路径，marquee 提示路由与宿主清理修正；fork/rewind 后模型选择引用保留；Focus thought 后的非用户回合 steer 保留，并区分 opening steer 与回合中途输入；assistant 工具结果展示在呈现流水线后保持不变。
- **会话打开与切换更稳健。** 打开/切换会话（/new、/resume、fork、rewind、/sessions）期间不再丢状态：新会话加载完成前旧会话保持可见可用，新会话初始化失败也不会卡死表面（重试仍能正常打开）；切换期间旧 Agent 保持写入权威直到新会话接管；迟到的 assistant 流片段按官方语义归位，不再产生残缺或悬空的块。

### 兼容性

- **客户端命令 contribution 改为"仅裸命令"调用（破坏性）。** 对齐 DSH `matchEnter`：contribution 是
  斜杠**菜单项**，只 claim **裸 `/name`**；`/name args` 不是调用——它作为普通提交进入模型（跟随忙碌
  策略、附件照常投递），插件的 handler 完全不执行。此前 `/deploy prod` 会执行插件 handler。需要参数的
  插件应在裸命令里自行打开面板/选择器，或把该能力做成模型可用的工具。
- **扩展 API 版本升到 2（破坏性）。** `api().apiVersion` 现在返回 `2`：下面的插件命令 contribution
  契约对 STABLE 面是破坏性变更（移除 `execution`/`argumentProvider`、`handler` 变为必填）；`1` 仍是
  M0–M3 基础版，插件可据此区分两套 schema。仍声明旧 v1 shape 的插件会在注册时**直接报错**，不会
  被静默重新解释。
- **插件命令 contribution 对齐 DSH 客户端命令模型（破坏性）。** `execution: 'local' | 'submission'`
  已**移除**：contribution 就是"客户端自有的命令"（必有 `handler`，无 host descriptor），会进入 `/`
  命令菜单并本地执行、永不 steer；名字与当前 host catalog 冲突时**候选合成整体失败**（不安装任何菜单
  行、记录扩展健康并在界面提示一次，提示中列出该轮全部冲突的 contribution），host 命令始终保留自己的 claim，**绝不会被降级成模型 prompt**。
  用于广告 prompt 型名字的 `submission` 请直接不要注册 contribution（未 claim 的 `/name args` 本来就
  是 prompt，发现渠道是 host 侧 skill）。`sessionless: true` 表示可在没有 session 时执行；默认
  `false` 会先解析/创建 session 再执行。与 **session 级 host catalog 同名**属于合成期冲突：整轮候选
  合成失败（对齐上游 `source-failed`，该 source 的命令行全部撤下，直到下一次成功合成），但 host claim
  已先行刷新，输入归属不受影响，冲突记录在该 contribution 的健康上并按 identity/失败代次提示一次（提示列出该轮全部冲突）；
  TUI 静态命令名冲突则在注册时直接抛错。另外从未接线的 `argumentProvider` 字段一并移除（请用
  `registerAutocomplete`）。
- **保留 standalone composition caller 的 `ModelSelectionRef` 兼容性。** 根导出的
  `composeAgent(ctx, ref)` 形式继续可用，返回的 setup 会安装调用方持有的 selection，
  无需 Agent；Direct runner 继续使用显式 Agent-local installer 形式。

> **已知限制：** 当前生产默认后端仍为 Direct；remote attach 暂不支持。

## [0.4.3-alpha.2] - 2026-09-08

### 安装与版本对应

当前预发布线建议按以下顺序安装，先安装匹配的 DSH，再将 TUI bundle 加入
profile：

```sh
npm install -g @deepseek-ai/dsh@0.1.3-alpha.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.3-alpha.2
dsh --profile pi-tui
```

需要保留旧 DSH 的用户按下列对应固定 TUI 版本：`0.1.1-rc.2` 用
`@xmoon76/dsh-pi-tui@0.3`；`0.1.2-alpha.2`/`alpha.3` 用
`@xmoon76/dsh-pi-tui@0.4.0-alpha.1`；`0.1.2-alpha.4`/`alpha.5` 用
`@xmoon76/dsh-pi-tui@0.4.0-alpha.2`；`0.1.2-rc.1` 用
`@xmoon76/dsh-pi-tui@0.4.1`。完整版本矩阵和更新/卸载命令见 README 的
「安装到 DSH Profile」。

### 新增

- **PTC / `run_code` 嵌套工具树。** `run_code` 程序内派发的子调用现在作为
  递归子调用树挂在根 Code 卡片下：完整身份链（`subCallId`/`parentCallId`/
  `rootCallId`）支持孙级拓扑；未知父级的孤儿 start/settle 事实先私有暂存，
  父级出现时挂接，绝不提升为顶层 surface 行。子调用树与 Focus、展示与搜索
  等表面对齐：折叠 Focus 中 `run_code` 仍是正式 Tool 槽，并附加紧凑的活跃
  子调用提示（如 `Bash running` / `Bash ×2 running` / `Bash +1 running`，
  带宽度降级）；`/search` 语料递归包含子调用（命中定位到根 Code 卡）；
  markdown 导出保留嵌套输出。
- **会话呈现对齐 DSH v2 语义。** Direct 适配器按官方语义摄取
  `agent/assistant-stream` 实时帧（完成回合栅栏、修订间隔重同步），
  Transcript/Focus/Stats 折叠瞬态平面；冷回放从 assistant/message block
  恢复 thinking；移除旧的 durable assistant/chunk 私有路径。
- **`/search` 收敛进会话浏览器。** `/sessions`、`/resume` 与 `/search` 现在共用
  同一个会话浏览器：输入查询后进入全局搜索结果视图（本地元数据匹配 ∪ 内容
  匹配），不再按工作区裁剪搜索结果；命中片段直接显示在对应会话行上；内容搜索
  不可用或失败时，本地元数据筛选照常工作，浏览器不会关闭。
- **会话内容搜索对齐 DSH 官方语义。** Direct 适配器改用
  `sessionQuery.searchSessions()`（与 DSH master `ApiSessionList.search()`
  一致：可见性授权、去重、游标翻页、20 条结果窗口），移除了旧的“最新 100 个
  会话 + filterEvents”私有搜索规则——很早创建的会话中的匹配现在也能被找到。
- **统一附件摄取。** `@` 提及、`/image` 参数与粘贴内容走同一条附件 intake
  流水线：有界签名探测区分图片与普通文件，普通文件保留元数据并在提交时
  流式送入；占位与草稿提交行为一致化。
- **草稿中补全内联 `/skill` 引用。** 提示模式草稿中空白边界的 `/名称`
  token 现在按 detached 的人类 skill 目录补全；接受时插入字面引用而不提交，
  最终普通提问由 Host 的 `dsh-tool-skill` pre-step 注入所有已识别 skill。

### 改进

- **流式工具准备 UX 增强。** 准备卡片在块结束前的身份迁移更稳：延迟到达的
  名称保留有界前缀，空 id 在 block 结束时迁移到权威 id，并行预览独立累计
  字节与摘要。
- **内容块呈现完善。** 打开中的不透明 assistant 块立即渲染（不再等流
  结束），pending final 有栅栏防护，过期确认的 assistant 预览会刷新；
  continuable 子代理查看器保留查看历史。

### 修复

- **过期的命令 handle 不再删除新一代注册。** handle 只代表**一次**注册：重复或迟到的 `dispose()`（HMR 重载后
  才到达的 fiber cleanup）不会删掉同 id 的新 contribution，也不会误清新一代的健康记录。
- **文本输入态的键盘所有权修正。** 自由输入编辑不再被父层抢走行编辑键:
  Question 的“Type something.”自由输入里 `←/→` 现在是文本光标(此前会误
  提交或翻页),`Home/End/Ctrl+A/E/B/F/Delete` 等编辑键统一进入共享输入;
  无选项的纯文本问题改为明确的两层状态:编辑层里 `←/→` 编辑文本、`↵` 提交、
  `Esc/Ctrl+C` 只退出编辑回到导航层,导航层里 `↵` 重新进入编辑、`←/→` 翻题
  (或跳过)、`Esc/Ctrl+C` 才取消整个流程(此前按 Esc 会把这类问题困在无法
  重新编辑的半死状态,或直接取消整个提问);Question 编辑态与 Task Center
  搜索态的底部提示改为只描述当前模式真实行为(不再宣传 `↑↓ select` /
  `A active/all` 等列表动作)。Transcript 搜索现在可用 Esc 或 Ctrl+C 关闭
  (`app.transcript.search.close` 默认键扩充,Ctrl+C 此前被搜索输入框吞掉),
  并在输入框下显示 `↵ next · ⇧↵ prev · esc/ctrl+c close` 指引。
  `/keybindings` 的搜索框改为共享 Input 渲染:支持光标移动/Home/End/删除/
  词移动等完整行编辑,提示随查询是否为空在 `Esc: clear` 与 `Esc: close` 间
  切换。
- **退出时完整回收 Direct 会话。** 退出 TUI 时,主 Agent、continuable
  subagent 与 Agent 作用域后台任务现在按固定顺序回收:取消主 Agent 并等待
  静默 → 排空 continuable 后代 → 最终持久化 flush → 释放 AgentHandle。
  此前退出后进程可能残留约 5 分钟(continuable subagent 仍存活);现在
  退出在数秒内完成,且诊断日志能区分 surface 关闭、Host 回收与 launcher
  退出三个阶段。会话切换(/new、/fork、rewind、/sessions)提交后也会
  回收旧 owner 的 continuable 后代。
- **展示细节修正。** diff 展示对齐官方语义（折叠的多 hunk 有界、编辑
  header 与结果 parity 保留）；`@` 文件补全保留完整路径，marquee 提示
  路由与宿主清理修正；fork/rewind 后模型选择引用保留；Focus thought 后
  的非用户回合 steer 保留，并区分 opening steer 与回合中途输入；
  assistant 工具结果展示在呈现流水线后保持不变。
- **会话打开与切换更稳健。** 打开/切换会话（/new、/resume、fork、rewind、
  /sessions）期间不再丢状态：新会话加载完成前旧会话保持可见可用，新会话
  初始化失败也不会卡死表面（重试仍能正常打开）；切换期间旧 Agent 保持
  写入权威直到新会话接管；迟到的 assistant 流片段按官方语义归位，不再
  产生残缺或悬空的块。

### 兼容性

- **`next` 线要求 DeepSeek Harness `0.1.3-alpha.2` 或更高版本。** 旧 runtime
  的启动提示现在给出精确的 npm 升级命令
  （`npm install -g @deepseek-ai/dsh@0.1.3-alpha.2`），不再引用未发布的
  master source baseline。
- **本次已按精确的 npm `0.1.3-alpha.2` family 验证。** peer floor 为
  `>=0.1.3-alpha.2`，开发/测试依赖与冻结 lockfile 解析到该精确 family；
  兼容性与 preset/边界 smoke 直接对 registry 上的该 family 运行。

> **已知限制：** 当前生产默认后端仍为 Direct；remote attach 暂不支持。

## [0.4.1] - 2026-09-04

### 安装与版本对应

当前稳定版建议按以下顺序安装，先安装匹配的 DSH，再将 TUI bundle 加入
profile：

```sh
npm install -g @deepseek-ai/dsh@0.1.2-rc.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.1
dsh --profile pi-tui
```

需要保留 DSH `0.1.1-rc.2` 的用户应改用 `@xmoon76/dsh-pi-tui@0.3`。完整版本
矩阵和更新/卸载命令见 README 的「安装到 DSH Profile」。

### 新增

- **流式工具准备卡片。** 工具调用在准备阶段即可显示实时卡片；Focus 视图
  同步显示准备中的工具摘要，并在工具名称延迟到达时保持稳定位置。

### 改进

- **Focus 准备状态投影。** 普通视图、Focus 展开视图和不同 viewer 之间切换时，
  准备中的工具状态保持正确顺序；block 结束后会迁移到正式工具卡片或安全清理。
- **统一键盘退出确认。** Ctrl+C/Ctrl+D 等内置退出入口使用同一按键二次确认，
  避免不同按键交叉确认；非空编辑器中的 Ctrl+D 仍保持 forward-delete，自定义退出
  键映射不受影响。

### 修复

- 修正流式工具准备标识在 block 结束和 viewer 切换期间的迁移，避免卡片重复、
  错位或被迟到事件错误清理。
- 修正退出确认提示与编辑器/命令 surface 的按键路由，窄终端下仍保留必要提示。

### 兼容性

- **继续使用 DSH `0.1.2-rc.1`。** 0.4.1 仍声明支持范围
  `>=0.1.2-rc.1`；需要保留 DSH `0.1.1-rc.2` 的用户应使用
  `@xmoon76/dsh-pi-tui@0.3`。
- 0.4.1 沿用 0.4 线的 Session 与旧数据兼容策略。

> **已知限制：** 当前生产默认后端仍为 Direct；remote attach 暂不支持。

## [0.4.0] - 2026-09-03

### 安装与版本对应

当前稳定版建议按以下顺序安装，先安装匹配的 DSH，再将 TUI bundle 加入
profile：

```sh
npm install -g @deepseek-ai/dsh@0.1.2-rc.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.0
dsh --profile pi-tui
```

需要保留 DSH `0.1.1-rc.2` 的用户应改用 `@xmoon76/dsh-pi-tui@0.3`；DSH
`0.1.2-alpha.2`/`alpha.3` 用户应固定 `@xmoon76/dsh-pi-tui@0.4.0-alpha.1`，
alpha.4/alpha.5 用户应固定 `@xmoon76/dsh-pi-tui@0.4.0-alpha.2`。完整版本
矩阵和更新/卸载命令见 README 的「安装到 DSH Profile」。

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
- 显式 cold resume 在 TUI mount 前显示启动进度（`Resuming session…` /
  `Preparing conversation…`），不再让空白终端看起来像卡死。
- 搜索 overlay 的 Next/Prev 不再跳过新出现的匹配。
- 实时尾部追加刷新整个读组，搜索跳转不锚定旧窗口。
- 立即退出的 footer 命令子进程不再崩溃 TUI（EPIPE 吞掉）。

### 迁移说明与兼容性

- **0.4 线切换到 DeepSeek Harness 0.1.2。** 声明支持范围
  `>=0.1.2-rc.1`；低于 rc.1 的运行时收到启动提示：alpha.4/alpha.5
  回退到 `@xmoon76/dsh-pi-tui@0.4.0-alpha.2`，alpha.2/alpha.3
  回退到 `@xmoon76/dsh-pi-tui@0.4.0-alpha.1`，更旧的运行时回退到 0.3。
- 开发/测试依赖与 Source Mode pin 同步到 `dsh-v0.1.2-rc.1`；发布包
  peer 下限保持 `>=0.1.2-rc.1`。
- Agent preset 身份按 roster 解析；旧数据中省略的 `code` 默认值在 roster
  不含 `code` 时回退到 `ptc`。
- 上游 alpha 注意事项：DSH 0.1.2-alpha.1 的 subagent dispose 行为仍有
  上游 caveat。

> **已知限制：** 当前生产默认后端仍为 Direct；remote attach 暂不支持。

## [0.4.0-alpha.2] - 2026-09-03

### 安装与版本对应

当前预发布页面建议按以下顺序安装，先安装匹配的 DSH，再将 TUI bundle
加入 profile：

```sh
npm install -g @deepseek-ai/dsh@0.1.2-alpha.5
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.0-alpha.2
dsh --profile pi-tui
```

需要保留 DSH `0.1.1-rc.2` 的用户应改用 `@xmoon76/dsh-pi-tui@0.3`；DSH
`0.1.2-alpha.2`/`alpha.3` 用户应固定 `@xmoon76/dsh-pi-tui@0.4.0-alpha.1`。
完整版本矩阵和更新/卸载命令见 README 的「安装到 DSH Profile」。

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
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.0-alpha.1
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

[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.7-alpha.2...HEAD
[0.4.7-alpha.2]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.7-alpha.1...next-v0.4.7-alpha.2
[0.4.7-alpha.1]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.3-alpha.2...next-v0.4.7-alpha.1
[0.4.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.1...v0.4.5
[0.4.3-alpha.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.1...next-v0.4.3-alpha.2
[0.4.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.6...v0.4.0
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
