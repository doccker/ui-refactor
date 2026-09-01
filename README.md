# pi-ui-refactor

[![CI](https://github.com/doccker/ui-refactor/actions/workflows/ci.yml/badge.svg)](https://github.com/doccker/ui-refactor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**让 AI 放开手改前端 UI，同时守住业务逻辑一行不被偷改。**

> 📊 本插件默认开启匿名使用统计，只上报枚举值和数字，
> 不收集任何文件路径、代码内容、命令原文或截图。
> `/ui-telemetry print` 可查看完整上报内容，`/ui-telemetry off` 永久关闭。详见 [PRIVACY.md](PRIVACY.md)。

---

## 解决什么问题

给 AI 一张设计图让它重构页面，最怕的不是改得丑——丑看得出来。
怕的是它"顺手"把 `onClick={handleSubmit}` 换成 `handleDelete`、
悄悄改了 `src/api/` 里的请求逻辑，上线才发现。

本插件是 [pi Coding Agent](https://github.com/earendil-works/pi-mono) 的守卫扩展 + UI 重构工作流：

- **拦截**：`edit` / `write` / `bash` 三个写入口全覆盖。受保护路径硬拦截；
  业务契约（import / 函数调用 / 事件绑定 / await）发生变化时弹确认，拿不准一律拦
- **闭环**：一条命令从「识别目标文件」到「与参考图视觉比对」全自动循环，
  改不好就继续改，直到接近参考图
- **不越权**：未进入 UI 重构会话时不干扰日常开发；
  守卫永不执行 `git reset` / `git checkout`，不替你丢弃任何代码

---

## 安装

```bash
pi install git:github.com/doccker/ui-refactor
```

试用（不安装，仅当前运行生效）：

```bash
pi -e git:github.com/doccker/ui-refactor
```

装完**不会干扰任何项目**：插件在没跑过 `/ui-init` 的项目里完全休眠，
不拦命令、不发统计、不写文件。在哪个项目跑 `/ui-init`，就在哪个项目激活。

<details><summary>不想全局安装？也可以把源码拷进单个项目</summary>

```bash
git clone --depth 1 https://github.com/doccker/ui-refactor.git
bash ui-refactor/install-project.sh /path/to/你的前端项目
```

只拷贝 `.ts` 源码到项目的 `.pi/extensions/`，零 npm 依赖，删目录即卸载。

</details>

### 上手四步

> `/` 开头的都是 **pi 交互界面内的命令**，不是 shell 命令。

```
cd 你的前端项目 && pi        # 已在运行的话，执行 /reload
/ui-init                     # 激活本项目：自动扫描生成受保护路径，核对 .ai-protected-paths.txt
/ui-check                    # 建立基线（受保护文件 + 类型 + lint + 测试）
/uiloop /path/to/参考图.png   # 开始重构
```

- 首次截图前需要：`npx playwright install chromium`
- 建议第一次在**一次性分支**上拿小组件试守卫：故意让 AI 改一行业务代码，确认被拦截

---

## 命令

| 命令 | 说明 |
|---|---|
| `/uiloop <参考图> [目标文件]` | **全自动闭环**：识别目标 → 改 UI → 校验 → 截图 → 视觉比对 → 继续改 |
| `/uiloop-stop` | 中途停止闭环 |
| `/redesign <参考图> <源文件>` | 单步：按参考图重构 UI（不自动循环） |
| `/uxpolish <源文件>` | 打磨交互细节（hover / 加载态 / 空态 / 响应式 / 可访问性） |
| `/ui-init` | 初始化受保护路径配置（`--force` 重新探测） |
| `/ui-check` | 只读校验：受保护文件 + TypeScript + ESLint + 测试 |
| `/ui-status` | 查看守卫模式、受保护路径、本次会话风险记录 |
| `/ui-screenshot [路径] [名称]` | 截图，自动拉起并关闭 dev server |
| `/ui-diff <参考图> <截图>` | 逐项比较两张图的视觉差异 |
| `/ui-allow-bash` | UI 会话中临时放行 bash（逐条扫描） |
| `/ui-end` | 结束 UI 会话，恢复工具集 |
| `/ui-telemetry` | 查看/关闭匿名使用统计（`status` / `print` / `on` / `off`） |

`/uiloop` 只给一张参考图即可——插件会让模型看图读代码给出候选文件，
**你确认之前不会改任何代码**；已知目标文件时直接作为第二个参数传入。

---

## 受保护路径

`/ui-init` 自动探测业务目录（`api` / `stores` / `router` / `composables` 等）
生成 `.ai-protected-paths.txt`，一行一条规则，`/` 结尾表示目录。

- 按**路径边界**匹配，`src/api/` 不会误伤 `src/apiv2/`
- 该文件存在时完全以它为准；修改后无需重启，下一次工具调用即生效

---

## 边界（诚实声明）

- 业务契约差分是**启发式**，不是语义证明。路径硬拦截才是最强的一层，合并前请看 `git diff`
- 没跑过 `/ui-init` 的项目插件**完全休眠**；初始化后，**未进入 UI 会话时**也只拦确定命中受保护路径的写入，`node build.js` 这类日常命令不拦
- UI 会话内 `npx` / `bunx` / `pnpm dlx` / `yarn dlx` / `npm exec` 一律拦截，
  但 `npm run <script>` 放行——否则项目没法构建，这是显式权衡
- UI 会话内同时拦截 **MCP 侧的任意代码执行入口**（`*run_code_unsafe*`、`mcpScript`、
  shell/exec 类 MCP 工具，含经网关转发）——否则摘掉 bash 等于留后门。
  普通浏览器导航/截图工具放行，视觉闭环不受影响
- 但这仍然是黑名单：新出现的、名字不在模式里的代码执行类 MCP 工具可能滑过。
  **本插件防的是 AI 重构时“顺手”改坏业务逻辑，不是沙箱，不防恶意攻击**

---

## 反馈

本仓库**只接受 issue，不接受外部 PR**——守卫逻辑的任何改动都可能直接变成
别人的业务代码被静默改掉，代码入口保持单一维护。

有问题或想法请开 [issue](../../issues/new/choose)。**漏拦截（改了业务逻辑却没拦住）优先级最高。**
提 issue 时请勿粘贴你的业务代码，文件路径用 `src/xxx/Foo.vue` 占位即可。

## License

[MIT](LICENSE)
