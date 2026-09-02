/**
 * 端到端验证：在临时 fixture 项目上，用真实的 tool_call 事件驱动真实的守卫入口。
 *
 * 与 smoke-test.ts 的区别：
 *   smoke-test 测的是各模块的纯函数
 *   verify 加载 .pi/extensions/redesign-guard.ts 本体，模拟 Pi 的事件流，
 *   验证 block / 放行 / 确认弹窗 的最终行为
 *
 * 用法：node tools/verify.ts
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import guardFactory from "../.pi/extensions/redesign-guard.ts";

// 端到端跑的是守卫本体，会走真实的 telemetry 上报路径。
// 不关掉的话，本地每跑一次验证就往生产 PostHog 打一批事件：
// 既污染「活跃用户 / 命令分布」看板（维护者自测被算成真实用户），
// 也让首次运行受冷 DNS/TLS 影响出现偶发超时。CI 上有 CI=true 兜底，本地没有。
process.env.PI_UI_REFACTOR_TELEMETRY ??= "0";
process.env.DO_NOT_TRACK ??= "1";

type Handler = (event: any, ctx: any) => Promise<any>;

interface Harness {
	call: (toolName: string, input: any) => Promise<{ blocked: boolean; reason?: string }>;
	runCommand: (name: string, args?: string) => Promise<void>;
	emit: (evt: string, event: any) => Promise<void>;
	sent: any[][];
	hasCommand: (name: string) => boolean;
	/** select 弹窗的应答：返回选项数组里的索引，或 null 表示取消 */
	selectPick: number | null;
	inputAnswer: string | undefined;
	selectOptions: string[][];
	notifications: string[];
	confirmAnswer: boolean;
	confirmPrompts: string[];
	activeTools: string[];
	hasUI: boolean;
}

async function buildFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ui-guard-verify-"));
	const w = async (p: string, c: string) => {
		await mkdir(join(root, p.split("/").slice(0, -1).join("/")), { recursive: true });
		await writeFile(join(root, p), c, "utf-8");
	};

	await w("package.json", JSON.stringify({ name: "fixture", scripts: {} }, null, 2));
	// dev server 归属校验（B0-3）要靠 index.html 的 title 认领地址
	await w("index.html", "<html><head><title>ui-guard-fixture</title></head><body></body></html>");
	// 激活开关：v0.3.0 起 off 模式只认显式配置文件（无则休眠，支撑 pi install 全局安装）。
	// 这里预置配置 = 模拟「已初始化的项目」，后续守卫测试才有意义。
	// 末尾有专门的休眠/激活测试。
	await w(".ai-protected-paths.txt", "src/api/\nsrc/stores/\nsrc/composables/\n");
	await w("src/api/user.ts", "export const getUser = () => fetch('/api/user');\n");
	await w("src/stores/auth.ts", "export const useAuth = () => ({});\n");
	await w("src/composables/useThing.ts", "export function useThing() { return 1; }\n");
	// 一个正常的 UI 页面，CRLF + BOM，用来验证不会被误拦截
	await w(
		"src/pages/HomeReact.tsx",
		"\uFEFF" +
			[
				'import React from "react";',
				"",
				"export default function Home() {",
				"  const handleSubmit = () => {};",
				"  return (",
				'    <div className="p-2 flex">',
				"      <button onClick={handleSubmit}>提交</button>",
				"    </div>",
				"  );",
				"}",
			].join("\r\n") +
			"\r\n",
	);
	await w("src/views/models/ModelCard.vue", '<template><div class="card" /></template>\n');
	// Vue SFC：事件目标写在引号里，是真实 pi 端到端测试中发现的漏护点
	await w(
		"src/pages/Home.vue",
		[
			"<template>",
			'  <div class="p-2 flex">',
			'    <button @click="handleSubmit">提交</button>',
			"  </div>",
			"</template>",
			"<script setup>",
			"const handleSubmit = () => {};",
			`</${"script"}>`,
			"",
		].join("\n"),
	);
	return root;
}

