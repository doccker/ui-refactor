/**
 * bash 命令扫描（对应审查报告 P0-1，方案 C 中的「B 档」）。
 *
 * Pi 0.84.1 能写文件的内置工具有三个：edit / write / bash。
 * 只保护 edit / write 而放任 bash，等于没有保护：
 *   sed -i '' 's/getUser/getAdmin/' src/api/user.ts
 *   cat > src/store/auth.ts <<'EOF'
 *   git checkout HEAD~1 -- src/api/
 *
 * shell 无法被可靠地静态解析，因此这里遵循 UNKNOWN -> BLOCK：
 * 只要识别出写意图，就必须能把全部目标路径解析清楚，否则一律拦截。
 */

import { checkPath } from "./paths.ts";

/** 具备写盘能力的命令 */
const WRITE_COMMANDS = new Set([
	"sed",
	"tee",
	"cp",
	"mv",
	"rm",
	"install",
	"dd",
	"truncate",
	"touch",
	"ln",
	"patch",
	"rsync",
	"shred",
	"unlink",
	"mkdir",
	"rmdir",
	"chmod",
	"chown",
]);

/** 可写盘的 git 子命令 */
const GIT_WRITE_SUBS = new Set(["checkout", "restore", "reset", "clean", "apply", "stash", "revert", "rm", "mv"]);

/** 可执行任意代码的解释器。
 *
 * npx / bunx 必须在内：`npx node -e '...'` 与 `node -e '...'` 等价，
 * 不封的话路径保护一行命令就能绕过。 */
const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "php", "bun", "deno", "osascript", "sh", "bash", "zsh", "eval", "exec", "npx", "bunx"]);

/** 包管理器中等价于 npx 的子命令：能拉任意包并执行。
 *
 * 注意这里只封 dlx / exec，**不封 `npm run <script>`**：
 * 全封会让前端项目无法构建，实用性代价太大。
 * 这是一个**显式权衡**：README「已知边界」已写明。 */
