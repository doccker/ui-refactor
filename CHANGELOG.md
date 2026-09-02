# 更新日志

## 0.3.3

### 变更：守卫只在 UI 会话内生效，off 模式完全休眠

旧版在 off 模式（没跑 `/redesign`）下仍按 `.ai-protected-paths.txt` 拦截写入，
实战中导致其他工作流（如新功能开发）必须改受保护目录时被硬拦，
用户只能注释配置文件才能继续。本插件的价值主张是「UI 重构期间保护业务逻辑」，
不是全天候锁死仓库。

现 `.ai-protected-paths.txt` 只在两处生效：作为项目激活开关（启用统计与提示），
以及 UI 会话（`/redesign`、`/uiloop`）内的受保护路径规则。
未进入 UI 会话时不拦 edit/write/bash、不做契约差分。

UI 会话内的防护强度不变（UNKNOWN → BLOCK）。bash-guard 的 lenient 档保留但运行时不再使用。

## 0.3.2

- 修复埋点 version 停在旧值、pi_version 恒为 unknown - 委托截图前预建 scratch 目录 - 代码执行拦截提示补充合法替代路径

## 0.3.1

修复三个在真实项目实战中暴露的问题，其中两个直接架空核心防护。

### 修复（P0）：全局安装时业务契约差分 100% 失效

`pi install git:` 把扩展放在 `~/.pi/agent/git/<host>/<owner>/<repo>/`，
那里**没有 node_modules**，而 pi 本体装在 npm 全局 lib，两者不在同一条查找链上，
`import.meta.resolve("@earendil-works/pi-coding-agent")` 必然失败 → 第二层防护对
**所有全局安装的用户**永久降级，只剩路径保护。

现在按三级回退定位 pi：常规解析 → 正在运行的 pi 进程入口（argv[1] 就在包内）
→ npm/nvm/volta 全局目录。并新增「无 node_modules 临时目录」测试用例防复发
（本仓库与 CI 都恰好能解析到 pi，是这个缺陷此前从未被测试发现的原因）。

### 修复（P0）：UI 会话摘掉 bash 却没堵 MCP 的任意代码执行

`browser_run_code_unsafe`、`mcpScript` 以及 shell/exec 类 MCP 工具都能执行任意代码，
等价于绕过已摘除的 bash。实战中模型自己发现了这条路并主动放弃使用——守卫不能依赖模型自律。
现在 UI 会话内按工具名与网关参数双重拦截，普通浏览器导航/截图工具照常放行。

### 修复（P1）：截图可能拿到别的项目的页面

原实现只在 5173/1420/3000/8080 里挑第一个能连上的端口。用户机器上 1420 跑着另一个项目，
扩展就把别人的地址发给了模型。只要那个页面能渲染，就会拿**别的项目的界面**做双图比对，
生成完全错误的验收报告。

现在先从项目配置（含 monorepo 子包）解析真实端口，命中后再比对 `index.html` 的 title
确认归属；无法证实的地址不复用，实在只有它时会把「未证实」明确写进给模型的截图指令。

### 其他

- UI 会话中内容分析降级时改为 fail-closed 拦截（原来是告警后放行，与「UNKNOWN → BLOCK」冲突）
- 降级告警每会话只弹一次（实战中刷了 7 次）
- 改动全局样式文件（`styles.css` / `tailwind.config.*` 等）时提示影响面超出当前页面，只告知不拦截
- 委托截图指令要求模型把自查截图放到 `.ai/screenshots/scratch/`，避免与 `round-N.png` 混淆
- `verify.ts` 偶发失败根因修复：原先硬编码占用 5173，本机若有服务占着就随机失败
- CI actions 升级到 `@v5`（Node 20 弃用告警）
- 发布快照不再包含维护者专用脚本（`scripts/`、`tools/detect-stack.sh`），公开面只留使用者真正需要的文件

## 0.3.0