async function createHarness(cwd: string): Promise<Harness> {
	const state = {
		notifications: [] as string[],
		confirmAnswer: false,
		confirmPrompts: [] as string[],
		selectPick: null as number | null,
		inputAnswer: undefined as string | undefined,
		selectOptions: [] as string[][],
		activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		hasUI: true,
	};
	const toolHandlers: Handler[] = [];
	const otherHandlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const sent: any[][] = [];

	const ui = {
		notify: (m: string) => {
			state.notifications.push(m);
		},
		confirm: async (title: string, msg: string) => {
			state.confirmPrompts.push(`${title} | ${msg.replace(/\n/g, " ")}`);
			return state.confirmAnswer;
		},
		select: async (_t: string, options: string[]) => {
			state.selectOptions.push(options);
			return state.selectPick === null ? undefined : options[state.selectPick];
		},
		input: async () => state.inputAnswer,
		setStatus: () => {},
	};

	const ctx = {
		cwd,
		get hasUI() {
			return state.hasUI;
		},
		ui,
		signal: undefined,
		isIdle: () => true,
	};

	const pi: any = {
		on: (evt: string, h: Handler) => {
			if (evt === "tool_call") {
				toolHandlers.push(h);
			} else {
				otherHandlers.set(evt, [...(otherHandlers.get(evt) ?? []), h]);
			}
		},
		registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		getActiveTools: () => [...state.activeTools],
		setActiveTools: (t: string[]) => {
			state.activeTools = [...t];
		},
		sendUserMessage: (content: any) => {
			sent.push(Array.isArray(content) ? content : [{ type: "text", text: String(content) }]);
		},
		appendEntry: () => {},
	};

	await guardFactory(pi);

	return {
		notifications: state.notifications,
		get confirmAnswer() {
			return state.confirmAnswer;
		},
		set confirmAnswer(v: boolean) {
			state.confirmAnswer = v;
		},
		confirmPrompts: state.confirmPrompts,
		get activeTools() {
			return state.activeTools;
		},
		get hasUI() {
			return state.hasUI;
		},
		set hasUI(v: boolean) {
			state.hasUI = v;
		},
		call: async (toolName, input) => {
			for (const h of toolHandlers) {
				const r = await h({ type: "tool_call", toolName, toolCallId: "t1", input }, ctx);
				if (r?.block) {
					return { blocked: true, reason: r.reason };
				}
			}
			return { blocked: false };
		},
		runCommand: async (name, args = "") => {
			const h = commands.get(name);
			if (!h) {
				throw new Error(`命令未注册：${name}`);
			}
			await h(args, ctx);
		},
		hasCommand: (name) => commands.has(name),
		get selectPick() {
			return state.selectPick;
		},
		set selectPick(v: number | null) {
			state.selectPick = v;
		},
		get inputAnswer() {
			return state.inputAnswer;
		},
		set inputAnswer(v: string | undefined) {
			state.inputAnswer = v;
		},
		selectOptions: state.selectOptions,
		sent,
		emit: async (evt, event) => {
			for (const h of otherHandlers.get(evt) ?? []) {
				await h(event, ctx);
			}
		},
	} as Harness;
}

const results: [string, boolean, string][] = [];
function check(name: string, pass: boolean, detail = "") {
	results.push([name, pass, detail]);
}