const PM_EXEC_SUBS = new Set(["dlx", "exec"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);

/** 无法静态判断的构造，出现即拦截 */
const OPAQUE_PATTERNS: { re: RegExp; label: string }[] = [
	{ re: /\$\(|`/, label: "命令替换" },
	{ re: /<<-?\s*['"]?\w+/, label: "heredoc" },
	{ re: /\$\{?\w+/, label: "变量展开" },
	{ re: /\beval\b/, label: "eval" },
	{ re: /\bxargs\b/, label: "xargs" },
	{ re: /\|\s*(sh|bash|zsh)\b/, label: "管道执行" },
	{ re: /\bbase64\b\s+(-d|--decode)/, label: "base64 解码执行" },
];

export interface BashVerdict {
	blocked: boolean;
	reason?: string;
}

/**
 * 严格度。
 *
 * strict（UI 重构会话内）：UNKNOWN -> BLOCK，无法静态分析一律拦。
 * lenient（off 模式，未进入 UI 会话）：只拦能静态确定命中受保护路径的写入；
 * 解释器、变量展开等无法分析的构造放行。
 *
 * 为什么 off 要宽松（v0.3.0 方案 ①）：旧版 off 模式也拦 node/npx，
 * 而 /ui-allow-bash 在 off 模式下拒绝切换 → 用户日常跑脚本被拦且**无解**。
 * 且旧行为本身不自洽：拦了 node 却放行同样能写文件的 npm run。
 * 本插件的价值主张是「UI 重构期间保护业务逻辑」，不是全天候锁死仓库。
 *
 * 代价（已在 README「已知边界」写明）：off 模式下
 * `node evil.js` 这类无法解析目标的写入不再被拦。
 */
export type GuardStrictness = "strict" | "lenient";

function tokenize(segment: string): string[] {
	return segment
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

/**
 * 取出写命令的操作数。
 *
 * 不能只收「含 / 或含扩展名」的 token：实战中 `rmdir .playwright-mcp` 这种
 * 纯目录名会被漏掉，导致“解析不出目标路径”而误拦。
 * 写命令的非选项操作数一律视为目标。
 */
function operands(tokens: string[]): string[] {
	return tokens.slice(1).filter((t) => {
		if (t.startsWith("-")) {
			return false;
		}
		if (/^[<>|&;()]+$/.test(t) || /^\d*>>?$/.test(t)) {
			return false;
		}
		return t.length > 0;
	});
}

function stripQuotes(t: string): string {
	return t.replace(/^['"]|['"]$/g, "");
}

/** 丢弃不产生实际写盘的重定向（2>/dev/null、2>&1、&>/dev/null 等） */
function stripHarmlessRedirects(segment: string): string {
	return segment
		.replace(/\d*>&\d+/g, " ")
		.replace(/&?>{1,2}\s*\/dev\/(null|stdout|stderr|tty)/g, " ")
		.replace(/\d*>{1,2}\s*\/dev\/(null|stdout|stderr|tty)/g, " ");
}

/** 提取真正会写盘的重定向目标 */
function redirectTargets(segment: string): string[] {
	const out: string[] = [];
	const re = /(?:^|\s)&?\d*>{1,2}\|?\s*([^\s;|&]+)/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: 惯用的正则遍历
	while ((m = re.exec(segment)) !== null) {
		out.push(stripQuotes(m[1]));
	}
	return out;
}

/** opaque=true 表示该写操作的目标无法静态确定，必须直接拦 */
function hasWriteIntent(tokens: string[]): { write: boolean; label: string; opaque?: boolean } {
	const cmd = stripQuotes(tokens[0] ?? "").split("/").pop() ?? "";

	if (cmd === "git") {
		const sub = stripQuotes(tokens[1] ?? "");
		if (GIT_WRITE_SUBS.has(sub)) {
			return { write: true, label: `git ${sub}` };
		}
		return { write: false, label: "" };
	}

	if (cmd === "sed") {
		// 只有 -i 才写盘
		return tokens.some((t) => t === "-i" || t.startsWith("-i")) ? { write: true, label: "sed -i" } : { write: false, label: "" };
	}

	if (INTERPRETERS.has(cmd)) {
		// 解释器可以写任意路径，且内联代码（-c / -e）无法静态分析
		return { write: true, label: `解释器 ${cmd}`, opaque: true };
	}

	if (PACKAGE_MANAGERS.has(cmd)) {
		// pnpm dlx / yarn dlx / npm exec 等价于 npx，必须封；
		// npm run / install / test 等保持放行
		const sub = stripQuotes(tokens[1] ?? "");
		if (PM_EXEC_SUBS.has(sub)) {
			return { write: true, label: `${cmd} ${sub}`, opaque: true };
		}
		return { write: false, label: "" };
	}

	if (WRITE_COMMANDS.has(cmd)) {
		return { write: true, label: cmd };
	}

	return { write: false, label: "" };
}

function splitSegments(command: string): string[] {
	return command
		.split(/\n|&&|\|\||;|\|/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * 扫描一条 bash 命令。
 * cwd 为项目根，rules 为受保护路径规则。
 */
export function checkBashCommand(
	command: string,
	cwd: string,
	rules: string[],
	strictness: GuardStrictness = "strict",
): BashVerdict {
	const strict = strictness === "strict";
	if (typeof command !== "string" || command.trim() === "") {
		return { blocked: true, reason: "bash 命令为空或类型非法，按 fail-closed 拦截" };
	}

	const segments = splitSegments(command);

	for (const rawSegment of segments) {
		// 2>/dev/null 这类只是抑制输出，不是写盘。实战中 `find ... 2>/dev/null`
		// 曾被误判为写操作，进而把只读参数当成写目标拦下来。
		const segment = stripHarmlessRedirects(rawSegment);
		const tokens = tokenize(segment);
		if (tokens.length === 0) {
			continue;
		}

		const targets: string[] = [];
		const labels: string[] = [];

		// 写意图来源一：真实写盘的重定向。此时只检查重定向目标，
		// 不能把命令的只读参数也当成写目标。
		const redirects = redirectTargets(segment);
		if (redirects.length > 0) {
			targets.push(...redirects);
			labels.push("输出重定向");
		}

		// 写意图来源二：命令本身会写盘，此时操作数即写目标
		const intent = hasWriteIntent(tokens);
		if (intent.write) {
			if (intent.opaque) {
				if (strict) {
					return {
						blocked: true,
						reason: `bash 段「${segment.slice(0, 80)}」调用${intent.label}，其写入目标无法静态确定，按 UNKNOWN -> BLOCK 拦截`,
					};
				}
				// lenient：解释器写入目标无法确定，不拦；但同段的重定向目标仍要查
			} else {
				targets.push(...operands(tokens).map(stripQuotes));
				labels.push(intent.label);
			}
		}

		if (labels.length === 0) {
			continue;
		}
		const label = labels.join(" + ");

		// 有写意图 → strict 要求命令本身可被静态解析；lenient 只查能解析出的目标
		if (strict) {
			for (const { re, label: opaque } of OPAQUE_PATTERNS) {
				if (re.test(segment)) {
					return {
						blocked: true,
						reason: `bash 段「${segment.slice(0, 80)}」含写操作（${label}）且包含无法静态分析的${opaque}，按 UNKNOWN -> BLOCK 拦截`,
					};
				}
			}
		}

		const candidates = targets.filter((t) => t.length > 0);
		if (candidates.length === 0) {
			if (strict) {
				return {
					blocked: true,
					reason: `bash 段「${segment.slice(0, 80)}」有写操作（${label}）但解析不出目标路径，按 fail-closed 拦截`,
				};
			}
			continue;
		}

		for (const c of candidates) {
			if (/[*?\[]/.test(c)) {
				if (strict) {
					return {
						blocked: true,
						reason: `bash 段「${segment.slice(0, 80)}」写目标含通配符「${c}」，无法确定范围，拦截`,
					};
				}
				// lenient：取通配符前的字面前缀查一次，`rm src/api/*` 仍能拦住；
				// `rm src/a*` 这种前缀不命中规则的会滑过，属于 lenient 的已知代价
				const prefix = c.slice(0, c.search(/[*?\[]/));
				if (prefix.length > 0) {
					const pv = checkPath(cwd, prefix, rules);
					if (pv.blocked && !pv.escape) {
						return {
							blocked: true,
							reason: `bash 写操作（${label}）通配符目标前缀 ${pv.rel}：${pv.reason}`,
						};
					}
				}
				continue;
			}
			const verdict = checkPath(cwd, c, rules);
			if (verdict.blocked) {
				// lenient：逃出项目根（写 /tmp 等）不归本插件管；命中规则仍拦。
				// strict 下逃逸照拦不误：UI 会话中没理由往项目外写东西。
				if (!strict && verdict.escape) {
					continue;
				}
				return {
					blocked: true,
					reason: `bash 写操作（${label}）目标 ${verdict.rel}：${verdict.reason}`,
				};
			}
		}
	}

	return { blocked: false };
}
