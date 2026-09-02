/**
 * 项目元信息探测：包管理器与 npm scripts。
 *
 * 实测 6 个真实项目后发现，只有 1 个配了 lint，其余全部只有 build（内含 vue-tsc / tsc），
 * 因此校验任务必须支持回退，否则 /ui-check 在多数项目上会一项都不跑。
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

const LOCKFILES: [string, PackageManager][] = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["bun.lockb", "bun"],
	["package-lock.json", "npm"],
];

export async function detectPackageManager(cwd: string): Promise<PackageManager> {
	for (const [file, pm] of LOCKFILES) {
		try {
			await access(resolve(cwd, file));
			return pm;
		} catch {
			// 继续找下一个
		}
	}
	return "npm";
}

/** 各包管理器执行 script 的参数前缀 */
export function runArgs(pm: PackageManager, script: string): string[] {
	if (pm === "yarn") {
		return [script];
	}
	if (pm === "bun") {
		return ["run", script];
	}
	return ["run", script];
}

export async function readScripts(cwd: string): Promise<Record<string, string>> {
	try {
		const mod = await import(`file://${resolve(cwd, "package.json")}?t=${Date.now()}`, {
			with: { type: "json" },
		});
		return (mod.default?.scripts ?? {}) as Record<string, string>;
	} catch {
		return {};
	}
}

export function pickScript(scripts: Record<string, string>, candidates: string[]): string | null {
	for (const c of candidates) {
		if (scripts[c]) {
			return c;
		}
	}
	return null;
}

export interface CheckTask {
	label: string;
	script: string;
	/** 是否为回退方案（用于提示用户这项比较慢） */
	fallback?: boolean;
}

/**
 * 组装 /ui-check 要跑的校验任务。
 *
 * 优先跑轻量的 typecheck / lint / test；
 * 三者全都没有时，回退到 build——多数 Vue 项目的 build 是 `vue-tsc -b && vite build`，
 * 本身就包含类型检查，虽然慢，但总比一项都不跑强。
 */
export function planCheckTasks(scripts: Record<string, string>): CheckTask[] {
	const tasks: CheckTask[] = [];

	const tc = pickScript(scripts, ["typecheck", "type-check", "tsc", "check-types"]);
	if (tc) {
		tasks.push({ label: "TypeScript", script: tc });
	}
	const lint = pickScript(scripts, ["lint", "eslint", "lint:js"]);
	if (lint) {
		tasks.push({ label: "ESLint", script: lint });
	}
	const test = pickScript(scripts, ["test:unit", "test", "vitest"]);
	if (test) {
		tasks.push({ label: "Tests", script: test });
	}

	if (tasks.length === 0) {
		const build = pickScript(scripts, ["build", "build:prod"]);
		if (build) {
			tasks.push({ label: "Build（回退方案，含类型检查，较慢）", script: build, fallback: true });
		}
	}

	return tasks;
}

/** 找出可用于启动开发服务器的 script */
export function pickDevScript(scripts: Record<string, string>): string | null {
	return pickScript(scripts, ["dev", "serve", "start", "dev:web"]);
}
