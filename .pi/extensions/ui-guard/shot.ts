/**
 * 截图与图片装载。被 /ui-screenshot 与 /uiloop 共用。
 *
 * 图片必须按 Pi 0.84.1 的真实 ImageContent 结构传递：{ type, data, mimeType }。
 * docs/extensions.md 里 { source: { mediaType } } 的示例是过时的，按它写图片会被静默丢弃。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DevServer, isReachable, startDevServer } from "./dev-server.ts";
import { detectPackageManager, pickDevScript, readScripts } from "./project.ts";
import {
	checkServerIdentity,
	discoverProjectPorts,
	readProjectTitle,
} from "./server-identity.ts";

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

export interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

export async function loadImage(cwd: string, p: string): Promise<ImagePart> {
	const abs = resolve(cwd, p);
	const ext = extname(abs).toLowerCase();
	const mimeType = MIME[ext];
	if (!mimeType) {
		throw new Error(`不支持的图片格式：${ext || "(无扩展名)"}`);
	}
	const buf = await readFile(abs);
	return { type: "image", data: buf.toString("base64"), mimeType };
}

const COMMON_PORTS = [5173, 1420, 3000, 8080];

/**
 * 复用已在跑的开发服务器，没有就自动拉起。
 *
 * 项目配置里声明的端口优先于常见端口；命中后还要比对页面 title。
 * 没通过归属校验的地址一律不复用：拿别的项目的界面去做双图比对，
 * 比截不到图危险得多（B0-3）。
 */
export async function ensureServer(ctx: ExtensionContext): Promise<DevServer> {
	const projectTitle = await readProjectTitle(ctx.cwd);
	const ports = [...(await discoverProjectPorts(ctx.cwd)), ...COMMON_PORTS];
	const seen = new Set<number>();
	/** 能连上但无法证实归属的地址，只当兵败时的兵底 */
	let unverified: string | null = null;
	for (const port of ports) {
		if (seen.has(port)) {
			continue;
		}
		seen.add(port);
		const candidate = `http://localhost:${port}`;
		if (!(await isReachable(candidate, 800))) {
			continue;
		}
		const identity = await checkServerIdentity(candidate, projectTitle);
		if (identity === "match") {
			ctx.ui.notify(`复用已在运行的开发服务器 ${candidate}`, "info");
			return { url: candidate, owned: false, stop: () => {}, verified: true };
		}
		if (identity === "unknown" && !unverified) {
			unverified = candidate;
		}
		ctx.ui.notify(
			identity === "mismatch"
				? `${candidate} 上跑的不是本项目（页面标题不匹配），已跳过。`
				: `${candidate} 无法确认是否本项目，优先自行启动。`,
			"warning",
		);
	}
	const scripts = await readScripts(ctx.cwd);
	const script = pickDevScript(scripts);
	if (script) {
		const pm = await detectPackageManager(ctx.cwd);
		ctx.ui.notify(`正在启动开发服务器（${pm} run ${script}）…`, "info");
		return await startDevServer({ cwd: ctx.cwd, pm, script, signal: ctx.signal });
	}
	// 起不了自己的服务时，宁可给一个带「未证实」标记的地址，也不能假装它就是本项目；
	// 调用方（loop）会把这个不确定性写进给模型的截图指令里。
	if (unverified) {
		return { url: unverified, owned: false, stop: () => {}, verified: false };
	}
	throw new Error("package.json 中未找到 dev / serve / start 脚本，请直接传完整 URL");
}

/**
 * Playwright 装了但浏览器没下载时，原生报错是一大坨 ASCII 框，在 notify 里基本不可读。
 * 这里识别并引导安装。返回 true 表示已安装完成，可以重试。
 */
async function handleMissingBrowser(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	output: string,
): Promise<boolean> {
	if (!/playwright install|Executable doesn't exist|browserType\.launch/i.test(output)) {
		return false;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Playwright 浏览器未安装。请先执行：npx playwright install chromium", "error");
		return false;
	}
	const ok = await ctx.ui.confirm(
		"Playwright 浏览器未安装",
		"截图需要 Chromium，当前未下载。\n现在安装吗？（npx playwright install chromium，约 150MB）",
	);
	if (!ok) {
		ctx.ui.notify("已取消。需要时手动执行：npx playwright install chromium", "warning");
		return false;
	}
	ctx.ui.notify("正在下载 Chromium，请稍候…", "info");
	const r = await pi.exec("npx", ["--yes", "playwright", "install", "chromium"], {
		signal: ctx.signal,
		timeout: 600_000,
	});
	if (r.code !== 0) {
		ctx.ui.notify(`Chromium 安装失败：${(r.stderr || r.stdout).slice(-300)}`, "error");
		return false;
	}
	return true;
}

export interface CaptureResult {
	ok: boolean;
	/** 相对项目根的截图路径 */
	rel: string;
	error?: string;
}

/** 截图到 .ai/screenshots/<name>.png */
export async function capture(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	url: string,
	name: string,
): Promise<CaptureResult> {
	const dir = resolve(ctx.cwd, ".ai", "screenshots");
	await mkdir(dir, { recursive: true });
	const out = resolve(dir, `${name}.png`);
	const rel = `.ai/screenshots/${name}.png`;
	const args = ["--yes", "playwright", "screenshot", "--full-page", "--viewport-size=1440,900", url, out];

	let r = await pi.exec("npx", args, { signal: ctx.signal, timeout: 120_000 });
	if (r.code !== 0 && (await handleMissingBrowser(pi, ctx, r.stderr || r.stdout))) {
		r = await pi.exec("npx", args, { signal: ctx.signal, timeout: 120_000 });
	}
	if (r.code === 0) {
		return { ok: true, rel };
	}
	return { ok: false, rel, error: (r.stderr || r.stdout).slice(-400) };
}

/**
 * 清理 playwright MCP 留下的快照/日志临时目录。
 * 委托截图时 bash 已被摘除，模型自己删不掉（实测它明确说了 "no way to delete"），
 * 所以由扩展代劳。只删项目内这一个固定目录，不碰其他文件。
 */
export async function cleanupCaptureArtifacts(cwd: string): Promise<void> {
	try {
		await rm(resolve(cwd, ".playwright-mcp"), { recursive: true, force: true });
	} catch {
		// 清理失败不影响主流程
	}
}