开源首发版。本版修了一个使第二层防护完全失效的回归，堆一个守卫绕过漏洞，
并新增匿名使用统计。

### 修复（P0）：pi 0.84.2+ 上业务契约差分静默失效

`edit-recon.ts` 需要 pi 内部的 `stripBom` 返回 `{ bom, text }`。
pi 0.84.2 把它从 `core/tools/edit-diff.js` 迁到了 `utils/text.js`，
导致模块加载校验失败 → 整个第二层降级 → **只剩路径保护**。
在 0.84.3 上，`verify.ts` 的 3 项“应拦截”用例全部失败。

更阴的是，迁移后的同名函数**语义也变了**：

```
旧 edit-diff.stripBom(c)  -> { bom, text }   ← 插件需要的
新 utils/text.stripBom(c) -> string          ← 同名，直接用会拿到 undefined
新 utils/text.splitBom(c) -> { bom, text }   ← 真正的对应物
```

修法：分源加载 + 双版本回退，并增加**运行时探针**实际调一次确认返回值形状。
仅检查函数存不存在是不够的——这次就是同名不同义坐实了这一点。

### 修复：`npx` 可以绕过 bash 守卫

`node x.ts` 被拦，但 `npx node x.ts` 直接放行。
现将 `npx` / `bunx` 归入解释器，并新增对 `npm exec` / `pnpm dlx` / `yarn dlx` 的拦截。

`npm run <script>` / `pnpm run` / `yarn <script>` **仍然放行**——这是显式权衡，
全封会让前端项目无法构建。README「已知边界」已写明。

同时把 README 里「最强，无法绕过」改成了诚实表述：
本插件防的是 AI 重构时“顺手”改坏业务逻辑，不是沙箱，不防恶意攻击。

### 变更：未进入 UI 会话时不再拦截日常开发命令

旧版在 off 模式（没跑 `/redesign`）下也按 UNKNOWN → BLOCK 拦 bash，
导致 `node 任何脚本` 都被拦；而 `/ui-allow-bash` 在 off 模式下又拒绝切换——
用户被拦后**无路可走**。旧行为也不自洽：拦了 node，却放行同样能写文件的 npm run。

现 off 模式只拦**能静态确定命中受保护路径**的写入
（含通配符前缀命中，如 `rm src/api/*`）；项目外写入（/tmp 等）不再拦。
进入 `/redesign` 后恢复完整的 UNKNOWN → BLOCK。

### 新增：匿名使用统计（默认开启）

只上报枚举值和数字，不上报任何来自用户项目的字符串。三道防线：
类型层联合类型、运行时 `sanitize()` 二次过滤、测试层断言 payload 无路径。

新增 `/ui-telemetry status|print|on|off`，其中 `print` 直接打印即将上报的完整内容。
完整说明见 `PRIVACY.md`。

### 新增：支持 `pi install` + 项目级激活开关

```bash
pi install git:github.com/doccker/ui-refactor   # 安装
pi -e git:github.com/doccker/ui-refactor        # 试用（不安装）
```

新增根目录 `package.json`（`pi.extensions` manifest，无任何依赖）。

配套语义变更：`.ai-protected-paths.txt` 成为**项目级激活开关**——
没跑过 `/ui-init` 的项目插件完全休眠（不拦、不发统计、不写文件）。
否则全局安装后，后端项目里 pi 连编辑自己的 `src/api/` 都会被自动探测规则硬拦。
UI 会话（`/redesign` 之后）不受影响，仍有自动探测兑底。

### 其他

- 新增 MIT LICENSE
- 新增 GitHub Actions CI（smoke + verify + 安装脚本可用性 + 隐私扫描）
- 新增 issue 模板；明确不接受外部 PR，反馈走 issue
- 自测从 46 → 84，新增项覆盖隐私红线、npx 绕过、off 模式宽松档

## 0.2.4

首次完整跑通 `/uiloop`（识别 → 改造 → 校验 → 委托截图 → 双图对比 → 收尾），
本版修的是这次跑通后暴露的体验问题。

