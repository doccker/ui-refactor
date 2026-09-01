/**
 * pi-ui-refactor v0.1.3 — UI 重构守卫
 *
 * 目标运行时：pi 0.84.1
 *
 * 核心底线：AI 可以大胆改 UI，但绝不能因为改 UI 而悄悄改变业务逻辑。
 *
 * 三层防护：
 *   1. 受保护路径硬拦截（edit / write / bash 三个写入口全覆盖）
 *   2. 业务契约差分（复用 Pi 内部 edit-diff 重建落盘内容，再比对 import/调用/事件绑定）
 *   3. /ui-check 的 git + tsc + eslint + test 只读校验
 *
 * 一切 UNKNOWN 一律 BLOCK，绝不 ASSUME SAFE。
 * 守卫永不执行 git reset / git checkout，不替用户丢弃代码。
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { analyzeChange } from "./ui-guard/analyze.ts";
import { checkBashCommand } from "./ui-guard/bash-guard.ts";
import { registerCoreCommands } from "./ui-guard/commands-core.ts";
import { registerTelemetryCommands } from "./ui-guard/commands-telemetry.ts";
import { registerVisualCommands } from "./ui-guard/commands-visual.ts";
import { loadEditDiff, reconstructEdit } from "./ui-guard/edit-recon.ts";
import { registerLoop } from "./ui-guard/loop.ts";
import { checkPath, loadExplicitRules, loadProtectedPaths } from "./ui-guard/paths.ts";
import { createState } from "./ui-guard/state.ts";
import { detectCodeExecRisk, isGlobalStyleFile } from "./ui-guard/tool-risk.ts";
import {
	NOTICE_TEXT,
	PLUGIN_VERSION,
	createTelemetry,
	readPiVersion,
	shouldShowNotice,
} from "./ui-guard/telemetry.ts";

export { PLUGIN_VERSION };

export default async function (pi: ExtensionAPI) {
	const state = createState();
	state.reconstructReady = (await loadEditDiff()) !== null;

	registerCoreCommands({ pi, state });
	registerVisualCommands(pi, state);
	registerLoop(pi, state);
	registerTelemetryCommands(pi, state);

	pi.on("tool_call", async (event, ctx) => {
		// 激活开关（支撑 pi install 全局安装）：
		// off 模式只认显式配置文件；没有 = 该项目未初始化 = 完全休眠。
		// 否则全局装完后，无关项目（如后端仓库的 src/api/）会被自动探测规则硬拦。
		// UI 会话（/redesign 后）仍用自动探测兑底：用户显式启动了工作流，必须有保护。
		let rules: string[];
		if (state.mode === "off") {
			rules = await loadExplicitRules(ctx.cwd);
			if (rules.length === 0) {
				return undefined;
			}
		} else {
			rules = await loadProtectedPaths(ctx.cwd);
		}

		/** 命中业务风险时的处置：有界面则询问，无界面直接拦截 */
		const decide = async (rel: string, reasons: string[]) => {
			state.risks.push({ path: rel, reasons, at: Date.now() });
			// 只上报原因条数，不上报 rel（路径）与 reasons（含函数名）
			if (!ctx.hasUI) {
				state.telemetry.track({
					name: "contract_decision",
					decision: "no_ui_block",
					reason_count: reasons.length,
				});
				return {
					block: true,
					reason: `检测到疑似业务逻辑改动且当前无交互界面，按 fail-closed 拦截：${reasons.join("; ")}`,
				};
			}
			const ok = await ctx.ui.confirm(
				`可能改动业务逻辑：${rel}`,
				[`本次修改改变了以下业务契约：`, ...reasons.map((r) => `· ${r}`), "", "确认允许吗？"].join("\n"),
			);
			// allow 占比就是启发式的误报率，是这个产品最核心的质量指标
			state.telemetry.track({
				name: "contract_decision",
				decision: ok ? "allow" : "deny",
				reason_count: reasons.length,
			});
			return ok ? undefined : { block: true, reason: "用户拒绝了这次疑似业务逻辑改动" };
		};

		/** 改到全局样式文件时告知影响面（不拦截，每个文件每会话只说一次） */
		const noteGlobalStyle = (rel: string) => {
			if (state.mode === "off" || !ctx.hasUI || state.globalStyleNotified.has(rel)) {
				return;
			}
			if (!isGlobalStyleFile(rel)) {
				return;
			}
			state.globalStyleNotified.add(rel);
			ctx.ui.notify(
				`注意：${rel} 是全局样式文件，改动会影响本次目标页面之外的其他页面。`,
				"warning",
			);
		};

		// ---------- MCP / 自定义工具：任意代码执行入口 ----------
		// 摘掉 bash 只堵了内置工具，MCP 侧的 run_code_unsafe / mcpScript 同样能执行任意代码。
		if (state.mode === "no-bash") {
			const execRisk = detectCodeExecRisk(event.toolName, event.input);
			if (execRisk.blocked) {
				state.telemetry.track({ name: "guard_blocked", kind: "bash" });
				if (ctx.hasUI) {
					ctx.ui.notify(`已拦截代码执行工具：${execRisk.reason}`, "warning");
				}
				return { block: true, reason: execRisk.reason ?? "UI 会话中禁止任意代码执行" };
			}
		}

		// ---------- bash ----------
		if (isToolCallEventType("bash", event)) {
			if (state.mode === "no-bash") {
				return {
					block: true,
					reason: "UI 重构会话中 bash 已被摘除。确需使用请先运行 /ui-allow-bash。",
				};
			}
			// off 模式（未进入 UI 会话）用宽松档：只拦确定命中受保护路径的写入，
			// 不拦 node/npx 等日常开发命令（v0.3.0 方案 ①，解死循环）；
			// 进入 /redesign 后（guarded-bash）恢复 UNKNOWN -> BLOCK
			const verdict = checkBashCommand(
				event.input.command,
				ctx.cwd,
				rules,
				state.mode === "off" ? "lenient" : "strict",
			);
			if (verdict.blocked) {
				state.telemetry.track({ name: "guard_blocked", kind: "bash" });
				if (ctx.hasUI) {
					ctx.ui.notify(`已拦截 bash：${verdict.reason}`, "warning");
				}
				return { block: true, reason: verdict.reason ?? "bash 命令未通过守卫检查" };
			}
			return undefined;
		}

		// ---------- write ----------
		if (isToolCallEventType("write", event)) {
			const verdict = checkPath(ctx.cwd, event.input.path, rules);
			if (verdict.blocked) {
				// 注意：track 必须在 hasUI 判断外，否则无界面场景（如 CI、自动化）会漏报
				state.telemetry.track({ name: "guard_blocked", kind: "path" });
				if (ctx.hasUI) {
					ctx.ui.notify(`已拦截 write：${verdict.rel}`, "warning");
				}
				return { block: true, reason: verdict.reason ?? "write 目标未通过路径检查" };
			}

			// 纵深防御：schema 已保证 content 是 string，此处仍显式校验
			const content = event.input.content;
			if (typeof content !== "string") {
				return { block: true, reason: "write 的 content 不是字符串，无法分析，按 fail-closed 拦截" };
			}

			let before = "";
			try {
				before = await readFile(resolve(ctx.cwd, event.input.path), "utf-8");
			} catch {
				// 新建文件，无既有业务契约可破坏
				state.touched.add(verdict.rel);
				return undefined;
			}

			state.touched.add(verdict.rel);
			noteGlobalStyle(verdict.rel);
			const risk = analyzeChange(before, content);
			return risk.risky ? await decide(verdict.rel, risk.reasons) : undefined;
		}

		// ---------- edit ----------
		if (isToolCallEventType("edit", event)) {
			const verdict = checkPath(ctx.cwd, event.input.path, rules);
			if (verdict.blocked) {
				state.telemetry.track({ name: "guard_blocked", kind: "path" });
				if (ctx.hasUI) {
					ctx.ui.notify(`已拦截 edit：${verdict.rel}`, "warning");
				}
				return { block: true, reason: verdict.reason ?? "edit 目标未通过路径检查" };
			}

			const recon = await reconstructEdit(ctx.cwd, event.input.path, event.input.edits);
			if (!recon.ok) {
				state.telemetry.track({ name: "guard_blocked", kind: "recon_fail" });
				if (recon.degraded) {
					// 降级 = 插件自身能力缺失，不代表这次编辑危险。但作用域要分清：
					//   UI 会话内 —— 第二层防护失能就是 UNKNOWN，按硬约束必须 BLOCK，
					//                否则「改 UI 不偷改业务逻辑」这个承诺当场落空（2026-09-01 实战：
					//                全程降级，模型删掉一个 t() 调用，守卫本该弹确认却静默放行）。
					//   off 模式  —— 日常开发不能因插件自身缺陷停摆，退化为路径保护 + 告知。
					if (ctx.hasUI && !state.degradedNotified) {
						state.degradedNotified = true;
						ctx.ui.notify(
							`内容分析降级（${recon.reason}）。` +
								(state.mode === "off"
									? "当前仅有路径保护生效（本会话只提示一次）。"
									: "UI 会话中按 fail-closed 拦截业务文件编辑，请 /ui-end 后排查插件安装。"),
							"warning",
						);
					}
					if (state.mode !== "off") {
						return {
							block: true,
							reason: `业务契约分析当前不可用（${recon.reason}），UI 会话中无法确认这次编辑是否安全，按 fail-closed 拦截。`,
						};
					}
					state.touched.add(verdict.rel);
					return undefined;
				}
				return { block: true, reason: `无法可靠推演本次编辑结果：${recon.reason}` };
			}

			state.touched.add(verdict.rel);
			noteGlobalStyle(verdict.rel);
			const risk = analyzeChange(recon.before, recon.after);
			return risk.risky ? await decide(verdict.rel, risk.reasons) : undefined;
		}

		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		// 休眠项目：不建 telemetry（不写 .ai/telemetry-id 到无关项目）、不弹任何提示
		if ((await loadExplicitRules(ctx.cwd)).length === 0) {
			return;
		}
		state.telemetry = await createTelemetry({
			cwd: ctx.cwd,
			version: PLUGIN_VERSION,
			piVersion: await readPiVersion(),
		});
		state.telemetry.track({ name: "session_start", recon_ready: state.reconstructReady });

		if (!state.reconstructReady) {
			// 这个事件就是插件被新版 pi 打挂的告警信号，建议在 PostHog 配告警
			state.telemetry.track({ name: "degraded", reason: "edit_diff_missing" });
			if (ctx.hasUI) {
				ctx.ui.notify(
					"pi-ui-refactor：未能加载 Pi 内部 edit-diff 模块，业务契约分析将降级。路径保护仍然生效。",
					"warning",
				);
			}
		}

		if (ctx.hasUI && (await shouldShowNotice())) {
			ctx.ui.notify(NOTICE_TEXT, "info");
		}
	});

	// 每轮结束时回传，不在 tool_call 里发网络请求
	pi.on("turn_end", () => {
		void state.telemetry.flush();
	});
}
