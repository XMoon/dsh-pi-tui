# dsh-pi-tui tmux 实测指南

## 定位:什么时候用 tmux,什么时候用 headless

**常规开发与回归一律用 headless 测试**(`packages/dsh-pi-tui/test/`,
`@xterm/headless` 虚拟终端驱动真实渲染与按键路由):快、确定性、无 TTY/模型
依赖,CI 可跑。功能改动必须先在 headless 覆盖。

**tmux 实测只用于 headless 覆盖不到的补充验证**,典型场景:

| 场景 | 为什么需要 tmux |
|---|---|
| 主题/颜色观感 | 调色板实际观感、切换前后对比(headless 能断言色值,看不出"好不好看") |
| 真实 dsh 服务端到端 | 模型会话、`ctx.jobs` 后台任务、preset 组合、tool-jobs 完成通知、subagent 真实行为 |
| 交互"人感" | 键盘节奏、模态叠层、ghost overlay 这类时序/焦点问题(headless 难捕捉) |

规则:tmux 是**补充**,不替代 headless;发现问题后回到 headless 补回归测试。

## 环境准备

- 需要 tmux;`dsh --profile pi-tui-dev`(link 依赖本仓库,`pnpm build` 后即时生效)。
- **本机环境带 `NO_COLOR=1`**:主题自动检测的 opt-out 守卫会跳过检测,
  启动时用 `env -u NO_COLOR` 包一层。
- 模型端到端需要 `~/.dsh/settings.yaml` 里 agent-default-model 的凭据可用
  (本机 opencode-go/deepseek-v4-flash 已配置)。

## 基础操作流程

```sh
tmux kill-session -t demo 2>/dev/null
tmux new-session -d -s demo -x 110 -y 34            # 大一点,看得清楚

# 启动(注意:先 send-keys -l 发字符串,sleep 后再 Enter)
tmux send-keys -t demo -l "env -u NO_COLOR dsh --profile pi-tui-dev"
sleep 0.3
tmux send-keys -t demo Enter
sleep 5                                            # 等启动

# 捕获:纯文本与带色 ANSI 各一份
tmux capture-pane -t demo -p > /tmp/pane.txt
tmux capture-pane -t demo -e -p > /tmp/pane.ansi

# 输入命令:同样分两步(见 PasteBurst 坑)
tmux send-keys -t demo -l "/settings"
sleep 0.4
tmux send-keys -t demo Enter

tmux kill-session -t demo 2>/dev/null              # 收尾
```

## 主题颜色验证

把 ANSI 捕获转成 HTML 在浏览器里看颜色:

```sh
node docs/tmux/ansi2html.mjs /tmp/pane.ansi /tmp/pane.html "阶段名"
```

调色板核对值(dark / light):

| token | dark | light |
|---|---|---|
| border | `#5A5A5A` | `#737373` |
| textDim | `#888888` | `#454545` |
| textMuted | `#6B6B6B` | `#5F5F5F` |
| success | `#4EC87E` | `#0E7A38` |

检测链验证(批次 E):`COLORFGBG='15;0'`(深色)/ `'0;15'`(浅色)启动,看是否
自动切换;`/settings` 面板里 Theme 行 `auto → dark → light` 循环切换
(打开面板后先 `Down` 把光标从 Default permission 移到 Theme 行)。
切换后**等 ≥1.5s 再 capture**(面板重绘跟随输入,抓早了看到的是旧值)。

完整主题演示流程(深色启动 → 浅色自动检测 → UI 切换 → 持久化重启):
`bash docs/tmux/tui-demo.sh`,产物在 `/tmp/tui-demo/`(`.txt` 纯文本 +
`.html` 带色)。

## 真实模型端到端(后台任务、subagent、守卫)

1. 启动 TUI,发一条消息创建会话(第一条消息触发 deferred session creation;
   可先发 `Reply with exactly: pong` 验证连通)。
2. **后台 bash job**:让模型执行
   `Run this in the background: sleep 20 && echo slow-done. Use the bash tool with run_in_background=true, do not wait.`
   验证:dock `⏳ bash-1 · …` 行、footer `[N tasks running · ↓ view]` 徽章、
   运行中 `↓` 弹任务浏览器、Enter 输出查看器、完成通知被模型自动处理。
3. **子代理查看与提交守卫**:`/subagents` → 选子代理 → View transcript →
   进入只读查看模式(`ℹ viewing subagent … — Esc returns`);查看中输入 + Enter
   应被拦截(`ℹ viewing a subagent — Esc returns before submitting`),草稿保留;
   Esc 返回。
4. 结束用 `/exit` 走 flush 流程,再 `tmux kill-session`。

注意:模型是否把 subagent 注册进 jobs registry 取决于它传不传
`run_in_background: true`(本机实测两次都走了 continuable 模式),因此任务
浏览器里的 subagent 条目不可控——TUI 侧该分支由 headless 覆盖。

## 踩坑清单(全部实测踩过)

1. **PasteBurst 把 Enter 变换行**:`send-keys 'text' Enter` 批量输入会被编辑
   器的粘贴启发式(≥8 字符/8ms)当作粘贴,Enter 被抑制 120ms。必须
   `send-keys -l 'text'` → `sleep 0.3+` → `send-keys Enter`。
2. **zsh 的 `;` 是命令分隔**:`COLORFGBG=15;0 dsh …` 会执行 `0`。env 赋值要
   带引号 `COLORFGBG='15;0' dsh …`,且脚本里外层引号别与内层冲突(用双引号
   包整体)。
3. **`NO_COLOR=1` 跳过主题检测**:本机 shell 环境自带;演示检测链时用
   `env -u NO_COLOR`。
4. **面板重绘跟随输入**:设置面板改值后立即 capture 会看到旧值;等 ≥1.5s。
5. **模型行为不可控**:沙箱审批弹窗、ask_user_question 对话框会在演示中途
   出现,按键序列会被打断——用 capture 确认当前状态再继续,必要时
   `n` 拒绝审批、回答完问题再走下一步。
6. **ghost overlay(已修,仍要留意)**:`/subagents` 动作后若输入被某个
   SettingsList 搜索框吃掉,说明有 overlay 没关(当前版本动作后自动关闭);
   `Esc` 逐层清理。
7. 演示会写 `~/.dsh/settings.yaml`(theme/permission),结束后记得恢复
   (`theme: auto`、`defaultPreset: workspace-write`)。

## 脚本

- `docs/tmux/ansi2html.mjs` — ANSI 捕获 → 带色 HTML(`node … <in> <out> [title]`)。
- `docs/tmux/tui-demo.sh` — 主题演示全流程(深色 → 浅色 COLORFGBG 检测 →
  UI 切换 → 持久化主题重启 → 恢复设置)。