### 修复：模型说「够了」就直接走人，用户拿不到验收结论

验收报告原本只在轮数耗尽时触发。实测模型在第 3 轮回了 `UI_LOOP_DONE` 直接结束，
而它对剩余差异的判断（chip 配色仍不同、操作列图标数量不同等）**只留在自己的思考里**，
用户什么也看不到——恰恰是用户最需要的信息。

改为：两条收尾路径都强制先产出只读验收报告。

### 修复：委托截图后临时目录没人清理

模型在日志里明确说 "left some temp artifacts in a .playwright-mcp folder that I have
no way to delete with my current tools"——因为此时 bash 已被摘除。
提示词却还要求它清理，属于要求它做办不到的事。

改为由扩展在拿到截图后自动删除 `.playwright-mcp`，提示词相应改为「临时文件不用你清理」。

### 改进：截图指令明确视口与整页策略

实测模型自行选择了 viewport 截图。现在明确要求先设 1440x900 视口，
目标区域超出一屏则用整页截图。

### 测试

- `tools/verify.ts` 39 → 47 项。新增一条**完整链路**测试：
  起本地服务占位 → 识别 → 确认 → 校验 → 委托截图 → 交图 → 双图对比 →
  `UI_LOOP_DONE` → 验收报告 → 收工，并验证临时目录被清理且截图未被误删。

## 0.2.3

首次真正跑通 `/uiloop` 全链路（Tauri + Vue 桌面应用），暴露 3 个问题，全部修复。

### 修复：委托截图的检测条件永远不成立

`useAgentCapture()` 用 `/playwright|browser/` 匹配工具名，但 MCP 适配器只注册了
一个名为 **`mcp`** 的网关工具，playwright 藏在网关后面，正则永远不命中。
结果 0.2.2 加的委托截图从未触发，仍走固定 URL 截图，截到的是首页而非目标弹窗。

改用语义信号：识别阶段模型给出的 `STEPS` 非「无」，即说明需要导航才能到达目标界面，
固定 URL 截图必然拿不到，此时委托模型截图。另加 `--capture agent|url|auto` 显式覆盖。

### 修复：--rounds 1 会完全跳过视觉对比

轮数用尽的判断在截图之后、对比之前，导致 `--rounds 1` 截完图直接结束，
一次视觉比对都不做——而视觉比对正是这条命令存在的理由。用户拿不到任何可验收信息。

改为轮数用尽时发出**只读验收报告**：模型对照参考图与实际截图列出已对齐项、
仍有差异项，并单独标出「需要新增功能才能消除」的差异。此阶段禁止改代码。

### 修复：识别阶段就摘掉 bash，导致模型只能猜文件名

实测日志中模型明确说「I don't have bash access」「can't browse directories directly,
only read specific files」，靠猜文件名定位组件。

改为**确认目标之后**才摘 bash。识别阶段本就禁止改代码，且守卫对 edit/write/bash
的路径与业务保护全程有效，保留 bash 不降低安全性。

### 新增：提示参考图中「代码里根本不存在」的能力

实测参考图包含分组、来源、端口拆分、IP 健康、搜索与筛选等当前代码没有的能力。
模型正确地拒绝了凭空添加（符合约束），但这也意味着结果永远无法与参考图一致。

识别阶段新增 `GAPS` 字段，确认弹窗后直接告知用户：这些差异属于功能开发，
不在 UI 重构范围内。

### 重构

- 抽出 `parseLoopArgs`、`finishMessage`、`buildKickoffPrompt`、`ACCEPTANCE_REPORT_PROMPT`
- 全部扩展源码回到 300 行以内

### 测试

- `tools/smoke-test.ts` 41 → 46 项（新增识别输出解析，样本取自真实运行）
- `tools/verify.ts` 37 → 39 项（新增 bash 摘除时机）

## 0.2.2

