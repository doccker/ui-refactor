/**
 * 受保护路径匹配。
 *
 * 关键点（对应审查报告 P2-5）：
 *   - 不使用 path.includes()，避免 src/api 误伤 src/apiv2
 *   - 先 resolve 成绝对路径，再算相对项目根的路径
 *   - 逃出项目根（../）一律拦截
 *   - 尽力 realpath 解开 symlink
 *   - macOS/Windows 文件系统大小写不敏感，比对时统一小写
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { detectProtectedPaths } from "./detect.ts";

export const DEFAULT_PROTECTED = [
	"src/api/",
	"src/apis/",
	"src/services/",
	"src/service/",
	"src/store/",
	"src/stores/",
	"src/hooks/",
	"src/composables/",
	"src/router/",
	"src/routes/",
	"src/auth/",
	"src/permission/",
	"src/utils/request",
	"src/request/",
];

export interface PathVerdict {
	/** 是否应当拦截 */
	blocked: boolean;
	/** 归一化后的相对路径，用于展示和记录 */
	rel: string;
	/** 拦截原因 */
	reason?: string;
	/** 拦截原因是「逃出项目根」而非命中规则。
	 *  bash 宽松档（off 模式）据此放行项目外写入（如 /tmp）；
	 *  edit/write 工具不看此标志，逃逸一律拦。 */
	escape?: boolean;
}

/** 未配置时的自动探测结果缓存（按项目目录） */
const detectCache = new Map<string, string[]>();

/** 丢弃探测缓存（例如 /ui-init 重新生成配置后） */
export function clearDetectCache(cwd?: string): void {
	if (cwd) {
		detectCache.delete(cwd);
	} else {
		detectCache.clear();
	}
}

/**
 * 获取受保护路径。优先级：
 *   1. .ai-protected-paths.txt（用户显式配置）
 *   2. 自动探测（扫真实目录树，适配单仓 / monorepo）
 *   3. 内置默认值（探测也拿不到东西时的兼底）
 */
/**
 * 只读显式配置文件，不做自动探测。无文件/空文件 → []。
 *
 * 这是 `pi install` 全局安装的激活开关：off 模式（日常开发）只认这个。
 * 否则全局装完后，后端项目里 pi 连编辑自己的 src/api/ 都会被自动探测规则硬拦。
 */
export async function loadExplicitRules(cwd: string): Promise<string[]> {
	try {
		const raw = await readFile(resolve(cwd, ".ai-protected-paths.txt"), "utf-8");
		return raw
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#"));
	} catch {
		return [];
	}
}

export async function loadProtectedPaths(cwd: string): Promise<string[]> {
	const explicit = await loadExplicitRules(cwd);
	if (explicit.length > 0) {
		return explicit;
	}

	const cached = detectCache.get(cwd);
	if (cached) {
		return cached;
	}
	try {
		const { rules } = await detectProtectedPaths(cwd);
		const result = rules.length > 0 ? rules : DEFAULT_PROTECTED;
		detectCache.set(cwd, result);
		return result;
	} catch {
		return DEFAULT_PROTECTED;
	}
}

function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		// 文件尚不存在（write 新建）属正常，退回原路径
		return p;
	}
}

/** 归一化为相对项目根、使用 / 分隔、小写的路径 */
function toRel(cwd: string, target: string): string | null {
	const absTarget = safeRealpath(resolve(cwd, target));
	const absRoot = safeRealpath(cwd);
	const rel = relative(absRoot, absTarget);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		return null;
	}
	return rel.split(sep).join("/");
}

/** 判断某条规则是否命中某个相对路径（按目录/文件边界，而非子串） */
function hits(rel: string, rule: string): boolean {
	const r = rel.toLowerCase();
	const k = rule.replace(/^\.\//, "").split(sep).join("/").toLowerCase();
	if (k.endsWith("/")) {
		// 目标本身就是该目录（rel 已去掉尾斜杠）也算命中
		return r === k.slice(0, -1) || r.startsWith(k);
	}
	// 无尾斜杠：既可能是文件，也可能是目录前缀，两种都算命中
	return r === k || r.startsWith(`${k}/`) || r.startsWith(k);
}

export function checkPath(cwd: string, rawPath: unknown, rules: string[]): PathVerdict {
	if (typeof rawPath !== "string" || rawPath.trim() === "") {
		// 拿不到路径 → 无法判断 → 拦截（UNKNOWN → BLOCK）
		return { blocked: true, rel: String(rawPath), reason: "无法解析目标路径，按 fail-closed 拦截" };
	}

	const rel = toRel(cwd, rawPath);
	if (rel === null) {
		return { blocked: true, rel: rawPath, reason: "目标路径逃出项目根目录", escape: true };
	}

	const rule = rules.find((k) => hits(rel, k));
	if (rule) {
		return { blocked: true, rel, reason: `命中受保护路径规则「${rule}」` };
	}

	return { blocked: false, rel };
}
