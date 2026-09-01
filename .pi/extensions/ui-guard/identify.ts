/**
 * 目标文件识别。
 *
 * 用户往往只有一张参考截图，并不知道它对应仓库里的哪个组件/页面。
 * 所以 /uiloop 的目标文件是可选的：缺省时先让模型看图 + 读代码给出候选，
 * 再用弹窗交给用户确认，确认后才真正开始改。
 *
 * 插件自身没有视觉能力，因此识别必须走模型；但「最终定哪个文件」必须由用户拍板，
 * 避免模型认错文件后一路改错东西。
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CANDIDATE_END = "CANDIDATE_END";

export const IDENTIFY_PROMPT = [
	"下面这张图是我想要的目标界面设计。我不确定它对应本仓库里的哪个页面或组件。",
	"",
	"请你：",
	"1. 先浏览项目结构（views / pages / components 等目录），",
	"   结合截图里的布局、文案、控件类型判断它最可能对应哪些文件。",
	"2. 必要时读几个文件确认。",
	"3. 不要修改任何代码。",
	"",
	"最后按下面的**严格格式**输出结果，每行一个候选，最多 5 个，最像的排最前：",
	"",
	"CANDIDATE: <相对项目根的文件路径> | <一句话理由>",
	"CANDIDATE: <相对项目根的文件路径> | <一句话理由>",
	"ROUTE: <该页面在开发服务器上的访问路径，例如 /home；单页应用就写 />",
	"STEPS: <从首页到达该界面需要的操作，例如：点击侧栏“代理管理” → 点击“代理池”页签；",
	"        直接可见就写“无”。若需要数据才能看到内容，一并说明>",
	"GAPS: <参考图里存在、但当前代码根本没有对应能力的东西，例如新增的筛选器、",
	"       新的数据列、自动刷新开关等；这类差异靠 UI 重构消除不了。没有就写“无”>",
	CANDIDATE_END,
	"",
	"注意：路径必须是仓库里真实存在的文件，不要编造。",
].join("\n");

export interface Candidate {
	path: string;
	reason: string;
}

export interface ParsedIdentity {
	candidates: Candidate[];
	route: string;
	/** 从首页到达目标界面的操作描述，用于截图时导航 */
	steps: string;
	/** 参考图要求但代码里不存在的能力，属于功能开发而非 UI 重构 */
	gaps: string;
}

export function parseIdentity(text: string): ParsedIdentity {
	const candidates: Candidate[] = [];
	const seen = new Set<string>();
	const lineRe = /^\s*CANDIDATE:\s*(.+?)\s*(?:\|\s*(.*))?$/gm;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: 惯用的正则遍历
	while ((m = lineRe.exec(text)) !== null) {
		const path = m[1].replace(/^[`'"]|[`'"]$/g, "").trim();
		if (!path || seen.has(path)) {
			continue;
		}
		seen.add(path);
		candidates.push({ path, reason: (m[2] ?? "").trim() });
	}
	const routeMatch = /^\s*ROUTE:\s*(\S+)/m.exec(text);
	let route = routeMatch ? routeMatch[1].replace(/^[`'"]|[`'"]$/g, "") : "/";
	if (!route.startsWith("/")) {
		route = `/${route}`;
	}
	const stepsMatch = /^\s*STEPS:\s*([\s\S]*?)(?:\n\s*(?:CANDIDATE|ROUTE)[: ]|\n\s*CANDIDATE_END|$)/m.exec(text);
	const steps = (stepsMatch?.[1] ?? "").trim();
	const gapsMatch = /^\s*GAPS:\s*([\s\S]*?)(?:\n\s*(?:CANDIDATE|ROUTE|STEPS)[: ]|\n\s*CANDIDATE_END|$)/m.exec(text);
	const gaps = (gapsMatch?.[1] ?? "").trim();
	return { candidates: candidates.slice(0, 5), route, steps, gaps };
}

async function exists(cwd: string, rel: string): Promise<boolean> {
	try {
		await access(resolve(cwd, rel));
		return true;
	} catch {
		return false;
	}
}

export interface ConfirmedTarget {
	target: string;
	route: string;
}

const MANUAL = "✎ 都不对，我手动输入路径";
const CANCEL = "✗ 取消本次重构";

/**
 * 弹窗让用户确认目标文件与页面路由。
 * 返回 null 表示用户取消或无法确认。
 */
export async function confirmTarget(
	ctx: ExtensionContext,
	parsed: ParsedIdentity,
): Promise<ConfirmedTarget | null> {
	if (!ctx.hasUI) {
		ctx.ui.notify("当前无交互界面，无法确认目标文件。请重新执行并显式指定目标文件。", "error");
		return null;
	}

	// 只保留真实存在的文件，模型偶尔会编路径
	const valid: Candidate[] = [];
	for (const c of parsed.candidates) {
		if (await exists(ctx.cwd, c.path)) {
			valid.push(c);
		}
	}

	const options = [...valid.map((c) => (c.reason ? `${c.path}  —  ${c.reason}` : c.path)), MANUAL, CANCEL];
	const picked = await ctx.ui.select(
		valid.length > 0 ? "这张截图对应哪个文件？" : "未识别出候选文件，请手动指定",
		options,
	);

	if (!picked || picked === CANCEL) {
		return null;
	}

	let target: string;
	if (picked === MANUAL) {
		const typed = await ctx.ui.input("请输入目标文件路径（相对项目根）", "src/views/Home.vue");
		if (!typed?.trim()) {
			return null;
		}
		target = typed.trim();
	} else {
		target = valid[options.indexOf(picked)].path;
	}

	if (!(await exists(ctx.cwd, target))) {
		ctx.ui.notify(`文件不存在：${target}`, "error");
		return null;
	}

	const routeInput = await ctx.ui.input(
		`该页面的访问路径？（直接回车用 ${parsed.route}）`,
		parsed.route,
	);
	let route = routeInput?.trim() || parsed.route;
	if (!route.startsWith("/")) {
		route = `/${route}`;
	}

	return { target, route };
}