本版全部改动来自一次真实项目运行（Tauri + Vue 桌面应用）暴露的问题。

### 修复：bash 守卫两个真实误拦截

1. **`2>/dev/null` 被当成写操作**。`find ... 2>/dev/null` 这种纯只读命令被拦下，
   且因为「有写意图」而把 `find` 的只读参数当成写目标，报出「目标路径逃出项目根」。
   修复：先剥离 `2>/dev/null`、`2>&1`、`&>/dev/null` 等不写盘的重定向；
   且**重定向触发的写意图只检查重定向目标本身**，不再牵连命令的只读参数。
2. **`rmdir .playwright-mcp` 被拦**。旧的候选路径提取要求 token 含 `/` 或含文件扩展名，
   纯目录名被漏掉，导致「解析不出目标路径」而 fail-closed。
   修复：写命令的非选项操作数一律视为目标。

保护未退化：`echo x > src/api/user.ts 2>/dev/null`、`rmdir src/api`、
`sed -i ... src/api/user.ts` 仍然拦截；解释器（`python3 -c`）因内联代码无法静态分析，
改为直接拦截而非依赖路径解析。

### 修复：/uiloop 截图对单页应用无效

实测发现目标界面在侧栏点开的弹窗里，且列表需要数据才能渲染。
`npx playwright screenshot <url>` 只能加载 URL、不能点击，每轮只会截到首页，
视觉比对完全失去意义。

改为：会话中存在浏览器工具（playwright MCP 等）时，**把截图委托给模型**——
它可以导航、点击、切页签、临时注入演示数据。识别阶段新增 `STEPS:` 字段，
让模型自己说明「从首页到达该界面需要哪些操作」，截图时按此导航。

以文件是否真的落盘为准，不轻信模型口头声称的 `CAPTURE_DONE`。
提示词中明确禁止把演示数据写进源码。

### 重构

- 拆出 `ui-guard/loop-state.ts`，`loop.ts` 回到 300 行以内

### 测试

- `tools/smoke-test.ts` 34 → 41 项，新增 7 项直接取自真实运行日志里的命令

## 0.2.1

### 目标文件改为可选，由模型识别 + 用户弹窗确认

用户反馈：「我也不知道我给的截图是哪个组件」。要求用户先自己定位文件，
本身就违背了「只提供参考图 + 最后验收」的目标。

`/uiloop <参考图>` 现在可以不带目标文件：

1. 先让模型看图 + 读代码，按严格格式输出候选文件与推断路由（此阶段禁止改代码）
2. 解析候选，**逐个校验文件是否真实存在**，过滤掉模型编造的路径
3. `ctx.ui.select()` 弹窗让用户拍板，另提供「手动输入」与「取消」
4. `ctx.ui.input()` 确认页面路由
5. 确认之后才进入改造循环；用户取消则一行代码都不动

设计取舍：插件自身没有视觉能力，识别必须走模型；但**最终定哪个文件必须由用户拍板**，
避免模型认错文件后一路改错东西。

### 测试

- 新增 `ui-guard/identify.ts`
- `tools/verify.ts` 30 → 37 项，覆盖：识别阶段不改代码、编造路径被过滤、
  候选列表含手动输入与取消、确认后才发改造指令、用户取消时零改动

## 0.2.0

### /uiloop：一条命令跑完整个视觉闭环

此前要用户依次敲 `/redesign` → `/ui-check` → `/ui-screenshot` → `/ui-diff` → `/ui-end`
五条命令，且每步都要等模型回合结束再手动触发下一步，与「只提供参考图 + 最后验收」的目标相差很远。

新增 `ui-guard/loop.ts`，用 `agent_settled` 事件驱动状态机自动串起全流程：

- 校验不通过时把失败输出**回喂给模型**自行修复，而不是停下来问用户
- dev server 在整个闭环中**复用同一个实例**，不每轮重启
- 模型判定视觉达标时回复 `UI_LOOP_DONE` 结束；另有轮数上限、空转保护、
  校验反复失败上限三重兜底，避免无限循环
