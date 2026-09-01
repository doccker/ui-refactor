/**
 * 编辑重建：在 tool_call 阶段推演 edit 落盘后的完整内容。
 *
 * 关键点（对应审查报告 P1-3）：
 * Pi 0.84.1 真实写盘链路是
 *   stripBom -> detectLineEnding -> normalizeToLF -> applyEditsToNormalizedContent -> restoreLineEndings
 * 其中 applyEditsToNormalizedContent 含 fuzzy 回退（尾随空格、Unicode 引号/破折号归一）。
 *
 * 自己手写 indexOf 重建会在 BOM / CRLF / fuzzy 三种场景与 Pi 结果不一致，
 * 尤其 CRLF 文件会导致每次编辑都被误拦截。
 * 因此这里直接复用 Pi 自身的实现。
 *
 * package.json 的 exports 映射封锁了子路径导入，所以先用 import.meta.resolve
 * 拿到包入口的 file:// URL，再拼出内部模块的绝对 URL 直接 import，绕开 exports 限制。
 *
 * ---- 跨版本兼容（踩过的坑，勿删）----
 * Pi 0.84.2 起，`stripBom` 从 core/tools/edit-diff.js 迁到了 utils/text.js，
 * 并且**同名函数的返回值语义变了**：
 *
 *   旧 edit-diff.stripBom(c)  -> { bom, text }   ← 本模块需要的
 *   新 utils/text.stripBom(c) -> string          ← 同名，但不能用
 *   新 utils/text.splitBom(c) -> { bom, text }   ← 新版的对应物
 *
 * 0.84.1 → 0.84.3 升级后，旧写法会让整个业务契约差分静默降级，
 * 只剩路径保护（verify.ts 的 3 项“应拦截”用例会失败）。
 *
 * 因此这里不仅看函数存不存在，还用**运行时探针校验返回值形状**。
 * 否则下次再有同名不同义的改动，会拿到 undefined 而不报错。
 */

import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PI_PKG = "@earendil-works/pi-coding-agent";

/**
 * 定位 pi 包入口（dist/index.js）的 file:// URL。
 *
 * ---- 为什么不能只用 import.meta.resolve（v0.3.1 修，勿退回）----
 * `pi install git:` 会把扩展放到 ~/.pi/agent/git/<host>/<owner>/<repo>/，
 * 那个目录下**没有 node_modules**，而 pi 本体装在 npm 全局 lib 里，
 * 两者不在同一条 node_modules 查找链上 → import.meta.resolve 必然 ERR_MODULE_NOT_FOUND
 * → 业务契约差分对**所有全局安装的用户**永久降级，只剩路径保护。
 * 本地开发和 CI 都恰好能解析到 pi，所以测试全绿也发现不了（见 smoke-test 的安装形态用例）。
 *
 * 回退顺序：
 *   1. 常规解析（项目内装了 pi，或本仓库开发时）
 *   2. 正在运行的 pi 进程入口：argv[1] 就是 <包根>/dist/bundle/cli.js，直接从中截包根
 *   3. npm/nvm/volta 全局目录：<execPath>/../../lib/node_modules/<pkg>
 */
async function resolvePiEntry(): Promise<string | null> {
	try {
		return import.meta.resolve(PI_PKG);
	} catch {
		// 继续走回退
	}

	const roots: string[] = [];
	const marker = `${sep}${PI_PKG.split("/").join(sep)}${sep}`;
	const argv1 = process.argv[1];
	if (argv1) {
		const at = argv1.indexOf(marker);
		if (at !== -1) {
			roots.push(argv1.slice(0, at + marker.length - 1));
		}
	}
	roots.push(join(dirname(dirname(process.execPath)), "lib", "node_modules", ...PI_PKG.split("/")));
	// pi 被局部装在当前项目时（包括 CI 里的 npm install --no-save）
	roots.push(join(process.cwd(), "node_modules", ...PI_PKG.split("/")));

	for (const root of roots) {
		const entry = join(root, "dist", "index.js");
		try {
			await access(entry);
			return pathToFileURL(entry).href;
		} catch {
			// 试下一个候选
		}
	}
	return null;
}

interface EditDiffModule {
	stripBom: (content: string) => { bom: string; text: string };
	normalizeToLF: (content: string) => string;
	applyEditsToNormalizedContent: (
		normalizedContent: string,
		edits: { oldText: string; newText: string }[],
		path: string,
	) => { baseContent: string; newContent: string };
}

