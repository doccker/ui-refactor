/**
 * 开发服务器归属判定（B0-3，v0.3.1 新增）。
 *
 * 原实现只在 5173/1420/3000/8080 里挑第一个「端口能连上」的地址就当作本项目。
 * 2026-09-01 实战：用户机器上 1420 跑的是另一个项目，本项目其实在 11966，
 * 扩展把别人的地址发给了模型。那次只是截不到图，但只要那个端口的页面能渲染，
 * 就会拿**别的项目的界面**去和参考图做双图比对，生成一份完全错误的验收报告——
 * 比直接失败危险得多。
 *
 * 因此两件事都要做：
 *   1. 先从项目配置里读真实端口，而不是猜常见端口
 *   2. 命中后校验页面确实属于本项目（比对 index.html 的 <title>）
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** monorepo 里前端常待的位置。只下探一层，避免遍历整个仓库。 */
const WORKSPACE_ROOTS = ["apps", "packages", "web", "frontend", "client", "ui"];

async function searchDirs(cwd: string): Promise<string[]> {
	const dirs = [cwd];
	for (const root of WORKSPACE_ROOTS) {
		const abs = join(cwd, root);
		try {
			const entries = await readdir(abs, { withFileTypes: true });
			dirs.push(abs);
			for (const e of entries) {
				if (e.isDirectory() && !e.name.startsWith(".")) {
					dirs.push(join(abs, e.name));
				}
			}
		} catch {
			// 不是 monorepo，或该目录不存在
		}
	}
	return dirs;
}

const CONFIG_FILES = [
	"package.json",
	"vite.config.ts",
	"vite.config.js",
	"vite.config.mts",
	"vue.config.js",
	"next.config.js",
	"nuxt.config.ts",
	"docker-compose.yml",
	"docker-compose.yaml",
	"restart.sh",
];

/** 端口出现位置：--port 5173 / port: 5173 / PORT=5173 / localhost:5173 / "5173:5173" */
const PORT_PATTERNS = [
	/--port[= ]+(\d{2,5})/gi,
	/\bport\s*[:=]\s*["']?(\d{2,5})/gi,
	/localhost:(\d{2,5})/gi,
	/\b(\d{2,5}):\d{2,5}\b/g,
];

/**
 * 从项目配置里挖出候选端口，按出现顺序去重。
 * 只读文件，不执行任何脚本。
 */
export async function discoverProjectPorts(cwd: string): Promise<number[]> {
	const found: number[] = [];
	const dirs = await searchDirs(cwd);
	// 前端子包（apps/web 之类）的端口比仓库根的更可能是我们要截的那个，
	// 但根目录同样可能有 docker-compose 声明，所以两者都收，顺序按目录深度靠后优先。
	const files: string[] = [];
	for (const dir of dirs.slice(1).concat(dirs[0])) {
		for (const f of CONFIG_FILES) {
			files.push(join(dir, f));
		}
	}
	for (const file of files) {
		let text: string;
		try {
			text = await readFile(file, "utf-8");
		} catch {
			continue;
		}
		for (const re of PORT_PATTERNS) {
			re.lastIndex = 0;
			let m = re.exec(text);
			while (m) {
				const port = Number(m[1]);
				// 1024 以下是系统端口；65535 以上非法；node/npm 版本号常被误抓，靠范围过滤
				if (port >= 1024 && port <= 65535 && !found.includes(port)) {
					found.push(port);
				}
				m = re.exec(text);
			}
		}
	}
	return found;
}

function extractTitle(html: string): string | null {
	const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
	return m ? m[1].trim() : null;
}

/** 项目 index.html 里声明的标题，用作归属指纹 */
export async function readProjectTitle(cwd: string): Promise<string | null> {
	const rels = ["index.html", "public/index.html", "src/index.html", "app/index.html"];
	for (const dir of await searchDirs(cwd)) {
		for (const rel of rels) {
			try {
				const title = extractTitle(await readFile(join(dir, rel), "utf-8"));
				if (title) {
					return title;
				}
			} catch {
				// 试下一个
			}
		}
	}
	return null;
}

export type IdentityVerdict = "match" | "mismatch" | "unknown";

/**
 * 这个地址上跑的是不是本项目。
 *
 * 拿不到项目标题时返回 unknown：**调用方必须当作「不能复用」处理**，
 * 宁可自己起一个 dev server，也不要拿疑似别人的页面去比对。
 */
export async function checkServerIdentity(
	url: string,
	projectTitle: string | null,
	timeoutMs = 2000,
): Promise<IdentityVerdict> {
	if (!projectTitle) {
		return "unknown";
	}
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
		const html = await res.text();
		const title = extractTitle(html);
		if (!title) {
			return "unknown";
		}
		return title === projectTitle ? "match" : "mismatch";
	} catch {
		return "unknown";
	} finally {
		clearTimeout(timer);
	}
}
