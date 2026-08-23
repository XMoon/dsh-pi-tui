# dsh-pi-tui

[English](README.md) | **简体中文**

发布历史:[CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) · [English Changelog](CHANGELOG.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`) 提供的第三方 TUI 模式,构建于 [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui) 的内置(vendored)fork 之上。

运行 `dsh --profile pi-tui` 即可获得终端界面,替代浏览器界面(`dsh --profile web`)或一次性模式(`dsh --profile headless`)。

> **状态:可用。** 该 TUI 覆盖了主会话流程——输入 → 会话事件、审批、
> 命令、会话切换与全文搜索——以及预设(presets)、技能(skills)、
> 模型/设置菜单和斜杠命令。渲染与输入路由由无头测试
> (`@xterm/headless`)验证,无需 TTY 或模型连接。

## 截图

![dsh-pi-tui 运行在终端中](https://raw.githubusercontent.com/XMoon/dsh-pi-tui/main/docs/dsh-pi-tui.png)

## 目录结构

完整的仓库布局见 [AGENTS.md](AGENTS.md)(贡献者操作手册)。一句话概括:
**仓库根目录就是发布的 `@xmoon76/dsh-pi-tui` 包**(唯一发布的包——其
清单声明 `dsh.bundle.patch`,`exports` 指向构建后的 `dist/`),而
`packages/pi-tui/` 是 `@moonshot-ai/pi-tui` 的内置 fork(重命名为
`@xmoon76/pi-tui`,私有,永不发布——其分叉修改清单见
`packages/pi-tui/AGENTS.md`),构建时被打进根包产物。

## 前置要求

- 一个支持 profile 的 DeepSeek Harness 安装(`dsh` 已在 `PATH` 中),版本
  `0.1.1-rc.1` 或同一兼容线上的更新版本——TUI 消费该版本的拆分凭据事件
  与 `ctx.authorization` 服务。
- Node >= 22.19(`^22.19.0 || >=24`,与 dsh 相同范围)。从源码运行需要
  原生支持 TypeScript 的 Node(>= 23.6)或 tsx ESM 钩子
  (`node --import tsx/esm`,dsh 自身源码启动的方式)。
- 仅从源码安装时需要 [pnpm](https://pnpm.io)。

## 安装

`dsh plugin` 会在目标 profile 目录内运行 pnpm,因此常用的 pnpm 动词
(`add`、`remove`、`update`、`list`)都可用。

### 方式 A — 从 npm registry 安装(推荐)

发布的包是自包含的:内置的 pi-tui fork 被打进了构建产物,所以只需安装
`@xmoon76/dsh-pi-tui` 一个包(`@xmoon76/pi-tui` 在本仓库保持私有,就像
kimi-code 保持 `@moonshot-ai/pi-tui` 私有一样):

```sh
# 把包安装到 pi-tui profile(必要时会创建该 profile)
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui

# 运行
dsh --profile pi-tui
```

任何在清单中声明了 `dsh.bundle` 的依赖都会自动加入 profile 的层栈
(layer stack)——无需手动配置 `cordis.patch.yml`。

### 方式 B — 从源码安装

构建产物不提交(`dist/` 对两个包都在 gitignore 中,且包的 `exports`
指向构建后的文件),所以从克隆安装前需要先构建:

```sh
git clone https://github.com/XMoon/dsh-pi-tui
cd dsh-pi-tui
pnpm install
pnpm build        # pi-tui tsdown (packages/pi-tui/dist/) + 根 tsdown (dist/, 打入 pi-tui)

# file: — 添加时把包复制进 profile;重新构建后需重新 add 以刷新
#(见下方"更新 / 卸载")
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD

# link: — 使用实时符号链接;`pnpm build` 的产物会被直接读取
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@link:$PWD
```

### 验证安装

```sh
dsh plugin --profile pi-tui -- list          # 应包含 @xmoon76/dsh-pi-tui
dsh --profile pi-tui                         # 启动的是 TUI 而不是 Web GUI
```

### 更新 / 卸载

```sh
# registry 安装:
dsh plugin --profile pi-tui -- update @xmoon76/dsh-pi-tui
# file: 源码安装在 add 时复制——重新构建并重新 add 以刷新
#(link: 安装实时跟踪仓库,只需 `pnpm build`):
pnpm build && dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD

dsh plugin --profile pi-tui -- remove @xmoon76/dsh-pi-tui
```

## 开发

```sh
pnpm install
pnpm build        # pi-tui tsdown (packages/pi-tui/dist/) + 根 tsdown (dist/, 打入 pi-tui)
pnpm test         # pi-tui 自带套件 (node --test) + dsh-pi-tui 无头测试
pnpm typecheck
node --expose-gc scripts/bench.mts   # 性能基线(可选)
```

测试通过 `@xterm/headless` 驱动 UI(见
`test/virtual-terminal.ts`),因此无需 TTY 或模型连接
即可验证渲染与输入路由。

### 开发历史(dogfooding)

本项目最初在浏览器界面(`dsh --profile web`)上开发,后来转为用自己开发
自己:自 2026 年 8 月 15 日起,所有修复与功能都在这个 TUI 内部完成,就像
本 README 与代码库的维护一样。开发循环运行在专用的 `pi-tui-dev`
profile 上,使用方式 B 的 `link:` 说明符安装
(`dsh plugin --profile pi-tui-dev -- add @xmoon76/dsh-pi-tui@link:$PWD`)
——实时符号链接,`pnpm build` 后无需重新 add 即可生效——而 `pi-tui`
profile 保持安装已发布的 registry 包用于真实使用。

## 扩展(早期,稳定化中)

自 `0.2.0` 起,该 bundle 携带一个小的、带版本号的扩展面,让第三方
Cordis 插件无需接触 TUI 内部即可贡献 chrome。它**处于早期、稳定化中**:
下面的能力是当前集合;API 版本(`1`)只在破坏性变更时递增,插件必须
**按能力特性检测**,而不是解析包版本。

所有扩展插件仍是标准 DeepSeek Harness / Cordis 插件,使用 `name` /
`inject` / `apply(ctx)`,统一依赖唯一的 `piTuiExtensions` 服务;三层
只是该单一 Service 上的能力 facade,而非独立的插件系统或 runtime。

扩展面分为三个层级:插件只导入**公开入口**——绝不导入 Stable 入口的
内部(`TuiApp`、`TuiMainScreen`、`TuiAltScreen`)或仓库相对路径。

| 层级 | 入口 | 契约 |
|---|---|---|
| Stable | `@xmoon76/dsh-pi-tui/extensions` | 面向兼容;只增不改;既有语义永不静默变更;删除需计划内破坏性变更 |
| Advanced | `@xmoon76/dsh-pi-tui/extensions/advanced` | 实验性;minor 版本可破坏;需迁移说明;不做长期 shim |
| Unstable | `@xmoon76/dsh-pi-tui/extensions/unstable` | 不保证兼容;实现可随时变更 |

所有层级复用同一个共享 Extension Runtime:caller-fiber 所有权、surface
生命周期、失效机制、能力发现。不要按层级复制第二套所有权/生命周期
模型。第一阶段之后各层级已逐步落地:

- **Advanced**(`ADVANCED_API_LEVEL = 1`,Phase 2 + Phase 4):规范化输入捕获、
  聚焦交互表面(交互式托管 overlay)、高级编辑器控制、命令式 UI broker
  (select/confirm/input/notify)、自定义交互 UI 与 host-state facade
  (theme/title/working/tools-expanded)——仍由 Host 中介,绝不接触 raw
  terminal 字节。作者指南:`docs/extension-advanced.md`;Pi 能力参考:
  `docs/extension-capability-matrix.md`。
- **Unstable**(`UNSTABLE_API_LEVEL = 1`,Phase 3):raw 输入拦截
  (observe/consume/rewrite、exclusive raw 所有权)、Host 紧急 fail-safe
  (三连 Esc)与精选低层 surface seam——不保证兼容;损坏的插件可能
  破坏 Host 行为。作者指南:`docs/extension-unstable.md`。
- **真实插件验证(Phase 5):**层级选择由真实消费者验证,见
  `examples/plugins/`——生产级 vim 模态编辑器
  (Advanced editor SDK)、questionnaire 表单(Advanced 命令式 UI
  broker)与交互式 shell(Unstable raw seam)。"该用哪一层?"决策树:
  `docs/plugin-authoring.md`。

插件只导入公开入口:

```ts
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'my-plugin'
export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService
  if (!service.api().capabilities.has('slot.chrome.header.badge')) return
  service.register<{ text: string; tone?: 'info' | 'warning' | 'error' | 'success' }>(
    'chrome.header.badge',
    { id: 'my-badge', order: 100, description: 'A header badge from my plugin.' },
    { text: 'my-badge', tone: 'info' },
  )
}
```

当前扩展点(v1):

| Slot | 语义 | 贡献 |
|---|---|---|
| `chrome.header.badge` | list | host 标题后的短 `[badge]` |
| `input.dock.item` | list | todo 面板上方的一行 dock |
| `chrome.footer.status` | list | 一个 footer 段(host 拥有宽度/截断) |
| `input.widget.above` / `input.widget.below` | list | 编辑器周围的有界 widget(M4 组件套件) |

贡献是**纯数据**,不是 render 函数:插件提供 `HeaderBadge` / `DockItem` /
`FooterSegment` / `InputWidget` 值(文本 + 语义 tone spans,或 widget 的
结构化 `ExtensionView` 树),渲染、ANSI 编译、宽度预算与截断全部由 host
负责。v1 刻意没有 `render(context)` 回调——插件从不持有渲染上下文,
贡献永远无法捕获或修改 host 内部。

自 `0.2.0` 起,`input.widget.above` / `input.widget.below` 两个 widget slot
接受有界组件套件:`ExtensionView` 是结构化视图树(`text` / `markdown` /
`spacer` / `stack` / `frame` / `rows` 视图 + 语义样式 token),由 host 编译
成私有组件。插件可以在编辑器上方或下方添加辅助行——例如状态 widget
或快捷参考行——而不接触根布局、编辑器或焦点。行预算由 host 拥有:
高度不足时先折叠低 importance 的 widget,编辑器永远存活。

```ts
service.register<InputWidget>('input.widget.below', {
  id: 'my-widget',
  order: 100,
}, {
  view: {
    kind: 'text',
    spans: [{ text: 'my-plugin ready', tone: 'success' }],
  },
})
```

自 M5 起,扩展面还覆盖注册表(计划 §10):

- `registerCommand(contribution)` — 斜杠命令的**所有权**元数据
  (`execution: 'local' | 'submission'`):插件声明的 local 命令始终直接
  执行(永不被 busy-Enter 偏好 steer);submission 命令走会话投递策略。
  实际执行仍在 host 的 commands 服务中;`/name args...` 保持 `rawInput`
  原样。名称冲突被报告,绝不猜测。
- `registerTheme(contribution)` — 一个具名语义调色板,可在 /settings
  主题选择器中选择;owner 卸载时回退到内置调色板(选中的插件主题
  绝不悬空)。
- `registerSetting(contribution)` — 追加到 /settings 面板的设置行
  (标签 + 当前值 + 选项 + 可选拒绝);面板由 host 拥有。
- `registerAutocomplete(contribution)` — 自动补全 provider,在 host 自身
  provider 返回 null 之后按确定性顺序咨询(逐 provider 隔离、
  latest-only commit)。
- `registerKeybinding(contribution)` — 归一化按键 → 语义动作的绑定,
  由 host 的 InputRouter(M6)路由。插件用公开的 `NormalizedKey` 形状
  (key + ctrl/alt/shift/super)声明按键和 host 动作列表中的语义动作
  (`submit-draft`、`queue-draft`、`steer-draft`、`cancel-activity`、
  `open-search`、`toggle-fullscreen`、`cycle-permission`)。host 统一归一化
  所有终端输入(Kitty CSI-u、modifyOtherKeys、legacy 序列)——插件永远
  看不到原始 escape 数据。保留的 host 生命周期按键(Ctrl+C/D/S/F/O/T/G/J、
  Ctrl+Enter、Enter、Esc)不可被占用;纯可打印按键永不触发绑定(输入
  永远优先);绑定是非捕获的,在优先级梯子的最后触发(question、approval、
  overlay、编辑器之后)。动作通过 host 自己的路径执行——提交/会话安全
  永不被绕过。
- `registerMessageRenderer(contribution)` — TRANSCRIPT 消息渲染器(M7,
  chain slot):接收语义 `MessagePresentationSnapshot`(不可变;绝不是可变
  message 或容器),返回 `ExtensionView` 或 `undefined`(弃权 → 下一个
  渲染器 → host 回退)。按 kind 限定的渲染器只作用于对应消息类型。
- `registerToolRenderer(contribution)` — 工具卡片渲染器(M7,keyed slot):
  从 `ToolPresentationSnapshot`(callId、toolName、status、arguments、
  result、expanded)呈现一个工具名的卡片;winner(最低 priority)弃权后
  落到下一个渲染器,再到 host 回退。同一工具名的 priority 平局是显式
  错误。渲染器绝不会卡住 transcript:抛错的渲染器被隔离、链继续,
  消息缓存内嵌渲染器身份 + 注册表 revision,因此 HMR/unload 只重建
  受影响的组件。
- `showOverlay(view, options)` — 受管 overlay 租约(M8):插件提供
  `ExtensionView` + 尺寸提示;host 通过其 overlay broker 挂载(模态堆叠、
  焦点、fullscreen 迁移)。返回的租约是 generation 限定的(表面最终
  dispose 会关闭所有仍在持有的租约),close() 幂等,hide()/show() 切换
  可见性而不关闭。插件永远不能挂载原始组件或抢焦点——终端和 overlay
  栈由 host 拥有。
[扩展 API v1 作者指南](docs/extension-api.md)记录了导入规则、完整
surface 表、生命周期/渲染契约、M11 弃用策略与稳定性契约。

M10 验收 fixture(计划 §15):仓库附带一个 vim-mode fixture
(`test/fixtures/vim-plugin/`),用于验证编辑器扩展接缝——第三方 Cordis
插件可消费打包后的公开 SDK,其替换编辑器通过**语义化** `EditorInputEvent`
接收输入(绝不接触原始终端字节),编辑器的 `create()`/`dispose()` 正常
工作——只导入 `@xmoon76/dsh-pi-tui/extensions`。它**不是**生产级 Vim,
也**不是** Stable API 完整性的证明:模态模式行为(insert/normal)不属于
Stable 契约,其余公开能力(命令、主题、设置、自动补全、按键绑定、渲染器、
overlay、widget)都有各自的独立测试。它的 CI 门禁禁止 `@xmoon76/pi-tui`、
`src/tui-app` 和仓库相对内部路径:如果 Stable 插件需要私有导入,说明 SDK
缺 capability(没有 `unsafeGetTuiApp()` 逃生舱)。

- `registerEditor(contribution)` — 编辑器 SDK(M9,计划 §14):按 priority
  单选(平局是显式错误);winner 通过 host 的**原子交接**占据编辑器座席
  (create → 转移 draft/cursor → mount → focus → dispose 旧编辑器)。
  create 抛错时当前编辑器继续工作;winner 卸载恢复下一个 winner / host
  默认编辑器,**保留 draft**。插件编辑器收到 `EditorHost`(surfaceId、
  generation、getSnapshot、replaceText、语义动作 dispatch submit/
  queue-submit/steer/open-external-editor、subscribe、invalidate)——但
  host 仍然拥有 busy-Enter、Ctrl+Enter、local 命令分类、粘贴保护、
  approval/question 捕获、会话 guard/lock、外部编辑器和退出:插件编辑器
  永远不能绕过这些。

生命周期由 host 拥有:插件 Cordis fiber 卸载(HMR、禁用)时注册自动清理,
regular/fullscreen 都会刷新,`handle.invalidate()/replace()` 通过活动屏幕
重渲染。`@xmoon76/dsh-pi-tui/builtins` 入口是仅 Loader 使用的一方贡献者
(版本徽标、轮次/步骤计数器、todo 摘要 dock 项)——不是稳定的第三方
SDK。原始终端访问、pre-host 输入拦截与完整输入所有权**不属于 Stable
层级**(见 Advanced/Unstable 路线图)。

## 斜杠命令(节选)

- `/sessions [query]` — 打开会话选择器:对会话 id、标题和工作区进行
  边输入边搜索,行按工作区分组并实时显示 `filtered/total` 计数,标题在
  后台按需加载。回车切换到所选会话。
- `/search <query>` — 在持久化的会话日志中全文搜索,然后跳转到命中项。
- `/title [title]` — 带参数时设置当前会话的标题(固定标题,防止自动
  生成;标题会出现在 `/sessions` 选择器中);**不带参数时根据对话重新
  生成标题——这会覆盖当前标题,包括你之前固定的标题**(`/rename` 是
  别名)。
- `/tasks` — 合并任务浏览器:后台 job 与子代理在同一个可搜索列表中
  (直接输入过滤行——`subagent`、`bash`、`failed`…)。子代理行把 mode
  写进主标签(`subagent · <label> · continuable` / `… · one-shot`),
  按下 `Enter` 之前就能知道查看器是否可交互。`Enter` 打开详情
  (子代理为子查看器,job 为状态查看器),`i` 中断选中的子代理。
  `/subagents` 是别名。
- `/yolo` — 切换到 `danger-full-access`(`/permission danger-full-access`
  的别名)。
- `/status` — 显示当前会话的统计与身份信息(回合数、token 用量、
  工作区、已安装的 dsh 版本)。
- `/rewind` — 从更早的用户回合 fork 当前对话:选择器列出每个已完成
  的用户提示(最新在上),选中一个会创建一个新的子会话,其历史恰好
  止于该回合之前,并把选中的提示回填到编辑器供修改。原会话从不被
  修改,仍可通过 `/sessions` 回到;**工作区与外部副作用(文件、shell、
  API)不会回滚。** 空编辑器下按 `Esc Esc` 也会打开同一个选择器。
- `/preset`、`/model`、`/settings`、`/export`、`/fork` —
  见 `dsh --profile pi-tui` 的命令自动补全(`/` + Tab)。

## 快捷键(节选)

- `Esc Esc` — 对话 rewind(空闲且编辑器为空时):打开 rewind 选择器,
  从更早的用户回合 fork。agent 忙碌时按一次 `Esc` 仍只取消当前
  回合/工具/shell 命令;草稿非空时双击 Esc 保持原有的取消语义。
- `Ctrl+F` — 切换转录搜索(`/search <query>` 覆盖层;再按一次关闭)。
- `Shift+Tab` — 循环切换权限预设(read-only → workspace-write →
  danger-full-access);页脚的模式槽位会为每个预设显示徽章
  (`[workspace-write]` / `[read-only]` / `[custom]`,`[yolo]` 标记免审批
  模式)。
- `Ctrl+S` — steer:有排队消息时,把整个队列(加上草稿,若有)一次性
  送入正在运行的回合;否则只发送草稿。空闲的 agent 会用全部内容开启
  新回合。
- `Alt+↑` — 出队:把所有排队消息拉回编辑器草稿。
- `Ctrl+T` — 切换完整待办列表(全屏时点击面板可在完整列表与折叠之间
  切换);编辑器上方的 dock 始终显示待办摘要与后台任务,排队的输入渲染
  在两者之间。
- `@` — 编辑器中的文件/文件夹提及:`@` + Tab 从整个工作区补全文件
  (`fd` 在 PATH 上时以其为后端,否则使用内置的递归回退)。字面
  `@path` 会被提交,由模型自行读取文件。有后台工作时,空编辑器的 `↓`
  会打开与 `/tasks` 相同的合并任务浏览器:
  - **子代理行**(实时子任务,标签携带目录 mode:`continuable` 或
    `one-shot`)——`Enter` 打开子代理查看器:**continuable** 子代理的
    查看器是**可交互的**——输入后续消息并回车,它会作为子代理的
    **下一回合**通过 `ctx.subagents.followup` 投递(FIFO——运行中的
    子代理不会被中断或 steer;非活跃的子代理会自动冷恢复),`Esc` 返回
    主会话。**one-shot** 子代理的查看器保持**只读**(`Esc` 返回,编辑器
    显示只读占位符)。查看器打开期间,页脚切换为**子代理自己的身份**
    (`[subagent · continuable]` 徽章、标签、activity、cwd 与子代理自己的
    turns/steps/stats),退出后恢复主会话页脚。`i` 中断选中的子代理。
    它们从不注册 job 记录,所以此浏览器是它们唯一可一览的归宿。
  - **job 行**(bash 与一次性子代理 job)——`Enter` 只显示状态查看器:
    bash job 的输出读取游标属于模型的 `job_output`,而一次性子代理 job
    记录不带子会话 id,因此子代理 job 的转录需通过 `/tasks` 按标签
    挑选子代理访问。
  只要有后台工作处于活动状态,页脚徽章就会显示
  `[N tasks running · M agents · ↓ view]`。编辑器上方的队列窗格显示
  待处理输入:用户消息为 `❯` 行,其余(任务通知、子代理汇报、注入的
  指令)为 `⏳` 通知行,超过五条折叠为 `+N more`——并在主 agent 接收
  后消失。

## 启动选项

TUI 的启动行新增了 `--preset <id>`——新会话启动时使用的 agent 预设
(回退到 `$DSH_PI_TUI_PRESET`,然后是保存的设置默认值)。它存在的原因是
`/preset` 只对空白(尚未创建)会话生效,所以启动时选择是选择预设的
另一半。其余标志都是 dsh runner 自有的(`--session <id>`,……)。

## 会话生命周期

不带 `--session` 打开 TUI **不会创建任何会话**:第一条用户消息(文本、
斜杠命令、`Ctrl+S` steer 或 `!` shell)才会惰性启动会话。`--session <id>`
仍然立即恢复会话,本地 `!!` 命令无需会话即可运行。

## 在 P0 spike 中验证过的事项

- 内置 pi-tui:fork 自带的套件在 `node --test` 下通过(每次重新
  vendor 后把它作为同步门禁运行;计数特意不抄在这里——
  `packages/pi-tui/package.json` 是版本事实的唯一来源)。
- `TuiApp` 能在 headless xterm 上渲染、接受编辑器输入并处理 Ctrl+C。
- 整个导入链(pi-tui、tui-app、`@deepseek-ai/dsh-cmdline`、commander)
  能在 tsx ESM 钩子下加载——即 dsh 源码启动契约。
- 原生修饰键扩展是可选的:在 Linux 上加载器返回 `undefined` 而不尝试
  加载,非 TTY 的 stdin 路径有守卫。

## 诊断日志

TUI 把自身诊断写到 stderr 和一个日志文件(`ctx.logger` 在此进程中不可见
——没有 exporter):

- 默认文件:`$DSH_HOME/logs/pi-tui-<pid>.log`(默认 `~/.dsh/logs/`);
- 行格式:`[tui] <ISO time> <level> <message> k=v ...`;
- 默认级别 `info`:只记录关键生命周期事件(启动/恢复/切换/退出、
  跨进程 guard 警告、错误);`debug` 额外记录每次发送前的 guard 检查。

配置(环境变量):

| 变量 | 含义 | 默认值 |
|---|---|---|
| `DSH_PI_TUI_LOG` | 日志文件路径;`off` 关闭文件日志 | `$DSH_HOME/logs/pi-tui-<pid>.log` |
| `DSH_PI_TUI_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |

