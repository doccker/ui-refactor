/**
 * 受保护路径自动探测。
 *
 * 目标：同一份插件直接适配 React / Vue / 单仓 / monorepo，无需人工枚举目录。
 *
 * 做法是扫描真实目录树而不是猜 src/：
 *   - 单仓 React：      src/api/ src/stores/ src/hooks/ ...
 *   - 单仓 Vue：        src/api/ src/stores/ src/router/ src/composables/ ...
 *   - pnpm monorepo：   apps/*\/src/api/ packages/*\/src/services/ ...
 * 探测结果按实际存在的目录生成，不存在的不会写进配置。
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** 目录名命中即整目录保护 */
const BUSINESS_DIRS = new Set([
	"api",
	"apis",
	"service",
	"services",
	"store",
	"stores",
	"hook",
	"hooks",
	"composable",
	"composables",
	"router",
	"routers",
	"routes",
	"auth",
	"permission",
	"permissions",
	"request",
	"requests",
	"graphql",
	"gql",
	"queries",
	"mutations",
	"model",
	"models",
	"repository",
	"repositories",
	"middleware",
	"middlewares",
	"interceptor",
	"interceptors",
]);

/** 命中这些词的非组件源文件视为业务文件，逐个保护。
 * 必须整 token 匹配：子串匹配会把 asset-loader.ts 当成 sse、
 * 把 database.ts 当成 base，噪声极大。 */
const BUSINESS_TOKENS = new Set([
	"request",
	"requests",
	"http",
	"https",
	"axios",
	"fetch",
	"api",
	"apis",
	"auth",
	"token",
	"tokens",
	"permission",
	"permissions",
	"session",
	"interceptor",
	"interceptors",
	"websocket",
	"socket",
	"sse",
	"client",
	"endpoint",
	"endpoints",
]);

/** 页面 / 组件区域：这些目录下不做文件级保护，否则会锁死大量页面状态文件 */
const UI_AREAS = new Set([
	"view",
	"views",
	"page",
	"pages",
	"component",
	"components",
	"layout",
	"layouts",
	"screen",
	"screens",
	"widget",
	"widgets",
	"container",
	"containers",
	"ui",
]);

/** 按分隔符与驼峰拆成 token */
function tokenize(basename: string): string[] {
	return basename
		.replace(/\.[^.]+$/, "")
		.split(/[^A-Za-z0-9]+/)
		.flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
		.map((t) => t.toLowerCase())
		.filter(Boolean);
}

function isBusinessFileName(name: string): boolean {
	return tokenize(name).some((t) => BUSINESS_TOKENS.has(t));
}

/** 红头文件后缀 */
const UI_EXT_RE = /\.(vue|svelte|css|scss|sass|less|styl)$/i;
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
/** 目录分类时一并计入后端源码，monorepo 里的服务端代码同样属于业务 */
const BIZ_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|rb|php|cs)$/i;
const IGNORE_FILE_RE = /\.(test|spec|stories|d)\.[cm]?[jt]sx?$/i;

/** 不进入的目录 */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".pi",
	".ai",
	".codex",
	".idea",
	".vscode",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".next",
	".nuxt",
	".output",
	".turbo",
	".cache",
	"public",
	"static",
	"assets",
	"__snapshots__",
	"vendor",
]);

const MAX_DEPTH = 6;

export interface DetectResult {
	rules: string[];
	/** 探测过程中识别到的项目形态描述，用于写进配置文件注释 */
	notes: string[];
}

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

