/**
 * 只读校验逻辑。被 /ui-check 与 /uiloop 共用。
 *
 * 绝不修改用户代码，绝不执行 git reset / git checkout。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadProtectedPaths } from "./paths.ts";
import { detectPackageManager, planCheckTasks, readScripts, runArgs } from "./project.ts";
import type { GuardState } from "./state.ts";

export interface CheckResult {
	passed: boolean;
	/** 展示用的完整报告行 */
	lines: string[];
	/** 被改动的受保护文件 */
	protectedHits: string[];
	/** 失败任务的原始输出，用于反馈给模型自行修复 */
	failures: { label: string; output: string }[];
}

export async function execText(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ ok: boolean; out: string }> {
	try {
		const r = await pi.exec(cmd, args, { signal, timeout: 300_000 });
		return { ok: r.code === 0, out: `${r.stdout}${r.stderr}`.trim() };
	} catch (err) {
		return { ok: false, out: String(err) };
	}
}

export interface RunChecksOptions {
	pi: ExtensionAPI;
	cwd: string;
	state: GuardState;
	signal?: AbortSignal;
	/** 每启动一项校验时回调，便于 UI 提示进度 */
	onProgress?: (text: string) => void;
}

export async function runChecks(opts: RunChecksOptions): Promise<CheckResult> {
	const { pi, cwd, state, signal, onProgress } = opts;
	const rules = await loadProtectedPaths(cwd);
	const lines: string[] = [];
	const failures: { label: string; output: string }[] = [];

	// 1. 受保护文件是否被动过
	const diff = await execText(pi, "git", ["diff", "--name-only", "HEAD"], signal);
	const files = diff.out ? diff.out.split("\n").filter(Boolean) : [];
	const protectedHits = files.filter((f) =>
		rules.some((r) => f.toLowerCase().startsWith(r.replace(/\/$/, "").toLowerCase())),
	);
	if (protectedHits.length === 0) {
		lines.push("✓ 受保护文件未被改动");
	} else {
		lines.push(`✗ 受保护文件被改动（${protectedHits.length} 个）：`, ...protectedHits.map((f) => `    ${f}`));
		failures.push({
			label: "受保护文件",
			output: `以下受保护文件被改动，必须还原：\n${protectedHits.join("\n")}`,
		});
	}

	// 2. 应用级校验
	const scripts = await readScripts(cwd);
	const pm = await detectPackageManager(cwd);
	const tasks = planCheckTasks(scripts);

	if (tasks.some((t) => t.fallback)) {
		lines.push("· 未发现 typecheck / lint / test 脚本，已回退到 build（含类型检查，耗时较长）");
	}

	for (const t of tasks) {
		onProgress?.(`正在执行 ${t.label}（${pm} run ${t.script}）…`);
		const r = await execText(pi, pm, runArgs(pm, t.script), signal);
		if (r.ok) {
			lines.push(`✓ ${t.label}`);
		} else {
			const tail = r.out.split("\n").slice(-20).join("\n");
			lines.push(`✗ ${t.label}（${pm} run ${t.script}）`, ...tail.split("\n").map((l) => `    ${l}`));
			failures.push({ label: t.label, output: tail });
		}
	}
	if (tasks.length === 0) {
		lines.push("· package.json 中无 typecheck / lint / test / build 脚本，已跳过应用级校验");
	}

	lines.push("", `业务文件改动数：${protectedHits.length}`, `本次会话风险记录：${state.risks.length} 条`);
	for (const r of state.risks) {
		lines.push(`  ! ${r.path} :: ${r.reasons.join("; ")}`);
	}
	lines.push("", failures.length === 0 ? "结论：通过" : `结论：${failures.length} 项未通过`);
	lines.push("提示：本校验为只读，不会执行 git reset / git checkout。");

	return { passed: failures.length === 0, lines, protectedHits, failures };
}