- `/uiloop-stop` 可随时中断

### 重构

- 抽出 `ui-guard/checks.ts`（校验逻辑）、`ui-guard/shot.ts`（截图与图片装载）、
  `ui-guard/prompts.ts`（共享约束提示词），供 `/ui-check`、`/ui-screenshot`、`/uiloop` 复用，
  消除三处重复实现

### 测试

- `tools/verify.ts` 23 → 30 项，新增闭环编排测试（含 harness 事件触发与消息载荷捕获）
- 验证首轮消息确实是 `[text, image]` 两段且 `mimeType` 正确

## 0.1.6

### 修复：Vue 事件绑定被偷换完全漏护（严重）

在真实 pi + 真实模型的端到端测试中发现：

```
@click="handleSubmit"  →  @click="handleDelete"    守卫直接放行
```

这正是需求文档第八节点名要防的场景。

根因：`extractHandlers()` 跑在**字符串已被抹平**的文本上。
Vue 的 handler 名字就写在引号里，抹平后 `@click="handleSubmit"` 与
`@click="handleDelete"` 都变成 `@click=""`，产生完全相同的指纹。
React 的 `onClick={handleSubmit}` 用花括号不受影响，所以之前的测试全部覆盖的是
React，把这个洞放过去了。

修复：

- 事件绑定提取改在保留字符串字面量的文本上进行
- 支持 `@click` / `v-on:click` / 带修饰符的 `@submit.prevent` / 单引号写法
- 新增 `v-model` 绑定目标比对（`v-model="form.name"` 改成 `form.password"` 会被拒）

### 测试

- `tools/smoke-test.ts` 29 → 34 项（新增 5 项 Vue 事件绑定）
- `tools/verify.ts` 21 → 23 项（fixture 新增 Vue SFC）
- 首次引入真实 pi 端到端验证（`pi -e ... -p`），不再只依赖 mock 的 ExtensionAPI

## 0.1.5

补上视觉闭环的最后两个人工环节。

### /ui-check 校验任务可回退

实测 6 个项目发现只有 1 个配了 `lint`，其余只有 `build`（内含 `vue-tsc -b`），
原先的实现在 5/6 的项目上会一项应用级校验都不跑。

- 新增 `ui-guard/project.ts`：包管理器按 lockfile 识别（之前写死 `npm`），
  yarn 不再多传 `run`；校验任务在 typecheck/lint/test 全缺时回退到 `build`。

### /ui-screenshot 自动拉起 dev server

- 新增 `ui-guard/dev-server.ts`。不用 `pi.exec()`（它会一直等到进程退出，
  而 dev server 不会退出），改用 `spawn` 并解析它打印的本地地址。
- 端口不猜：实测 Tauri 项目跑在 **1420**，不在任何常见预设端口里，
  证明解析 stdout 而非探测固定端口是必需的。
- 已在跑的服务会被复用且**不会被关掉**；只关插件自己拉起的。
- 传完整 URL 时完全不启动任何进程。

### Playwright 浏览器缺失的处理

实测发现 Playwright CLI 已装但浏览器未下载时，原生报错是一大坨 ASCII 框，
在 notify 里基本不可读。现在会识别该情况并弹窗询问是否执行
`npx playwright install chromium`，安装后自动重试。

### 测试

- `tools/smoke-test.ts` 21 → 29 项

## 0.1.4

从「靠写死默认值的插件」改为「丢进任意前端仓库都能用的通用插件」。

### 新增

- **受保护路径自动探测**（`ui-guard/detect.ts`）。扫真实目录树，同时适配
  React / Vue 单仓与 pnpm monorepo。`/ui-init` 生成配置，未配置时运行时自动探测。
- `/ui-init --force` 重新探测并覆盖配置
- `tools/verify.ts` 端到端验证（加载守卫本体 + 模拟真实 `tool_call` 事件流，21 项）

