/**
 * /uiloop —— 一条命令跑完整个视觉闭环。
 *
 * 用户只需要提供参考图 + 目标文件，然后等最后验收：
 *
 *   /uiloop 参考图.png src/views/Home.vue
 *        ↓ 发送参考图，模型改 UI
 *        ↓ agent_settled → 跑 /ui-check
 *        ↓ 不过 → 把失败输出回喂给模型修 → 循环
 *        ↓ 过了 → 截图
 *        ↓ 把「参考图 + 当前截图」一起发回去做视觉比对并继续改
 *        ↓ 模型认为够接近时回复 UI_LOOP_DONE，或达到轮数上限
 *        ↓ 停下，交给用户验收
 *
 * 循环由 agent_settled 驱动：该事件在 Pi 确认不会再自动重试/续跑时触发。
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { enterUiSession } from "./commands-visual.ts";
import {
	createSession,
	DONE_MARK,
	finishMessage,
	type LoopSession,
	messageText,
	parseLoopArgs,
} from "./loop-state.ts";
import { runChecks } from "./checks.ts";
import { confirmTarget, IDENTIFY_PROMPT, parseIdentity } from "./identify.ts";
import {
	ACCEPTANCE_REPORT_PROMPT,
	buildCapturePrompt,
	buildKickoffPrompt,
	CAPTURE_DONE,
	UI_RULES,
} from "./prompts.ts";
import { capture, cleanupCaptureArtifacts, ensureServer, loadImage } from "./shot.ts";
import type { GuardState } from "./state.ts";
import { makeRegistrar } from "./track-command.ts";

export function registerLoop(pi: ExtensionAPI, guard: GuardState): void {
	const reg = makeRegistrar(pi, guard);

	const loop = createSession();

	const finish = (ctx: ExtensionContext, reason: string, ok: boolean) => {
		loop.active = false;
		if (loop.server?.owned) {
			loop.server.stop();
		}
		loop.server = null;
		ctx.ui.notify(finishMessage(reason, ok, loop.round), ok ? "info" : "warning");
	};

	/** 发送“按参考图改 UI”的开工消息 */
	const sendKickoff = async (ctx: ExtensionContext) => {
		const refImage = await loadImage(ctx.cwd, loop.refPath);
		pi.sendUserMessage([
			{
				type: "text",
				text: buildKickoffPrompt(loop.target),
			},
			refImage,
		]);
	};

	reg("uiloop", {
		description: "全自动视觉闭环：/uiloop <参考图> [目标文件] [--rounds N] [--route /path]",
		handler: async (args, ctx) => {
			const { refPath, target, maxRounds, routePath, captureMode } = parseLoopArgs(args);
			if (!refPath) {
				ctx.ui.notify("用法：/uiloop <参考图> [目标文件] [--rounds N] [--route /path]", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent 正忙，请等待当前回合结束。", "warning");
				return;
			}

			let refImage: Awaited<ReturnType<typeof loadImage>>;
			try {
				refImage = await loadImage(ctx.cwd, refPath);
			} catch (err) {
				ctx.ui.notify(`读取参考图失败：${String(err)}`, "error");
				return;
			}

			Object.assign(loop, createSession(), {
				active: true,
				phase: target ? "work" : "identify",
				refPath,
				target,
				routePath,
				maxRounds,
				captureMode,
			});
			if (loop.phase === "identify") {
				// 识别阶段不摘 bash：模型需要浏览目录结构才能定位组件。
				// 实测摘掉后模型只能靠猜文件名。此阶段本就禁止改代码，
				// 且守卫对 edit/write/bash 的路径与业务保护仍然全程生效。
				ctx.ui.notify(
					"未指定目标文件，先让模型看图并比对代码给出候选，稍后会弹窗请你确认。",
					"info",
				);
				pi.sendUserMessage([{ type: "text", text: IDENTIFY_PROMPT }, refImage]);
				return;
			}

			enterUiSession(pi, guard, ctx);
			ctx.ui.notify(
				`已启动 UI 闭环：${target}\n最多 ${maxRounds} 轮，每轮自动校验 + 截图 + 视觉比对。\n中途可用 /uiloop-stop 停止。`,
				"info",
			);
			await sendKickoff(ctx);
		},
	});

	reg("uiloop-stop", {
		description: "停止正在运行的 UI 闭环",
		handler: async (_args, ctx) => {
			if (!loop.active) {
				ctx.ui.notify("当前没有正在运行的 UI 闭环。", "info");
				return;
			}
			finish(ctx, "已被手动停止。", false);
		},
	});

	pi.on("turn_end", (event) => {
		if (loop.active) {
			loop.lastAssistantText = messageText(event.message);
		}
	});

	/**
	 * 是否把截图委托给模型。
	 * 只要会话里有浏览器工具（例如 playwright MCP）就走委托，
	 * 因为它能点开弹窗、切页签、注入演示数据；固定 URL 截图做不到。
	 */
	const useAgentCapture = (): boolean => {
		if (loop.captureMode !== "auto") {
			return loop.captureMode === "agent";
		}
		// 不能按工具名判断：MCP 适配器只注册一个名为 mcp 的网关工具，
		// playwright 藏在网关后面，按 /playwright/ 匹配工具名永远不会命中。
		// 改用语义信号：只要达到目标界面需要导航，固定 URL 截图就拿不到。
		const steps = loop.steps.trim();
		return steps.length > 0 && !/^(无|none|n\/a|-)$/i.test(steps);
	};

	/** 收尾前强制产出一份只读验收报告：还差什么、哪些要靠功能开发才能补 */
	const sendAcceptanceReport = async (ctx: ExtensionContext, shotRel: string, why: string) => {
		try {
			const refImage = await loadImage(ctx.cwd, loop.refPath);
			const curImage = await loadImage(ctx.cwd, shotRel);
			loop.phase = "report";
			loop.lastAssistantText = "";
			ctx.ui.notify(`${why}，正在生成验收报告（截图 ${shotRel}）…`, "info");
			pi.sendUserMessage([{ type: "text", text: ACCEPTANCE_REPORT_PROMPT }, refImage, curImage]);
		} catch (err) {
			finish(ctx, `截图 ${shotRel} 已生成，但无法生成验收报告：${String(err)}`, true);
		}
	};

	/** 拿到截图后：要么收尾，要么发双图继续下一轮 */
	const afterShot = async (ctx: ExtensionContext, shotRel: string) => {

		// 3. 轮数用尽 → 出一份只读验收报告，而不是直接停
		if (loop.round >= loop.maxRounds) {
			await sendAcceptanceReport(ctx, shotRel, "已达最大轮数");
			return;
		}

		// 4. 视觉比对并继续
		try {
			const refImage = await loadImage(ctx.cwd, loop.refPath);
			const curImage = await loadImage(ctx.cwd, shotRel);
			loop.round++;
			ctx.ui.notify(`校验通过，截图 ${shotRel}，进入第 ${loop.round} 轮视觉比对…`, "info");
			pi.sendUserMessage([
				{
					type: "text",
					text: [
						"第一张是参考设计图，第二张是你当前实现的真实页面截图。",
						"",
						"请按影响程度从高到低逐项列出视觉差异（间距、字号、色值、圆角、层级、内容密度等），",
						"然后立即修改代码来消除这些差异。不要询问我，直接改。",
						"",
						"如果某处差异只是内容数据不同而非样式问题，标注为「数据差异，无需修改」。",
						"",
						`如果你认为当前实现已经足够接近参考图、没有值得再改的视觉差异，`,
						`那就不要再改代码，只回复一行：${DONE_MARK}`,
						"",
						UI_RULES,
					].join("\n"),
				},
				refImage,
				curImage,
			]);
		} catch (err) {
			finish(ctx, `视觉比对准备失败：${err instanceof Error ? err.message : String(err)}`, false);
		}
	};

	pi.on("agent_settled", async (_event, ctx) => {
		if (!loop.active) {
			return;
		}
		loop.settles++;
		if (loop.settles > loop.maxRounds * 5 + 2) {
			finish(ctx, "回合数异常偏多，已强制停止以避免空转。", false);
			return;
		}

		// 验收报告已输出 → 收工
		if (loop.phase === "report") {
			finish(ctx, `已生成验收报告（见上一条回复），共 ${loop.round} 轮。`, true);
			return;
		}

		// 截图阶段：模型应当已把图存到指定路径
		if (loop.phase === "capture") {
			const shot = loop.pendingShot;
			const declaredFail = /CAPTURE_FAILED/.test(loop.lastAssistantText);
			const declaredDone = loop.lastAssistantText.includes(CAPTURE_DONE);
			loop.phase = "work";
			loop.pendingShot = "";
			if (declaredFail) {
				finish(ctx, `模型报告无法截图：\n${loop.lastAssistantText.slice(0, 400)}`, false);
				return;
			}
			try {
				// 以文件是否真的落盘为准，不光信模型口头声称的 CAPTURE_DONE
				await access(resolve(ctx.cwd, shot));
			} catch {
				if (declaredDone) {
					ctx.ui.notify(`模型声称已截图，但 ${shot} 不存在。`, "warning");
				}
				finish(
					ctx,
					`模型未能交出截图 ${shot}。可先用 /ui-screenshot 单独试一下页面能不能打开。`,
					false,
				);
				return;
			}
			loop.lastShot = shot;
			await cleanupCaptureArtifacts(ctx.cwd);
			ctx.ui.notify(`已获得截图 ${shot}`, "info");
			await afterShot(ctx, shot);
			return;
		}

		// 识别阶段：解析候选 → 弹窗由用户拍板 → 才进入改造循环
		if (loop.phase === "identify") {
			const parsed = parseIdentity(loop.lastAssistantText);
			const confirmed = await confirmTarget(ctx, parsed);
			if (!confirmed) {
				finish(ctx, "未确认目标文件，已取消。代码未做任何修改。", false);
				return;
			}
			loop.target = confirmed.target;
			loop.routePath = confirmed.route;
			loop.steps = parsed.steps;
			loop.phase = "work";
			loop.lastAssistantText = "";
			enterUiSession(pi, guard, ctx);
			ctx.ui.notify(
				[
					`已确认目标：${confirmed.target}`,
					`页面路径：${confirmed.route}`,
					...(parsed.gaps && !/^(无|none|n\/a|-)$/i.test(parsed.gaps)
						? [
								"",
								"⚠️ 参考图包含当前代码没有的能力，UI 重构消除不了这些差异：",
								parsed.gaps,
								"如需这些能力，属于功能开发，请另开任务。",
							]
						: []),
					"",
					`最多 ${loop.maxRounds} 轮，中途可用 /uiloop-stop 停止。`,
				].join("\n"),
				"info",
			);
			await sendKickoff(ctx);
			return;
		}

		if (loop.lastAssistantText.includes(DONE_MARK)) {
			// 模型说“够接近了”，但它对剩余差异的判断只留在自己的思考里，
			// 用户什么也看不到。收尾前强制出一份结构化验收报告。
			if (loop.lastShot) {
				await sendAcceptanceReport(ctx, loop.lastShot, "模型判定视觉已达标");
			} else {
				finish(ctx, "模型判定视觉已足够接近参考图（无截图可供比对）。", true);
			}
			return;
		}

		// 1. 只读校验
		ctx.ui.notify(`第 ${loop.round} 轮：正在校验…`, "info");
		const res = await runChecks({
			pi,
			cwd: ctx.cwd,
			state: guard,
			signal: ctx.signal,
			onProgress: (t) => ctx.ui.notify(t, "info"),
		});

		if (!res.passed) {
			loop.fixAttempts++;
			if (loop.fixAttempts > loop.maxRounds * 2) {
				finish(ctx, `校验反复未通过（${res.failures.map((f) => f.label).join("、")}），需人工介入。`, false);
				return;
			}
			ctx.ui.notify(`校验未通过，已回喂给模型修复（第 ${loop.fixAttempts} 次）。`, "warning");
			pi.sendUserMessage(
				[
					"自动校验未通过，请修复后继续。注意仍然不得改动业务逻辑。",
					"",
					...res.failures.map((f) => `【${f.label}】\n${f.output}`),
					"",
					res.protectedHits.length > 0
						? "受保护文件被改动属于严重问题，请把这些文件恢复原状。"
						: "修完后不要询问我，直接继续。",
				].join("\n"),
			);
			return;
		}

		// 2. 截图
		let shotRel: string;
		try {
			if (!loop.server) {
				loop.server = await ensureServer(ctx);
			}
			const url = `${loop.server.url}${loop.routePath === "/" ? "" : loop.routePath}`;
			const name = `round-${loop.round}`;

			if (useAgentCapture()) {
				// 目标界面可能藏在弹窗/页签/登录后，固定 URL 截不到。
				// 模型手里有浏览器工具，能导航并注入演示数据，交给它更可靠。
				loop.pendingShot = `.ai/screenshots/${name}.png`;
				loop.phase = "capture";
				loop.lastAssistantText = "";
				ctx.ui.notify(`校验通过，已委托模型导航并截图（第 ${loop.round} 轮）…`, "info");
				pi.sendUserMessage(
					buildCapturePrompt(url, loop.pendingShot, loop.steps, loop.server.verified),
				);
				return;
			}

			const cap = await capture(pi, ctx, url, name);
			if (!cap.ok) {
				finish(ctx, `截图失败：${cap.error}`, false);
				return;
			}
			shotRel = cap.rel;
			loop.lastShot = shotRel;
		} catch (err) {
			finish(ctx, `无法获取页面截图：${err instanceof Error ? err.message : String(err)}`, false);
			return;
		}

		await afterShot(ctx, shotRel);
	});

}
