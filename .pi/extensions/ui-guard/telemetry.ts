/**
 * PostHog 匿名使用统计。
 *
 * ============ 红线 ============
 * 本插件天然能看到用户的私有代码：文件路径、bash 命令原文、代码 diff、
 * 受保护路径清单、页面截图、模型 prompt。任何一项外传都是安全事故，
 * 而本产品卖的就是「安全守卫」，一旦被发现回传代码信息，项目直接失去存在意义。
 *
 * 因此这里做了三道防线：
 *   1. 类型层：TelemetryEvent 是联合类型，properties 只允许枚举 / number / boolean
 *   2. 运行时层：sanitize() 二次过滤，凡是不像枚举的字符串一律丢弃
 *      （路径含 `/`、命令含空格与大写，都会被这一层挡掉）
 *   3. 测试层：smoke-test 断言 payload 不含路径与命令原文
 *
 * 只靠第 1 层是不够的——以后任何人加一个 string 字段就会破防。
 *
 * ============ 可用性 ============
 * 上报挂在 tool_call 这条「每次写文件都走」的路径附近，因此：
 * fire-and-forget、2 秒硬超时、失败静默、全程 try/catch。
 * PostHog 挂了、断网了、DNS 坏了，守卫都必须照常工作。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 与 README / CHANGELOG / install-project.sh 保持一致 */
export const PLUGIN_VERSION = "0.3.0";

const HOST = "https://us.i.posthog.com";
/** Project API Key（write-only，PostHog 设计上允许公开，可硬编码） */
const DEFAULT_KEY = "phc_CN9rmw25QuN8iYRFXtYbigQSrxy2aKnmJSU4sDDdGXj5";
const CONFIG_DIR = join(homedir(), ".pi-ui-refactor");
const ID_FILE = join(CONFIG_DIR, "id");
const OPTOUT_FILE = join(CONFIG_DIR, "optout");
const NOTICE_FILE = join(CONFIG_DIR, "notice-seen");
const TIMEOUT_MS = 2000;
const MAX_QUEUE = 20;

// ---------------- 事件白名单 ----------------

export type StackKind = "vue" | "react" | "svelte" | "angular" | "other" | "unknown";
export type CommandName =
	| "ui-init"
	| "ui-status"
	| "ui-check"
	| "ui-allow-bash"
	| "ui-end"
	| "redesign"
	| "uxpolish"
	| "ui-screenshot"
	| "ui-diff"
	| "uiloop"
	| "uiloop-stop"
	| "ui-telemetry";
export type BlockKind = "path" | "bash" | "contract" | "recon_fail";
export type DegradeReason = "edit_diff_missing" | "edit_diff_shape_changed";

/**
 * 所有可上报事件。properties 只允许枚举 / number / boolean。
 * 新增事件时请自问：这个字段会不会因为用户项目不同而变成任意字符串？
 * 会的话就不能加。
 */
export type TelemetryEvent =
	| { name: "session_start"; recon_ready: boolean }
	| {
			name: "stack_detected";
			stack: StackKind;
			is_monorepo: boolean;
			protected_count: number;
			detect_ms: number;
	  }
	| { name: "command_used"; cmd: CommandName }
	| { name: "guard_blocked"; kind: BlockKind }
	| { name: "contract_decision"; decision: "allow" | "deny" | "no_ui_block"; reason_count: number }
	| { name: "check_done"; passed: boolean; protected_hits: number; failure_count: number; duration_ms: number }
	| { name: "loop_progress"; step: "identify" | "revise" | "check" | "shot" | "diff" | "done"; ok: boolean }
	| { name: "degraded"; reason: DegradeReason }
	| { name: "session_end"; touched_count: number; risk_count: number; duration_ms: number };

// ---------------- 运行时消毒 ----------------

/** 枚举值的样子：短、全小写、只含字母数字和 _ -。路径/命令/中文都过不了。
 *
 * 注意这里**故意不允许小数点**：一旦允许 `.`，`user.ts` 这类
 * 不带目录的文件名就会整个滑过去。版本号请先过 normVersion()。 */
const ENUM_RE = /^[a-z0-9_-]{1,32}$/;

/** 标准 UUID v4。id 类字段走这个，而不是把 ENUM_RE 的长度限制放宽到 36——
 *  放宽长度是在削弱通用防线，开一个专用口子才是对的。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isAnonymousId(v: string): boolean {
	return UUID_RE.test(v);
}

/** 0.84.3 -> 0_84_3。不为了版本号去放宽 ENUM_RE，宁可牺牲一点可读性 */
export function normVersion(v: string): string {
	return v
		.toLowerCase()
		.replace(/[^0-9a-z]+/g, "_")
		.slice(0, 32);
}

