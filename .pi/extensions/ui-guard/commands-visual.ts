/**
 * 视觉类命令：/redesign /uxpolish /ui-screenshot /ui-diff
 *
 * 图片必须按 Pi 0.84.1 的真实 ImageContent 结构传递：
 *   { type: "image", data, mimeType }
 * 注意 docs/extensions.md 里 { source: { mediaType } } 的示例是过时的，
 * 按文档写会导致图片被静默丢弃。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UI_RULES } from "./prompts.ts";
import { capture, ensureServer, loadImage } from "./shot.ts";
import type { GuardState } from "./state.ts";
import { makeRegistrar } from "./track-command.ts";


export function enterUiSession(pi: ExtensionAPI, state: GuardState, ctx: ExtensionContext): void {
	if (state.mode === "off") {
		const active = pi.getActiveTools();
		state.savedTools = [...active];
		const without = active.filter((t) => t !== "bash");
		if (without.length !== active.length) {
			pi.setActiveTools(without);
		}
		state.mode = "no-bash";
		ctx.ui.notify("已进入 UI 重构会话：bash 已摘除。需要时用 /ui-allow-bash 放行，结束后用 /ui-end 恢复。", "info");
	}
}

export function registerVisualCommands(pi: ExtensionAPI, state: GuardState): void {
	const reg = makeRegistrar(pi, state);

	reg("redesign", {
		description: "按参考图重构指定页面的 UI：/redesign <参考图> <源文件>",
		handler: async (args, ctx) => {
			const [image, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const target = rest.join(" ");
			if (!image || !target) {
				ctx.ui.notify("用法：/redesign <参考图路径> <目标源文件>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent 正忙，请等待当前回合结束。", "warning");
				return;
			}

			let img: Awaited<ReturnType<typeof loadImage>>;
			try {
				img = await loadImage(ctx.cwd, image);
			} catch (err) {
				ctx.ui.notify(`读取参考图失败：${String(err)}`, "error");
				return;
			}

			enterUiSession(pi, state, ctx);

			pi.sendUserMessage([
				{
					type: "text",
					text: [
						`请参照下面这张参考设计图，重构 \`${target}\` 的界面。`,
						"",
						"执行顺序：",
						`1. 先读 \`${target}\` 及其样式文件，识别项目现有的样式技术栈。`,
						"2. 描述参考图的布局结构、间距节奏、排版层级与配色，说明与现状的差距。",
						"3. 只改视觉层，落地修改。",
						"4. 说明你改了哪些文件、每处改动属于哪一类视觉调整。",
						"",
						UI_RULES,
						"",
						"注意：受保护路径下的文件已被守卫硬拦截，不要尝试修改。",
						"bash 工具在本次会话中已被摘除，请使用 read / edit / write。",
					].join("\n"),
				},
				img,
			]);
		},
	});

	reg("uxpolish", {
		description: "打磨交互细节：/uxpolish <源文件>",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				ctx.ui.notify("用法：/uxpolish <目标源文件>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent 正忙，请等待当前回合结束。", "warning");
				return;
			}
			enterUiSession(pi, state, ctx);

			pi.sendUserMessage(
				[
					`请打磨 \`${target}\` 的交互与视觉细节，覆盖以下方面：`,
					"hover / active / focus 状态、过渡动画、加载态呈现、空状态、错误态呈现、",
					"移动端触控目标尺寸、可访问性（语义标签、aria、对比度）、响应式断点表现。",
					"",
					UI_RULES,
					"",
					"特别强调：只改善视觉反馈，不得改变任何实际业务行为。",
					"例如按钮原本调用 handleSubmit()，就必须继续调用 handleSubmit()。",
				].join("\n"),
			);
		},
	});

	reg("ui-screenshot", {
		description: "截图（自动拉起 dev server）：/ui-screenshot [路径或URL] [名称]",
		handler: async (args, ctx) => {
			const [targetArg, name = "current"] = args.trim().split(/\s+/).filter(Boolean);
			const raw = (targetArg ?? "").trim();
			let server: Awaited<ReturnType<typeof ensureServer>> | null = null;
			try {
				let url: string;
				if (/^https?:\/\//i.test(raw)) {
					// 传了完整 URL 就直接用，不启动任何进程
					url = raw.replace(/\/+$/, "");
				} else {
					server = await ensureServer(ctx);
					const path = raw.startsWith("/") ? raw : raw ? `/${raw}` : "";
					url = `${server.url}${path === "/" ? "" : path}`;
				}
				ctx.ui.notify(`正在截图 ${url} …`, "info");
				const cap = await capture(pi, ctx, url, name);
				ctx.ui.notify(cap.ok ? `截图已保存：${cap.rel}` : `截图失败：${cap.error}`, cap.ok ? "info" : "error");
			} catch (err) {
				ctx.ui.notify(`截图失败：${err instanceof Error ? err.message : String(err)}`, "error");
			} finally {
				// 只关掉自己拉起的服务，不动用户已在跑的
				if (server?.owned) {
					server.stop();
					ctx.ui.notify("已关闭本次自动启动的开发服务器。", "info");
				}
			}
		},
	});

	reg("ui-diff", {
		description: "对比参考图与当前截图：/ui-diff <参考图> <当前图>",
		handler: async (args, ctx) => {
			const [ref, cur] = args.trim().split(/\s+/).filter(Boolean);
			if (!ref || !cur) {
				ctx.ui.notify("用法：/ui-diff <参考图> <当前截图>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent 正忙，请等待当前回合结束。", "warning");
				return;
			}
			try {
				const a = await loadImage(ctx.cwd, ref);
				const b = await loadImage(ctx.cwd, cur);
				pi.sendUserMessage([
					{
						type: "text",
						text: [
							"下面第一张是参考设计图，第二张是当前实现的截图。",
							"请逐项列出两者的差异，按「影响程度」从高到低排序，每项写明：",
							"差异描述 / 涉及的具体属性（间距、字号、色值、圆角、层级等）/ 建议的修正方向。",
							"",
							"只讨论视觉差异。不要提出任何涉及业务逻辑的修改建议。",
							"如果某处差异是内容数据不同导致的（而非样式问题），请明确标注为「数据差异，无需修改」。",
						].join("\n"),
					},
					a,
					b,
				]);
			} catch (err) {
				ctx.ui.notify(`读取图片失败：${String(err)}`, "error");
			}
		},
	});
}