async function isDir(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function walk(
	root: string,
	current: string,
	depth: number,
	rules: Set<string>,
	notes: Set<string>,
	uiArea = false,
): Promise<void> {
	if (depth > MAX_DEPTH) {
		return;
	}
	let entries: string[];
	try {
		entries = await readdir(current);
	} catch {
		return;
	}

	for (const name of entries) {
		if (name.startsWith(".") && name !== ".") {
			if (SKIP_DIRS.has(name)) {
				continue;
			}
		}
		if (SKIP_DIRS.has(name)) {
			continue;
		}
		const abs = join(current, name);
		if (!(await isDir(abs))) {
			continue;
		}

		const rel = toPosix(relative(root, abs));
		const lower = name.toLowerCase();

		if (BUSINESS_DIRS.has(lower) && (await looksLikeBusinessDir(abs))) {
			rules.add(`${rel}/`);
			notes.add(`业务目录 ${rel}/`);
			// 业务目录内部不再深入
			continue;
		}

		const inUiArea = uiArea || UI_AREAS.has(lower);
		if (!inUiArea) {
			await collectBusinessFiles(root, abs, rules);
		}
		await walk(root, abs, depth + 1, rules, notes, inUiArea);
	}
}

/**
 * 区分「名字叫 api/auth/models 的业务目录」和「名字恰好叫这个的页面目录」。
 *
 * 真实误报案例：
 *   src/views/models/     全是 .vue 页面组件，不是数据模型
 *   src/views/auth/       Login.vue / Register.vue，是登录页 UI
 *   src/components/auth/  各种登录表单组件
 * 这些目录一旦被锁，对应页面就永远无法重构了。
 *
 * 判定只看目录直接子文件：嵌套子目录（如 views/auth/composables/）不参与计票，
 * 否则 Login.vue 旁边放几个 composable 就会把整个登录页锁死。
 */
async function looksLikeBusinessDir(dir: string): Promise<boolean> {
	const tally = async (d: string): Promise<{ ui: number; biz: number; subdirs: string[] }> => {
		let ui = 0;
		let biz = 0;
		const subdirs: string[] = [];
		let entries: string[];
		try {
			entries = await readdir(d);
		} catch {
			return { ui, biz, subdirs };
		}
		for (const name of entries) {
			if (SKIP_DIRS.has(name)) {
				continue;
			}
			const abs = join(d, name);
			if (await isDir(abs)) {
				subdirs.push(abs);
				continue;
			}
			if (IGNORE_FILE_RE.test(name)) {
				continue;
			}
			if (UI_EXT_RE.test(name) || (/\.(tsx|jsx)$/i.test(name) && /^[A-Z]/.test(name))) {
				ui++;
			} else if (BIZ_EXT_RE.test(name)) {
				biz++;
			}
		}
		return { ui, biz, subdirs };
	};

	const top = await tally(dir);
	if (top.ui + top.biz > 0) {
		return top.biz > 0 && top.biz >= top.ui;
	}
	// 顶层只有子目录（如 src/api/modules/*.ts），下探一层再计票
	let ui = 0;
	let biz = 0;
	for (const sub of top.subdirs) {
		const r = await tally(sub);
		ui += r.ui;
		biz += r.biz;
	}
	return biz > 0 && biz >= ui;
}

/** 在任意目录里挑出业务命名的非组件源文件（如 src/api.ts、utils/request.ts） */
async function collectBusinessFiles(root: string, dir: string, rules: Set<string>): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name) || IGNORE_FILE_RE.test(name)) {
			continue;
		}
		// 组件文件不算：ApiStatusCard.tsx 是 UI，api.ts 才是业务
		if (!CODE_EXT_RE.test(name) || /^[A-Z]/.test(name) || /\.(tsx|jsx)$/i.test(name)) {
			continue;
		}
		if (!isBusinessFileName(name)) {
			continue;
		}
		const abs = join(dir, name);
		if (await isDir(abs)) {
			continue;
		}
		rules.add(toPosix(relative(root, abs)));
	}
}

/** 探测项目形态，仅用于生成配置文件里的说明注释 */
async function describeShape(root: string, notes: Set<string>): Promise<void> {
	for (const marker of ["pnpm-workspace.yaml", "turbo.json", "lerna.json", "nx.json"]) {
		try {
			await stat(join(root, marker));
			notes.add(`检测到 monorepo 标记 ${marker}`);
		} catch {
			// 忽略
		}
	}
	if (await isDir(join(root, "src"))) {
		notes.add("检测到单仓 src/ 布局");
	}
	for (const d of ["apps", "packages"]) {
		if (await isDir(join(root, d))) {
			notes.add(`检测到工作区目录 ${d}/`);
		}
	}
}

export async function detectProtectedPaths(root: string): Promise<DetectResult> {
	const rules = new Set<string>();
	const notes = new Set<string>();
	await describeShape(root, notes);
	await walk(root, root, 0, rules, notes);
	return {
		rules: [...rules].sort(),
		notes: [...notes].sort(),
	};
}
