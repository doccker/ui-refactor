# 隐私说明

pi-ui-refactor 默认开启匿名使用统计。本文列出**全部**收集内容。

一句话：**只上报枚举值和数字，不上报任何来自你项目的字符串。**

---

## 为什么要格外认真对待这件事

这个插件的工作位置决定了它能看到：文件路径、bash 命令原文、代码 diff、
受保护路径清单、页面截图、发给模型的 prompt。

而它的定位是「保护你的代码不被误改」的安全工具。
如果它自己把你的代码信息传出去，这个产品就没有存在的意义了。

所以代码里做了三道防线，你可以自己去看：

| 防线 | 位置 | 作用 |
|---|---|---|
| 类型层 | `.pi/extensions/ui-guard/telemetry.ts` 的 `TelemetryEvent` | 联合类型，字段只允许枚举 / 数字 / 布尔 |
| 运行时层 | 同文件的 `sanitize()` | 二次过滤，凡是不像枚举的字符串一律丢弃 |
| 测试层 | `tools/smoke-test.ts` | 断言上报体不含路径、工作目录、主机名 |

只靠类型层是不够的——任何人加一个 string 字段就会破防，所以有第二层。

---

## 收集什么

一共 9 个事件。这就是全部。

| 事件 | 何时发生 | 携带的字段 |
|---|---|---|
| `session_start` | pi 启动加载插件 | 契约分析是否可用（布尔） |
| `stack_detected` | `/ui-init` | 技术栈（`vue`/`react`/`svelte`/`angular`/`other`/`unknown`）、是否 monorepo、受保护规则**条数**、探测**耗时毫秒** |
| `command_used` | 执行任一命令 | 命令名（固定 12 个之一） |
| `guard_blocked` | 发生拦截 | 拦截类型（`path`/`bash`/`contract`/`recon_fail`） |
| `contract_decision` | 业务契约确认框 | 你的选择（`allow`/`deny`/`no_ui_block`）、触发原因**条数** |
| `check_done` | `/ui-check` | 是否通过、受保护文件命中**数**、失败任务**数**、**耗时毫秒** |
| `loop_progress` | `/uiloop` | 阶段名（固定枚举）、是否成功 |
| `degraded` | 插件能力降级 | 降级原因（固定枚举） |
| `session_end` | `/ui-end` | 改动文件**数**、风险**条数**、会话**时长毫秒** |

每条事件还附带：插件版本、pi 版本、操作系统（`darwin`/`linux`/`win32`）、Node 大版本号。

---

## 不收集什么

以下内容**在代码层面就不可能被上报**：

- ❌ 文件路径、文件名、目录名
- ❌ 代码内容、diff、`oldText`/`newText`
- ❌ bash 命令原文
- ❌ `.ai-protected-paths.txt` 的内容（这等于你的项目架构图）
- ❌ 项目名、仓库名、git remote、当前工作目录
- ❌ 截图、参考设计图
- ❌ 发给模型的 prompt、模型的回复
- ❌ 主机名、MAC 地址、IP、用户名
- ❌ 任何形式的路径 hash（可被反查，所以也不用）

---

## 身份标识

两个随机 UUID，都由 `crypto.randomUUID()` 生成，与你的机器信息无关：

- `~/.pi-ui-refactor/id` —— 机器级，用于统计有多少人在用
- `<项目>/.ai/telemetry-id` —— 项目级，用于统计有多少项目在用（`.ai/` 已在 gitignore 中）

删掉这两个文件，你就是一个全新的匿名用户。

---

## 怎么关

任选一种，都是永久生效：

```bash
# 方式一：插件命令（写入 ~/.pi-ui-refactor/optout）
/ui-telemetry off

# 方式二：环境变量
export PI_UI_REFACTOR_TELEMETRY=0

# 方式三：通用约定，本插件无条件尊重
export DO_NOT_TRACK=1
```

此外，检测到 `CI=true` 时自动关闭，无需配置。

---

## 怎么自己验证

不用相信这份文档，直接看：

```bash
# 看即将上报的完整内容（原样打印，没有省略）
/ui-telemetry print

# 看当前开关状态
/ui-telemetry status
```

或者抓包，或者直接读 `telemetry.ts`——全部 200 多行，没有混淆。

---

## 数据存在哪、谁能看到

上报数据存储在第三方统计服务（PostHog）的美国区服务器，
端点 `us.i.posthog.com` 在 `telemetry.ts` 中可见。只有维护者能查看聚合数据，
本项目不出售、不共享这些数据。

`telemetry.ts` 里硬编码的 `phc_` 开头字符串**不是泄露的密钥**：
它是只写（write-only）凭据，按设计允许公开，无法用它读取任何已收集的数据。
安全扫描工具若对它报警，属于误报。

---

## 有疑问

发现本文档与实际行为不符，请开 issue，这属于最高优先级问题。
