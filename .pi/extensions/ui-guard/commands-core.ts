/**
 * 只读 / 状态类命令：/ui-init /ui-status /ui-check /ui-allow-bash /ui-end
 *
 * 硬性原则：这些命令绝不修改用户源代码，绝不执行 git reset / git checkout。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { detectProtectedPaths } from "./detect.ts";
import { clearDetectCache, DEFAULT_PROTECTED, loadProtectedPaths } from "./paths.ts";
import { runChecks } from "./checks.ts";
import { describeMode, type GuardState, resetSession } from "./state.ts";
import { makeRegistrar } from "./track-command.ts";
import { ensureTelemetry, inferStack } from "./telemetry.ts";

function buildTemplate(rules: string[], notes: string[]): string {
	return [
		"# pi-ui-refactor 受保护路径",
		"# 一行一条规则，相对项目根目录。以 / 结尾表示目录。",
		"# 命中的文件禁止通过 edit / write / bash 修改。",
		"# 修改本文件后无需重启，下一次工具调用即生效。",
		"#",
		"# 以下内容由 /ui-init 扫描真实目录树自动生成：",
		...notes.map((n) => `#   - ${n}`),
		"",
		...rules,
		"",
	].join("\n");
}

export interface GuardCtx {
	pi: ExtensionAPI;
	state: GuardState;
}

async function report(ctx: ExtensionCommandContext, title: string, lines: string[]): Promise<void> {
	const text = [title, "=".repeat(title.length), ...lines].join("\n");
	ctx.ui.notify(text, "info");
	try {
		await mkdir(resolve(ctx.cwd, ".ai"), { recursive: true });
		await writeFile(resolve(ctx.cwd, ".ai", "last-report.txt"), `${text}\n`, "utf-8");
	} catch {
		// 报告落盘失败不影响主流程
	}
}

async function run(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ ok: boolean; out: string }> {
	try {
		const r = await pi.exec(cmd, args, { signal, timeout: 180_000 });
		return { ok: r.code === 0, out: `${r.stdout}${r.stderr}`.trim() };
	} catch (err) {
		return { ok: false, out: String(err) };
	}
}

export function registerCoreCommands({ pi, state }: GuardCtx): void {
	const reg = makeRegistrar(pi, state);

	reg("ui-init", {
		description: "初始化 UI 重构工作区（受保护路径 / 截图目录）",
		handler: async (args, ctx) => {
			const force = args.trim() === "--force";
			await mkdir(resolve(ctx.cwd, ".ai", "screenshots"), { recursive: true });
			const target = resolve(ctx.cwd, ".ai-protected-paths.txt");

			ctx.ui.notify("正在扫描项目目录树以探测业务路径…", "info");
			const detectStartedAt = Date.now();
			const { rules, notes } = await detectProtectedPaths(ctx.cwd);
			const detectMs = Date.now() - detectStartedAt;
			const final = rules.length > 0 ? rules : DEFAULT_PROTECTED;

			// 休眠项目在 /ui-init 时激活：session_start 时若无配置，telemetry 是 NOOP，此处补建
			state.telemetry = await ensureTelemetry(state.telemetry, ctx.cwd);

			// 只上报数量与枚举：notes 含真实路径，永远不上报
			state.telemetry.track({
				name: "stack_detected",
				stack: await inferStack(ctx.cwd),
				is_monorepo: notes.some((n) => n.includes("monorepo")),
				protected_count: final.length,
				detect_ms: detectMs,
			});

			let created = false;
			try {
				await writeFile(target, buildTemplate(final, notes), {
					encoding: "utf-8",
					flag: force ? "w" : "wx",
				});
				created = true;
			} catch {
				// 已存在则保留用户配置，不覆盖（除非 --force）
			}
			clearDetectCache(ctx.cwd);

			await report(ctx, "UI 初始化完成", [
				`受保护路径配置：${created ? (force ? "已按探测结果重新生成" : "已创建") : "已存在，保持不变（如需重新探测：/ui-init --force）"}`,
				"截图目录      ：.ai/screenshots/",
				"",
				...(notes.length > 0 ? ["项目形态：", ...notes.map((n) => `  · ${n}`), ""] : []),
				`探测到 ${final.length} 条受保护规则：`,
				...final.map((r) => `  - ${r}`),
				"",
				"下一步：核对上面的规则是否符合预期，按需增删，然后运行 /ui-check 建立基线。",
			]);
		},
	});

	reg("ui-status", {
		description: "查看 UI 重构守卫状态",
		handler: async (_args, ctx) => {
			const rules = await loadProtectedPaths(ctx.cwd);
			const branch = await run(pi, "git", ["branch", "--show-current"], ctx.signal);
			const dirty = await run(pi, "git", ["status", "--porcelain"], ctx.signal);
			const changed = dirty.out ? dirty.out.split("\n").length : 0;

			await report(ctx, "UI 守卫状态", [
				`项目目录  ：${ctx.cwd}`,
				`守卫模式  ：${describeMode(state.mode)}`,
				`重建能力  ：${state.reconstructReady ? "可用（复用 Pi 内部 edit-diff）" : "不可用，已降级为路径保护 + 事后分析"}`,
				`Git 分支  ：${branch.out || "（非 git 仓库）"}`,
				`工作区改动：${changed} 个文件`,
				`本次会话已改动：${state.touched.size} 个文件`,
				`本次会话风险记录：${state.risks.length} 条`,
				"",
				`受保护路径（${rules.length} 条）：`,
				...rules.map((r) => `  - ${r}`),
				...(state.risks.length > 0
					? ["", "风险记录：", ...state.risks.map((r) => `  ! ${r.path} :: ${r.reasons.join("; ")}`)]
					: []),
			]);
		},
	});

	reg("ui-check", {
		description: "只读校验：受保护文件 / TypeScript / ESLint / 测试",
		handler: async (_args, ctx) => {
			const checkStartedAt = Date.now();
			const res = await runChecks({
				pi,
				cwd: ctx.cwd,
				state,
				signal: ctx.signal,
				onProgress: (t) => ctx.ui.notify(t, "info"),
			});
			// protectedHits / failures 里是文件名与报错原文，只取长度
			state.telemetry.track({
				name: "check_done",
				passed: res.passed,
				protected_hits: res.protectedHits.length,
				failure_count: res.failures.length,
				duration_ms: Date.now() - checkStartedAt,
			});
			await report(ctx, "UI CHECK", res.lines);
		},
	});

	reg("ui-allow-bash", {
		description: "临时放行 bash（切换到逐条命令扫描模式）",
		handler: async (_args, ctx) => {
			if (state.mode === "off") {
				ctx.ui.notify("当前不在 UI 重构会话中，无需切换。先运行 /redesign 或 /uxpolish。", "warning");
				return;
			}
			const ok = ctx.hasUI
				? await ctx.ui.confirm(
						"放行 bash？",
						"bash 将被恢复，但每条命令都会被扫描。\n无法静态解析的写操作仍会被拦截。\n确认继续？",
					)
				: false;
			if (!ok) {
				ctx.ui.notify("已取消，bash 保持摘除状态。", "info");
				return;
			}
			const active = pi.getActiveTools();
			if (!active.includes("bash")) {
				pi.setActiveTools([...active, "bash"]);
			}
			state.mode = "guarded-bash";
			ctx.ui.notify("bash 已恢复，进入逐条扫描模式。", "warning");
		},
	});

	reg("ui-end", {
		description: "结束 UI 重构会话并恢复工具集",
		handler: async (_args, ctx) => {
			if (state.savedTools) {
				pi.setActiveTools(state.savedTools);
				state.savedTools = null;
			}
			state.mode = "off";
			const n = state.risks.length;
			state.telemetry.track({
				name: "session_end",
				touched_count: state.touched.size,
				risk_count: n,
				duration_ms: Date.now() - state.sessionStartedAt,
			});
			void state.telemetry.flush();
			resetSession(state);
			ctx.ui.notify(`UI 重构会话已结束，工具集已恢复。本次共记录 ${n} 条风险。`, "info");
		},
	});
}
