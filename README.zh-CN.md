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
`packages/pi-tui/` 是 `@moonshot-ai/pi-tui` 的内置 fork(重命名为
`@xmoon76/pi-tui`,私有,永不发布——其分叉修改清单见
`packages/pi-tui/AGENTS.md`),`packages/dsh-pi-tui/` 是 dsh 包
(`@xmoon76/dsh-pi-tui`,唯一发布的包),构建时把 fork 打进自己的产物。

## 前置要求

- 一个支持 profile 的 DeepSeek Harness 安装(`dsh` 已在 `PATH` 中)。
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
pnpm build        # pi-tui tsdown (dist/) + dsh-pi-tui tsdown (dist/, 打入 pi-tui)

# file: — 添加时把包复制进 profile;重新构建后需重新 add 以刷新
#(见下方"更新 / 卸载")
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD/packages/dsh-pi-tui

# link: — 使用实时符号链接;`pnpm build` 的产物会被直接读取
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@link:$PWD/packages/dsh-pi-tui
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
pnpm build && dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD/packages/dsh-pi-tui

dsh plugin --profile pi-tui -- remove @xmoon76/dsh-pi-tui
```

## 开发

```sh
pnpm install
pnpm build        # pi-tui tsdown (dist/) + dsh-pi-tui tsdown (dist/, 打入 pi-tui)
pnpm test         # pi-tui 自带套件 (node --test) + dsh-pi-tui 无头测试
pnpm typecheck
node --expose-gc packages/dsh-pi-tui/scripts/bench.mts   # 性能基线(可选)
```

测试通过 `@xterm/headless` 驱动 UI(见
`packages/dsh-pi-tui/test/virtual-terminal.ts`),因此无需 TTY 或模型连接
即可验证渲染与输入路由。

### 开发历史(dogfooding)

本项目最初在浏览器界面(`dsh --profile web`)上开发,后来转为用自己开发
自己:自 2026 年 8 月 15 日起,所有修复与功能都在这个 TUI 内部完成,就像
本 README 与代码库的维护一样。开发循环运行在专用的 `pi-tui-dev`
profile 上,使用方式 B 的 `link:` 说明符安装
(`dsh plugin --profile pi-tui-dev -- add @xmoon76/dsh-pi-tui@link:$PWD/packages/dsh-pi-tui`)
——实时符号链接,`pnpm build` 后无需重新 add 即可生效——而 `pi-tui`
profile 保持安装已发布的 registry 包用于真实使用。

## 斜杠命令(节选)

- `/sessions [query]` — 打开会话选择器:对会话 id、标题和工作区进行
  边输入边搜索,行按工作区分组并实时显示 `filtered/total` 计数,标题在
  后台按需加载。回车切换到所选会话。
- `/search <query>` — 在持久化的会话日志中全文搜索,然后跳转到命中项。
- `/title [title]` / `/rename [title]` — 带参数时设置当前会话的标题
  (固定标题,防止自动生成;标题会出现在 `/sessions` 选择器中);
  **不带参数时根据对话重新生成标题——这会覆盖当前标题,包括你之前
  固定的标题**。
- `/yolo` — 切换到 `danger-full-access`(`/permission danger-full-access`
  的别名)。
- `/queue` — 逐条管理队列:编辑、删除、单条 steer,或向 agent 的 inbox
  插入消息(编辑器上方的队列窗格显示待处理消息;`Ctrl+S` 一次性全部
  steer,`Alt+↑` 把全部消息拉回编辑器)。
- `/status` — 显示当前会话的统计与身份信息(回合数、token 用量、
  工作区、已安装的 dsh 版本)。
- `/preset`、`/model`、`/settings`、`/export`、`/fork`、`/subagents` —
  见 `dsh --profile pi-tui` 的命令自动补全(`/` + Tab)。

## 快捷键(节选)

- `Ctrl+F` — 切换转录搜索(`/search <query>` 覆盖层;再按一次关闭)。
- `Shift+Tab` — 循环切换权限预设(read-only → workspace-write →
  danger-full-access);页脚的模式槽位会为每个预设显示徽章
  (`[workspace-write]` / `[read-only]` / `[custom]`,`[yolo]` 标记免审批
  模式)。
- `Ctrl+S` — steer:有排队消息时,把整个队列(加上草稿,若有)一次性
  送入正在运行的回合;否则只发送草稿。空闲的 agent 会用全部内容开启
  新回合。
- `Alt+↑` — 出队:把所有排队消息拉回编辑器草稿。
- `Ctrl+T` — 切换完整待办列表;编辑器上方的 dock 始终显示待办摘要与
  后台任务,排队的输入渲染在两者之间。
- `@` — 编辑器中的文件/文件夹提及:`@` + Tab 从整个工作区补全文件
  (`fd` 在 PATH 上时以其为后端,否则使用内置的递归回退)。字面
  `@path` 会被提交,由模型自行读取文件。有后台工作时,空编辑器的 `↓`
  或 `Ctrl+J` 会打开覆盖两种表面的任务浏览器:
  - **子代理行**(可继续的实时子任务)——`Enter` 以只读方式打开子代理
    的转录(`Esc` 返回);它们从不注册 job 记录,所以此浏览器是它们唯一
    可一览的归宿。
  - **job 行**(bash 与一次性子代理 job)——`Enter` 只显示状态查看器:
    bash job 的输出读取游标属于模型的 `job_output`,而一次性子代理 job
    记录不带子会话 id,因此转录需通过 `/subagents` 访问(`s` 停止 job)。
  只要有后台工作处于活动状态,页脚徽章就会显示
  `[N tasks running · M agents · ↓ view]`。

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
