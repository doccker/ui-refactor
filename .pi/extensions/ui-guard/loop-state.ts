/**
 * /uiloop 的会话状态与消息解析。
 *
 * 从 loop.ts 拆出，避免单文件超过 300 行硬限制。
 */

import type { DevServer } from "./dev-server.ts";

export const DONE_MARK = "UI_LOOP_DONE";

export interface LoopSession {
	active: boolean;
	/**
	 * identify = 让模型识别目标文件
	 * work     = 改造中，下一次 settled 跑校验
	 * capture  = 已委托模型截图，等它交图
	 */
	phase: "identify" | "work" | "capture" | "report";
	/** auto = 按是否需要导航自动决定；agent = 委托模型；url = 固定 URL 截图 */
	captureMode: "auto" | "agent" | "url";
	/** 从首页到达目标界面的导航步骤 */
	steps: string;
	/** 本轮截图应落地的相对路径 */
	pendingShot: string;
	/** 最近一次成功拿到的截图，用于收尾时出验收报告 */
	lastShot: string;
	refPath: string;
	target: string;
	routePath: string;
	round: number;
	maxRounds: number;
	server: DevServer | null;
	lastAssistantText: string;
	settles: number;
	fixAttempts: number;
}

export function createSession(): LoopSession {
	return {
		active: false,
		phase: "work",
		captureMode: "auto",
		steps: "",
		pendingShot: "",
		lastShot: "",
		refPath: "",
		target: "",
		routePath: "/",
		round: 1,
		maxRounds: 3,
		server: null,
		lastAssistantText: "",
		settles: 0,
		fixAttempts: 0,
	};
}

/** 从 AgentMessage 里抽出纯文本 */
export function messageText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((c) => (c as { type?: string })?.type === "text")
		.map((c) => (c as { text?: string }).text ?? "")
		.join("\n");
}

export interface LoopArgs {
	refPath: string;
	target: string;
	maxRounds: number;
	routePath: string;
	captureMode: "auto" | "agent" | "url";
}

/** 解析 /uiloop 的参数：<参考图> [目标文件] [--rounds N] [--route /p] [--capture agent|url] */
export function parseLoopArgs(args: string): LoopArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	let maxRounds = 3;
	let routePath = "/";
	let captureMode: "auto" | "agent" | "url" = "auto";

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--rounds") {
			maxRounds = Math.max(1, Math.min(8, Number(tokens[++i]) || 3));
		} else if (tokens[i] === "--capture") {
			const v = (tokens[++i] ?? "auto").toLowerCase();
			captureMode = v === "agent" || v === "url" ? v : "auto";
		} else if (tokens[i] === "--route") {
			const v = tokens[++i] ?? "/";
			routePath = v.startsWith("/") ? v : `/${v}`;
		} else {
			positional.push(tokens[i]);
		}
	}
	const [refPath, ...rest] = positional;
	return { refPath: refPath ?? "", target: rest.join(" "), maxRounds, routePath, captureMode };
}

/** 闭环结束时给用户的收尾提示 */
export function finishMessage(reason: string, ok: boolean, rounds: number): string {
	return [
		ok ? "✅ UI 闭环完成，请人工验收" : "⏹️ UI 闭环已停止",
		reason,
		`共 ${rounds} 轮，截图在 .ai/screenshots/`,
		"验收后运行 /ui-end 恢复工具集（bash）。",
	].join("\n");
}