### 修正（均为在 6 个真实项目上跑探测时发现的误报）

- **页面目录被当成业务目录锁死**。`src/views/models/`（全是 `.vue` 页面组件）、
  `src/views/auth/`（`Login.vue` / `Register.vue`）、`src/components/auth/`（登录表单）
  全部被误判为业务目录，导致这些页面永远无法重构。
  修为按目录**直接子文件**的 UI/业务成分分类，并继续下探以锁住嵌套的
  `src/views/auth/composables/`。
- **文件名子串匹配误包**。`asset-loader.ts` 因含 `sse` 被锁。
  改为按分隔符 + 驼峰拆 token 后整词匹配。
- **UI 区域内的文件被误锁**。`useApiKeyDisplay.ts`、`useRequestListState.ts`
  这类页面文件被包。改为 `views/` `pages/` `components/` 内不做文件级保护。
- **扇平业务文件漏护**。monorepo 里的 `apps/web/src/api.ts` 是文件而非目录，此前完全漏掉。
- `install-project.sh` 对「目标就是本仓库」给出可操作提示，并在输出中明确
  `/ui-init` 是 pi 交互界面内的命令而非 shell 命令。

## 0.1.3

首个包含实际源码的版本。0.1.0 - 0.1.2 只有文档，`.pi/extensions/redesign-guard.ts`
与 `.ai-protected-paths.txt.example` 从未存在，`install-project.sh` 必然失败。

### 新增

- 实现全部源码：入口 `redesign-guard.ts` + `ui-guard/` 七个模块
- **新增 bash 拦截**。pi 0.84.1 能写文件的内置工具有三个（`edit` / `write` / `bash`），
  此前设计完全没有覆盖 `bash`，`sed -i`、输出重定向、`git checkout`、解释器均可绕过全部防护。
  采用双档策略：默认摘除 `bash`，`/ui-allow-bash` 后切换到逐条命令扫描。
- 新增 `/ui-allow-bash`、`/ui-end` 命令
- 新增 `tools/smoke-test.ts` 自测（21 项）与 `tools/detect-stack.sh` 技术栈探测

### 修正

- **修正 `ImageContent` 结构**。真实定义是 `{ type, data, mimeType }`，
  而非 `docs/extensions.md` 示例中的 `{ source: { type, mediaType, data } }`。
  按文档写会导致参考图被静默丢弃，视觉闭环从第一步就断掉。
- **改为复用 Pi 内部 `edit-diff`** 推演编辑结果，不再自研重建。
  自研实现会在 BOM / CRLF / fuzzy 三种场景与 Pi 实际落盘结果不一致，
  其中 CRLF 会导致该文件每次编辑都被误拦截。
- **修正路径匹配**。改用 `resolve` + `relative` + 目录边界比对，
  替代官方示例的 `path.includes()`（会让 `src/api` 误伤 `src/apiv2`，也挡不住绝对路径）。
  补充 symlink 解析与大小写不敏感处理。
- **重写业务风险判定**。从关键字启发式改为业务契约指纹差分
  （import / 函数调用 / 事件绑定 / await），大幅降低误报，避免用户被训练成无脑确认。
- `install-project.sh` 增加安装前完整性预检，避免留下空的 `.pi/extensions` 目录误导用户。
- 文档全面改为简体中文。

### 移除的失效描述

0.1.1 / 0.1.2 changelog 中关于「legacy `oldText`/`newText` 兼容」和「`write` 的 `content` 类型校验」
的描述在 pi 0.84.1 上属于死代码：`prepareArguments` 与 typebox schema 校验都在 `beforeToolCall`
之前完成（`pi-agent-core/dist/agent-loop.js:393-406`），扩展拿到的 `input` 必然已规范化且通过校验。
相关防御作为纵深防御保留，但不再作为卖点描述。

## 0.1.2 / 0.1.1 / 0.1.0

仅文档，无源码实现。