const root = await buildFixture();
try {
	const h = await createHarness(root);

	// --- off 模式（未进入 UI 会话）：即使有显式配置也完全休眠 ---
	// .ai-protected-paths.txt 只服务本插件的 UI 工作流，不得影响其他 skill / 日常开发
	// （2026-09 实战：别的项目跑通用工作流被硬拦，v0.3.3 改为会话内生效）。
	let r = await h.call("edit", {
		path: "src/api/user.ts",
		edits: [{ oldText: "getUser", newText: "getUserTouched" }],
	});
	check("off 模式不拦 edit src/api/（配置只在 UI 会话生效）", !r.blocked, r.reason ?? "");

	r = await h.call("bash", { command: "sed -i '' 's/a/b/' src/api/user.ts" });
	check("off 模式不拦 bash 写受保护路径", !r.blocked, r.reason ?? "");

	// --- 进入 UI 会话（guarded-bash）后三层防护生效 ---
	const png = Buffer.from("89504e470d0a1a0a", "hex");
	await writeFile(join(root, "ref.png"), png);
	await h.runCommand("redesign", "ref.png src/pages/HomeReact.tsx");
	h.confirmAnswer = true;
	await h.runCommand("ui-allow-bash");

	// --- 第一层：受保护路径硬拦截 ---
	r = await h.call("edit", {
		path: "src/api/user.ts",
		edits: [{ oldText: "getUser", newText: "getAdmin" }],
	});
	check("edit 改 src/api/ 被拦截", r.blocked, r.reason ?? "");

	r = await h.call("write", { path: "src/stores/auth.ts", content: "hacked" });
	check("write 改 src/stores/ 被拦截", r.blocked, r.reason ?? "");

	r = await h.call("bash", { command: "sed -i '' 's/a/b/' src/api/user.ts" });
	check("bash sed -i 改 api 被拦截", r.blocked, r.reason ?? "");

	r = await h.call("bash", { command: "cat > src/stores/auth.ts" });
	check("bash 重定向写 store 被拦截", r.blocked, r.reason ?? "");

	r = await h.call("write", { path: "../../../tmp/evil.ts", content: "x" });
	check("write 逃逸项目根被拦截", r.blocked, r.reason ?? "");

	r = await h.call("write", { path: "src/pages/HomeReact.tsx", content: undefined });
	check("write content 非字符串被拦截", r.blocked, r.reason ?? "");

	// --- 正常 UI 改动必须放行（CRLF + BOM 文件）---
	r = await h.call("edit", {
		path: "src/pages/HomeReact.tsx",
		edits: [{ oldText: '<div className="p-2 flex">', newText: '<div className="px-6 py-4 rounded-lg">' }],
	});
	check("CRLF+BOM 文件的纯 className 改动放行", !r.blocked, r.reason ?? "");

	r = await h.call("edit", {
		path: "src/views/models/ModelCard.vue",
		edits: [{ oldText: 'class="card"', newText: 'class="card card--lg"' }],
	});
	check("views/models 页面可被重构（未被误锁）", !r.blocked, r.reason ?? "");

	r = await h.call("bash", { command: "npm run build" });
	check("bash npm run build 放行", !r.blocked, r.reason ?? "");

	// --- 第二层：业务契约差分 ---
	// 清掉 /ui-allow-bash 的确认记录，下面的 confirmPrompts 断言才有意义
	h.confirmPrompts.length = 0;
	h.confirmAnswer = false;
	r = await h.call("edit", {
		path: "src/pages/HomeReact.tsx",
		edits: [{ oldText: "onClick={handleSubmit}", newText: "onClick={handleDelete}" }],
	});
	check("事件目标被偷换 → 弹确认且用户拒绝后拦截", r.blocked && h.confirmPrompts.length > 0, r.reason ?? "");

	h.confirmAnswer = true;
	r = await h.call("edit", {
		path: "src/pages/HomeReact.tsx",
		edits: [{ oldText: "onClick={handleSubmit}", newText: "onClick={handleDelete}" }],
	});
	check("同一改动用户确认后放行", !r.blocked, r.reason ?? "");

	// --- Vue SFC 事件绑定（真实 pi 端到端测试中发现的漏护）---
	h.confirmAnswer = false;
	r = await h.call("edit", {
		path: "src/pages/Home.vue",
		edits: [{ oldText: 'class="p-2 flex"', newText: 'class="px-6 py-4 flex gap-3"' }],
	});
	check("Vue 纯 class 改动放行", !r.blocked, r.reason ?? "");

	r = await h.call("edit", {
		path: "src/pages/Home.vue",
		edits: [{ oldText: '@click="handleSubmit"', newText: '@click="handleDelete"' }],
	});
	check("Vue @click 目标被偷换 → 拦截", r.blocked, r.reason ?? "");

	// --- 无界面时必须 fail closed ---
	h.hasUI = false;
	r = await h.call("edit", {
		path: "src/pages/HomeReact.tsx",
		edits: [{ oldText: "onClick={handleSubmit}", newText: "onClick={handleDelete}" }],
	});
	check("无交互界面时业务改动直接拦截", r.blocked, r.reason ?? "");
	h.hasUI = true;

	await h.runCommand("ui-end");

	// --- 第三层 / 会话模式：bash 摘除与恢复 ---
	check("初始 bash 在激活工具中", h.activeTools.includes("bash"));
	await h.runCommand("redesign", "nonexistent.png src/pages/HomeReact.tsx");
	check("参考图不存在时不进入会话（bash 未被摘）", h.activeTools.includes("bash"));

	await h.runCommand("redesign", "ref.png src/pages/HomeReact.tsx");
	check("/redesign 后 bash 被摘除", !h.activeTools.includes("bash"));

	r = await h.call("bash", { command: "ls -la" });
	check("UI 会话中即使无害 bash 也被拦截", r.blocked, r.reason ?? "");

	h.confirmAnswer = true;
	await h.runCommand("ui-allow-bash");
	check("/ui-allow-bash 后 bash 恢复", h.activeTools.includes("bash"));

	r = await h.call("bash", { command: "ls -la" });
	check("放行模式下无害 bash 通过", !r.blocked, r.reason ?? "");

	r = await h.call("bash", { command: "sed -i '' 's/x/y/' src/api/user.ts" });
	check("放行模式下危险 bash 仍被拦截", r.blocked, r.reason ?? "");

	await h.runCommand("ui-end");
	check("/ui-end 恢复原工具集", h.activeTools.includes("bash") && h.activeTools.length === 7);

	// --- /uiloop 编排 ---
	for (const c of ["uiloop", "uiloop-stop"]) {
		check(`命令 /${c} 已注册`, h.hasCommand(c));
	}

	h.sent.length = 0;
	await h.runCommand("uiloop", "不存在的图.png src/pages/Home.vue");
	check("/uiloop 参考图不存在时不启动", h.sent.length === 0 && h.activeTools.includes("bash"));

	await h.runCommand("uiloop", "ref.png src/pages/Home.vue --rounds 2");
	const kickoff = h.sent[0] ?? [];
	check(
		"/uiloop 首轮发送文字+参考图",
		kickoff.length === 2 &&
			kickoff[0].type === "text" &&
			kickoff[1].type === "image" &&
			typeof kickoff[1].data === "string" &&
			kickoff[1].mimeType === "image/png",
		JSON.stringify(kickoff.map((c: any) => Object.keys(c))),
	);
	check("显式指定目标时立即摘除 bash", !h.activeTools.includes("bash"));
	await h.runCommand("ui-end");

	// 识别阶段不应摘除 bash：模型需要浏览目录结构才能定位组件
	await h.runCommand("uiloop", "ref.png");
	check("识别阶段保留 bash", h.activeTools.includes("bash"));
	await h.runCommand("uiloop-stop");
	await h.runCommand("uiloop", "ref.png src/pages/Home.vue --rounds 2");

	// 模型回复完成标记 → 闭环应结束，不再发新消息
	h.sent.length = 0;
	await h.emit("turn_end", {
		type: "turn_end",
		turnIndex: 1,
		message: { role: "assistant", content: [{ type: "text", text: "UI_LOOP_DONE" }] },
		toolResults: [],
	});
	await h.emit("agent_settled", { type: "agent_settled" });
	check("无截图时 UI_LOOP_DONE 直接结束", h.sent.length === 0);

	// 结束后再来事件不应再触发任何动作
	await h.emit("agent_settled", { type: "agent_settled" });
	check("闭环结束后不再响应 agent_settled", h.sent.length === 0);

	// --- 完整走一遍：确认目标 → 校验 → 委托截图 → 双图对比 → DONE → 验收报告 ---
	// 起一个假的「本项目 dev server」让 ensureServer 复用，而不是去拉真的 dev server。
	// 注意两点（都是 2026-09-01 定位到的真实坑）：
	//   1. 必须返回与 index.html 同名的 <title>，否则归属校验判定 mismatch 会跳过它
	//   2. 端口必须随机（listen 0）。旧版硬编码 5173，本机只要有别的项目占着这个端口，
	//      这一段就随机失败——这才是「verify 偶发 42/49」的真正原因，不是异步竞态。
	const stub = createServer((_q, s) => {
		s.setHeader("content-type", "text/html");
		s.end("<html><head><title>ui-guard-fixture</title></head><body>ok</body></html>");
	});
	await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
	const stubPort = (stub.address() as { port: number }).port;
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name: "fixture", scripts: { dev: `vite --port ${stubPort}` } }, null, 2),
	);
	try {
		await h.runCommand("uiloop", "ref.png --rounds 3");
		await h.emit("turn_end", {
			type: "turn_end",
			turnIndex: 10,
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: [
							"CANDIDATE: src/pages/Home.vue | 匹配",
							"ROUTE: /",
							"STEPS: 点击侧栏“代理管理”",
							"CANDIDATE_END",
						].join("\n"),
					},
				],
			},
			toolResults: [],
		});
		h.selectPick = 0;
		h.inputAnswer = "";
		await h.emit("agent_settled", { type: "agent_settled" });

		// 改完一轮 → 应当委托模型截图（因为 STEPS 说需要导航）
		h.sent.length = 0;
		await h.emit("agent_settled", { type: "agent_settled" });
		const capMsg = h.sent[0]?.[0]?.text ?? "";
		check("需要导航时委托模型截图", capMsg.includes("CAPTURE_DONE"), capMsg.slice(0, 60));
		check("截图指令包含导航步骤", capMsg.includes("代理管理"));

		// 模型交图 → 应当进入双图对比
		await mkdir(join(root, ".ai/screenshots"), { recursive: true });
		await writeFile(join(root, ".ai/screenshots/round-1.png"), png);
		// 委托截图时 bash 已被摘，模型自己删不掉这个目录（实测它明说了 no way to delete）
		await mkdir(join(root, ".playwright-mcp"), { recursive: true });
		await writeFile(join(root, ".playwright-mcp/tmp.yml"), "x");
		h.sent.length = 0;
		await h.emit("agent_settled", { type: "agent_settled" });
		check("拿到截图后发双图对比", (h.sent[0] ?? []).length === 3, String((h.sent[0] ?? []).length));
		let artifactsGone = false;
		try {
			await access(join(root, ".playwright-mcp"));
		} catch {
			artifactsGone = true;
		}
		check("扩展自动清理 .playwright-mcp 临时目录", artifactsGone);
		let shotKept = true;
		try {
			await access(join(root, ".ai/screenshots/round-1.png"));
		} catch {
			shotKept = false;
		}
		check("清理不会误删截图", shotKept);

		// 模型说完成 → 不能直接走人，必须先交验收报告
		h.sent.length = 0;
		await h.emit("turn_end", {
			type: "turn_end",
			turnIndex: 11,
			message: { role: "assistant", content: [{ type: "text", text: "UI_LOOP_DONE" }] },
			toolResults: [],
		});
		await h.emit("agent_settled", { type: "agent_settled" });
		const report = h.sent[0] ?? [];
		check(
			"UI_LOOP_DONE 后强制交验收报告",
			report.length === 3 && report[0].text.includes("不要再修改任何代码"),
			report[0]?.text?.slice(0, 60) ?? "(未发送)",
		);
		check("验收报告要求区分「需新增功能」的差异", report[0]?.text?.includes("需要新增功能") === true);

		await h.emit("agent_settled", { type: "agent_settled" });
		check("报告输出后收工", h.sent.length === 1);
	} finally {
		stub.close();
	}

	await h.runCommand("ui-end");

	// --- 只给参考图，不给目标文件（用户不知道是哪个组件）---
	h.sent.length = 0;
	h.selectOptions.length = 0;
	await h.runCommand("uiloop", "ref.png --rounds 2");
	const identify = h.sent[0] ?? [];
	check(
		"不给目标文件时先发识别请求（含图）",
		identify.length === 2 && identify[0].text.includes("CANDIDATE:") && identify[1].type === "image",
	);
	check("识别阶段不会先改代码", identify[0].text.includes("不要修改任何代码"));

	// 模型给出候选，其中一个是编造的不存在路径
	h.sent.length = 0;
	await h.emit("turn_end", {
		type: "turn_end",
		turnIndex: 1,
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: [
						"CANDIDATE: src/pages/Home.vue | 顶部布局与截图一致",
						"CANDIDATE: src/pages/Ghost.vue | 模型编造的不存在文件",
						"ROUTE: /home",
						"STEPS: 点击侧栏“代理管理” → 点击“代理池”页签",
						"GAPS: 参考图有搜索框与分组列，代码里没有",
						"CANDIDATE_END",
					].join("\n"),
				},
			],
		},
		toolResults: [],
	});
	h.selectPick = 0;
	h.inputAnswer = "";
	await h.emit("agent_settled", { type: "agent_settled" });

	const opts = h.selectOptions[0] ?? [];
	check("不存在的候选路径被过滤掉", !opts.some((o) => o.includes("Ghost.vue")), opts.join(" / "));
	check("候选列表包含真实文件与理由", opts.some((o) => o.includes("src/pages/Home.vue")));
	check("提供了“手动输入”与“取消”选项", opts.length >= 3 && opts.some((o) => o.includes("取消")));
	check(
		"确认后才发送改造指令",
		h.sent.length === 1 && h.sent[0][0].text.includes("src/pages/Home.vue"),
		JSON.stringify(h.sent.map((s) => s[0]?.text?.slice(0, 30))),
	);

	check(
		"确认后才摘除 bash（识别阶段保留，否则模型只能猜文件名）",
		!h.activeTools.includes("bash"),
	);

	await h.runCommand("uiloop-stop");

	// 用户在确认弹窗里取消 → 不能动任何代码
	h.sent.length = 0;
	await h.runCommand("uiloop", "ref.png");
	h.sent.length = 0;
	h.selectPick = null;
	await h.emit("agent_settled", { type: "agent_settled" });
	check("用户取消确认时不发改造指令", h.sent.length === 0);
	await h.runCommand("ui-end");

	// --- 休眠语义（v0.3.3：off 模式无条件休眠，有无配置都不拦）---
	await rm(join(root, ".ai-protected-paths.txt"));
	r = await h.call("edit", {
		path: "src/api/user.ts",
		edits: [{ oldText: "getUser", newText: "getUserRenamed" }],
	});
	check("无配置文件时 off 模式完全休眠（不拦 src/api/）", !r.blocked, r.reason ?? "");

	// --- /ui-init 自动探测：只生成配置，off 模式依旧不拦 ---
	await h.runCommand("ui-init");
	const cfgRaw = await readFile(join(root, ".ai-protected-paths.txt"), "utf-8").catch(() => null);
	check("/ui-init 生成配置文件", cfgRaw !== null && cfgRaw.includes("src/api/"));

	r = await h.call("edit", {
		path: "src/api/user.ts",
		edits: [{ oldText: "getUser", newText: "getAdmin" }],
	});
	check("/ui-init 后 off 模式仍不拦（规则只在 UI 会话生效）", !r.blocked, r.reason ?? "");

	await h.runCommand("redesign", "ref.png src/pages/HomeReact.tsx");
	r = await h.call("edit", {
		path: "src/api/user.ts",
		edits: [{ oldText: "getUser", newText: "getAdmin" }],
	});
	check("UI 会话内 /ui-init 生成的规则生效（src/api/ 被拦）", r.blocked, r.reason ?? "");
	await h.runCommand("ui-end");
} finally {
	await rm(root, { recursive: true, force: true });
}

let fail = 0;
for (const [n, ok, d] of results) {
	if (!ok) {
		fail++;
	}
	console.log(`${ok ? "  ✓" : "  ✗"} ${n}${!ok && d ? `\n       ${d}` : ""}`);
}
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