/**
 * 第二道防线。即使类型被绕过，也只让「看起来像枚举」的字符串通过。
 * 非有限数字一并丢弃（NaN / Infinity 会让 JSON 变成 null）。
 */
export function sanitize(props: Record<string, unknown>): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	for (const [k, v] of Object.entries(props)) {
		if (typeof v === "boolean") {
			out[k] = v;
		} else if (typeof v === "number" && Number.isFinite(v)) {
			out[k] = v;
		} else if (typeof v === "string" && ENUM_RE.test(v)) {
			out[k] = v;
		}
		// 其余一律丢弃，不记录、不报错
	}
	return out;
}

// ---------------- 开关 ----------------

async function exists(p: string): Promise<boolean> {
	try {
		await readFile(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * 是否启用。优先级从高到低：
 *   1. PI_UI_REFACTOR_TELEMETRY=0/false  显式关闭
 *   2. 本地持久化 opt-out（/ui-telemetry off）
 *   3. DO_NOT_TRACK=1                     通用约定，无条件尊重
 *   4. CI=true                            CI 环境不统计
 *   5. 默认开启
 */
export async function isEnabled(): Promise<boolean> {
	const flag = process.env.PI_UI_REFACTOR_TELEMETRY;
	if (flag === "0" || flag === "false" || flag === "no") {
		return false;
	}
	if (flag === "1" || flag === "true" || flag === "yes") {
		return true;
	}
	const dnt = process.env.DO_NOT_TRACK;
	if (dnt && dnt !== "0" && dnt !== "false") {
		return false;
	}
	if (process.env.CI && process.env.CI !== "false") {
		return false;
	}
	return !(await exists(OPTOUT_FILE));
}

export async function setOptOut(off: boolean): Promise<void> {
	try {
		await mkdir(CONFIG_DIR, { recursive: true });
		if (off) {
			await writeFile(OPTOUT_FILE, "1\n", "utf-8");
		} else {
			const { unlink } = await import("node:fs/promises");
			await unlink(OPTOUT_FILE).catch(() => {});
		}
	} catch {
		// 配置目录不可写时静默失败，不影响守卫
	}
}

// ---------------- 匿名标识 ----------------

/**
 * 机器级随机 UUID（统计人数）。
 * 刻意不用 hostname / MAC / cwd 路径 hash —— 路径 hash 可被反查。
 */
export async function getMachineId(): Promise<string> {
	try {
		const existing = (await readFile(ID_FILE, "utf-8")).trim();
		if (existing.length > 0) {
			return existing;
		}
	} catch {
		// 首次运行
	}
	const id = randomUUID();
	try {
		await mkdir(CONFIG_DIR, { recursive: true });
		await writeFile(ID_FILE, `${id}\n`, "utf-8");
	} catch {
		// 写不进去就每次新生成，不影响功能
	}
	return id;
}

/** 项目级随机 UUID（统计项目数），存在 .ai/ 下，已被 gitignore */
export async function getProjectId(cwd: string): Promise<string> {
	const file = join(cwd, ".ai", "telemetry-id");
	try {
		const existing = (await readFile(file, "utf-8")).trim();
		if (existing.length > 0) {
			return existing;
		}
	} catch {
		// 首次运行
	}
	const id = randomUUID();
	try {
		await mkdir(join(cwd, ".ai"), { recursive: true });
		await writeFile(file, `${id}\n`, "utf-8");
	} catch {
		// 忽略
	}
	return id;
}

// ---------------- 队列与上报 ----------------

interface Payload {
	event: string;
	distinct_id: string;
	properties: Record<string, string | number | boolean>;
	timestamp: string;
}

export interface Telemetry {
	track(event: TelemetryEvent): void;
	flush(): Promise<void>;
	/** 供 /ui-telemetry print 使用：返回当前待发送内容的可读形式 */
	pending(): Payload[];
}

export interface TelemetryInit {
	cwd: string;
	version: string;
	piVersion: string;
}

/** 关闭状态下的空实现，保证调用方无需判空 */
export const NOOP: Telemetry = {
	track: () => {},
	flush: async () => {},
	pending: () => [],
};

export async function createTelemetry(init: TelemetryInit): Promise<Telemetry> {
	if (!(await isEnabled())) {
		return NOOP;
	}

	const key = process.env.PI_UI_REFACTOR_POSTHOG_KEY || DEFAULT_KEY;
	const [distinctId, projectId] = await Promise.all([getMachineId(), getProjectId(init.cwd)]);

	// 每条事件都带的公共属性，同样只允许枚举 / 数字
	const base: Record<string, string | number | boolean> = sanitize({
		version: normVersion(init.version),
		pi_version: normVersion(init.piVersion),
		os: process.platform,
		node_major: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
	});
	// UUID 36 位，过不了 ENUM_RE 的长度关，走专用校验
	if (isAnonymousId(projectId)) {
		base.project_id = projectId;
	}

	const queue: Payload[] = [];

	const send = async (batch: Payload[]): Promise<void> => {
		if (batch.length === 0) {
			return;
		}
		try {
			await fetch(`${HOST}/batch/`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ api_key: key, batch }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch {
			// 断网 / 超时 / PostHog 故障：静默丢弃，绝不影响守卫
		}
	};

	return {
		track(event: TelemetryEvent): void {
			try {
				const { name, ...rest } = event;
				queue.push({
					event: name,
					distinct_id: distinctId,
					properties: { ...base, ...sanitize(rest as Record<string, unknown>) },
					timestamp: new Date().toISOString(),
				});
				if (queue.length >= MAX_QUEUE) {
					void send(queue.splice(0, queue.length));
				}
			} catch {
				// 埋点自身出错绝不冒泡
			}
		},
		async flush(): Promise<void> {
			await send(queue.splice(0, queue.length));
		},
		pending(): Payload[] {
			return [...queue];
		},
	};
}

/**
 * 从 package.json 推断技术栈。只返回枚举。
 *
 * 为什么不用 detectProtectedPaths 的 notes：
 * notes 里是 `业务目录 src/api/` 这种**含真实路径**的描述，
 * 一旦随手上报就是把用户的项目目录结构传出去了。
 */
export async function inferStack(cwd: string): Promise<StackKind> {
	try {
		const raw = await readFile(join(cwd, "package.json"), "utf-8");
		const pkg = JSON.parse(raw) as {
			dependencies?: Record<string, unknown>;
			devDependencies?: Record<string, unknown>;
		};
		const deps = { ...pkg.dependencies, ...pkg.devDependencies };
		if ("vue" in deps) return "vue";
		if ("react" in deps) return "react";
		if ("svelte" in deps) return "svelte";
		if ("@angular/core" in deps) return "angular";
		return "other";
	} catch {
		return "unknown";
	}
}

/** 读 pi 自身版本。F1 那次回归证明了：没有版本维度就无法定位
 *  “哪个 pi 版本把插件打挂了”。读不到返回 unknown，不抛错。 */
export async function readPiVersion(): Promise<string> {
	try {
		const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
		const raw = await readFile(new URL("../package.json", entry), "utf-8");
		const v = (JSON.parse(raw) as { version?: unknown }).version;
		return typeof v === "string" ? v : "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * 懒初始化：休眠项目（无配置文件）的 session_start 不建 telemetry、
 * 不写 .ai/telemetry-id；用户跑 /ui-init 激活时再补建。
 * 否则全局安装后，用户打开的每个无关项目都会被写入文件 + 上报一条 session_start。
 */
export async function ensureTelemetry(current: Telemetry, cwd: string): Promise<Telemetry> {
	if (current !== NOOP) {
		return current;
	}
	return createTelemetry({ cwd, version: PLUGIN_VERSION, piVersion: await readPiVersion() });
}

// ---------------- 首次提示 ----------------

/** 返回 true 表示这是第一次运行，调用方应展示一次性告知 */
export async function shouldShowNotice(): Promise<boolean> {
	if (!(await isEnabled())) {
		return false;
	}
	if (await exists(NOTICE_FILE)) {
		return false;
	}
	try {
		await mkdir(CONFIG_DIR, { recursive: true });
		await writeFile(NOTICE_FILE, "1\n", "utf-8");
	} catch {
		return false;
	}
	return true;
}

export const NOTICE_TEXT = [
	"pi-ui-refactor 会收集匿名使用统计（命令使用频率、拦截次数、技术栈类型）。",
	"不收集任何文件路径、文件名、代码内容、命令原文或截图。",
	"运行 /ui-telemetry print 可查看即将上报的完整内容。",
	"运行 /ui-telemetry off 可永久关闭，或设置环境变量 PI_UI_REFACTOR_TELEMETRY=0。",
].join("\n");
