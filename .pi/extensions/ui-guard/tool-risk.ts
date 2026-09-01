/**
 * UI 会话里的两类「非受保护路径」风险判定。
 *
 * 1. 任意代码执行入口（B0-2）
 *    摘掉 bash 只堵了内置工具。MCP 侧同样能执行任意代码：
 *      · playwright 的 browser_run_code_unsafe   —— 直接跑 Node 代码
 *      · MCP 网关的 mcpScript                    —— 跑 JS 并转发到任意 MCP 工具
 *      · 各类 shell/exec/terminal 类 MCP server
 *    2026-09-01 实战中模型自己发现了 run_code_unsafe，原话「属于绕过守卫的逃逸手段，
 *    我不使用」——这次没出事靠的是模型自律。守卫的价值前提就是不依赖模型自律。
 *
 *    只在 UI 会话内拦截，且**按工具名而非按服务器**拦：
 *    委托截图依赖 playwright 的 navigate/screenshot，整体摘掉 MCP 会打断闭环。
 *
 * 2. 全局样式文件（B0-6）
 *    改 :root token / body 底色会影响所有页面，但它不在受保护路径里，理应放行。
 *    只做告知，不拦截——拦了正常重构寸步难行。
 */

/** 命中即视为可执行任意代码的工具名特征 */
const CODE_EXEC_NAME = [
	/run_code_unsafe/i,
	/(^|[_.\-/])mcpscript$/i,
	/(^|[_.\-/])(shell|exec|execute|terminal|spawn|subprocess)([_.\-/]|$)/i,
];

/** 内置工具由各自分支处理，不走这里 */
const BUILTIN = new Set([
	"bash",
	"powershell",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"todo_write",
]);

/**
 * 拦截文案必须告诉模型合法替代路径。
 * 2026-09-01 实战：模型想在浏览器里 patch fetch 注入演示数据（截图指令明确允许这么做），
 * 却选了经 mcpScript 网关转发 → 被拦 → 它直接放弃了注入，导致那一轮只能对空数据页面做比对。
 * 拦截本身是对的（网关能转发到 run_code_unsafe，无法逐个审查），
 * 但不给出替代路径就把合法需求一并堵死了。
 */
const BLOCK_REASON = [
	"UI 重构会话中禁止任意代码执行工具（含经 MCP 网关转发），它等价于绕过已摘除的 bash。",
	"如果你只是想在页面里注入演示数据或读页面状态，请直接调用浏览器的 evaluate 工具（如 playwright 的 browser_evaluate），",
	"那条路是允许的；只有能执行本机代码 / 转发任意工具的网关被禁。",
	"确需本机命令请先 /ui-allow-bash 或 /ui-end。",
].join("");

export interface ToolRiskVerdict {
	blocked: boolean;
	reason?: string;
	/** 上报用的粗粒度分类，不含工具名原文 */
	kind?: "name" | "argument";
}

/**
 * UI 会话中是否应拦下这次非内置工具调用。
 * 参数里出现目标工具名的情况也要拦（网关工具本身叫 mcp，真实目标藏在 args 里）。
 */
export function detectCodeExecRisk(toolName: string, input: unknown): ToolRiskVerdict {
	if (BUILTIN.has(toolName)) {
		return { blocked: false };
	}
	if (CODE_EXEC_NAME.some((re) => re.test(toolName))) {
		return { blocked: true, kind: "name", reason: BLOCK_REASON };
	}
	// 网关型工具：真实目标在参数里。只扫前 4KB，避免大 payload 拖慢每次调用。
	let serialized = "";
	try {
		serialized = JSON.stringify(input ?? "").slice(0, 4096);
	} catch {
		// 不可序列化的参数无法判断 → UI 会话内按 UNKNOWN → BLOCK 处理
		return {
			blocked: true,
			kind: "argument",
			reason: "UI 重构会话中无法解析该工具的参数，按 fail-closed 拦截。",
		};
	}
	if (/run_code_unsafe|mcpScript/i.test(serialized)) {
		return { blocked: true, kind: "argument", reason: BLOCK_REASON };
	}
	return { blocked: false };
}

/** 目录名命中即认为该样式文件是页面/组件私有的，不算全局 */
const LOCAL_DIR = /(^|\/)(components?|views?|pages?|widgets?|features?|modules?)\//i;

const GLOBAL_STYLE_FILE =
	/(^|\/)(styles?|global|globals|main|index|app|theme|themes|variables|tokens|reset|base|element|antd)\.(css|scss|sass|less|styl)$/i;

const GLOBAL_CONFIG_FILE = /(^|\/)(tailwind|unocss|windi)\.config\.[cm]?[jt]s$/i;

/**
 * 这次改动是否会外溢到目标页面之外。
 * 只按路径判断：改 src/styles.css 影响全站，改 views/Foo/style.css 不影响。
 */
export function isGlobalStyleFile(rel: string): boolean {
	const path = rel.replace(/\\/g, "/");
	if (GLOBAL_CONFIG_FILE.test(path)) {
		return true;
	}
	if (LOCAL_DIR.test(path)) {
		return false;
	}
	return GLOBAL_STYLE_FILE.test(path);
}