排障示例:

```sh
DSH_PI_TUI_LOG_LEVEL=debug dsh --profile pi-tui
tail -f ~/.dsh/logs/pi-tui-*.log
```

## 安全与运维说明

- **每个会话只有一个界面。** dsh 没有跨进程的会话协调:一个会话同时
   在两个 dsh 进程中打开(TUI + web,或两个 TUI)会损坏其日志。TUI 会
   拒绝打开已被另一个存活 dsh 进程持有的会话(日志旁的 `owner.lock`
   文件,带 pid/starttime 探测以处理崩溃残留的陈旧锁——第二个界面在
   **打开时**就被阻止,而不是在损坏发生之后)。对于写入,TUI 会检测到
   另一个写入者并阻止发送;再次按下同一个操作(Enter 提交、Ctrl+S
   steer,草稿不变)会强制通过——编辑过的草稿、换过的按键、新的文件
   修订或会话切换都会使强制失效。绝不要在一个会话上运行两个界面
   (完整契约:`docs/concurrency.md`)。
- **会话修复。** `node_modules/@xmoon76/dsh-pi-tui/scripts/repair-session.mjs`
  修复损坏的日志(`--scan` 只读列出损坏;`--yes` 应用修复并强制备份)。
  撕裂(截断)的尾部会在最后一个完整帧处截断,并报告精确的字节核算;
  指向重复 seq 的引用绝不自动解决——修复会拒绝并要求
  `--duplicate-reference=first|last|segment`。修复后的日志在备份被认为
  多余之前,会用 dsh 读取器自身的布局检查重新验证。(完整修复契约,
  包括帧布局约束:`docs/repair-session.md`。)
- **退出。** `/exit`(`/quit` 的别名)以 10 秒硬超时刷新会话:卡死的
  提供方无法困住 TUI。如果刷新失败或超时,终端会打印警告(尾部可能
  未持久化),进程仍然退出。
- **性能。** `scripts/bench.mts`(非默认)测量摄取、投影、冷/热重建、
  流式帧、主题切换与堆;保存的基线见 `docs/perf-baseline.md`。未变化的
  转录消息会复用其渲染组件,因此热路径的每帧重建不会随历史增长。

## 许可证

MIT。`packages/pi-tui` 保留其上游 MIT 许可证与作者署名
(Copyright (c) 2025 Mario Zechner;Moonshot AI fork)。