let cached: EditDiffModule | null = null;
let loadAttempted = false;

export async function loadEditDiff(): Promise<EditDiffModule | null> {
	if (loadAttempted) {
		return cached;
	}
	loadAttempted = true;
	try {
		const entry = await resolvePiEntry();
		if (!entry) {
			cached = null;
			return cached;
		}
		const editDiff = (await import(new URL("./core/tools/edit-diff.js", entry).href)) as Record<
			string,
			unknown
		>;

		// 这两个一直在 edit-diff.js，没搬过家
		const normalizeToLF = editDiff.normalizeToLF;
		const applyEdits = editDiff.applyEditsToNormalizedContent;
		if (typeof normalizeToLF !== "function" || typeof applyEdits !== "function") {
			cached = null;
			return cached;
		}

		// BOM 处理：先试旧位置（≤ 0.84.1），再试新位置的 splitBom（≥ 0.84.2）
		let splitBom = editDiff.stripBom;
		if (typeof splitBom !== "function") {
			const textUtils = (await import(new URL("./utils/text.js", entry).href)) as Record<
				string,
				unknown
			>;
			// 只能用 splitBom；新版的 stripBom 返回 string，拿到会静默出错
			splitBom = textUtils.splitBom;
		}
		if (typeof splitBom !== "function") {
			cached = null;
			return cached;
		}

		// 运行时探针：确认真的返回 { bom, text }，而不是同名但语义不同的函数
		const probe = (splitBom as (c: string) => unknown)("\uFEFFa");
		if (
			!probe ||
			typeof probe !== "object" ||
			typeof (probe as { bom?: unknown }).bom !== "string" ||
			typeof (probe as { text?: unknown }).text !== "string" ||
			(probe as { text: string }).text !== "a"
		) {
			cached = null;
			return cached;
		}

		cached = {
			stripBom: splitBom as EditDiffModule["stripBom"],
			normalizeToLF: normalizeToLF as EditDiffModule["normalizeToLF"],
			applyEditsToNormalizedContent: applyEdits as EditDiffModule["applyEditsToNormalizedContent"],
		};
	} catch {
		cached = null;
	}
	return cached;
}

export type ReconResult =
	| { ok: true; before: string; after: string }
	| { ok: false; reason: string; degraded: boolean };

/**
 * 用 Pi 自身逻辑重建 edit 的前后内容。
 * degraded=true 表示只是「本插件暂时不具备重建能力」，不代表这次编辑危险，
 * 交由调用方决定是降级到 tool_result 事后分析，还是直接拦截。
 */
export async function reconstructEdit(
	cwd: string,
	path: string,
	edits: unknown,
): Promise<ReconResult> {
	const mod = await loadEditDiff();
	if (!mod) {
		return { ok: false, reason: "无法加载 Pi 内部 edit-diff 模块", degraded: true };
	}

	if (!Array.isArray(edits) || edits.length === 0) {
		return { ok: false, reason: "edits 不是非空数组", degraded: false };
	}
	const normalized: { oldText: string; newText: string }[] = [];
	for (const e of edits) {
		if (!e || typeof e !== "object") {
			return { ok: false, reason: "edits 中存在非对象项", degraded: false };
		}
		const { oldText, newText } = e as Record<string, unknown>;
		if (typeof oldText !== "string" || typeof newText !== "string") {
			return { ok: false, reason: "edits 中 oldText/newText 类型非法", degraded: false };
		}
		normalized.push({ oldText, newText });
	}

	let raw: string;
	try {
		raw = await readFile(resolvePath(cwd, path), "utf-8");
	} catch (err) {
		return { ok: false, reason: `读取原文件失败：${String(err)}`, degraded: false };
	}

	try {
		const { text } = mod.stripBom(raw);
		const normalizedContent = mod.normalizeToLF(text);
		const { baseContent, newContent } = mod.applyEditsToNormalizedContent(
			normalizedContent,
			normalized,
			path,
		);
		return { ok: true, before: baseContent, after: newContent };
	} catch (err) {
		// Pi 自己也会抛（匹配不到 / 重叠 / 不唯一），此时这次 edit 本来就会失败
		return { ok: false, reason: `重建失败：${String(err)}`, degraded: false };
	}
}
