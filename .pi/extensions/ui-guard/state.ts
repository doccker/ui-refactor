/**
 * UI 重构会话状态。
 *
 * 模式（对应需求 D3 方案 C）：
 *   off          - 未进入 UI 重构会话，只做路径硬保护
 *   no-bash      - 默认：进入 /redesign 后摘掉 bash 工具（方案 A）
 *   guarded-bash - 用户显式 /ui-allow-bash 后恢复 bash，但逐条命令扫描（方案 B）
 */

import { NOOP, type Telemetry } from "./telemetry.ts";

export type GuardMode = "off" | "no-bash" | "guarded-bash";

export interface RiskRecord {
	/** 相对项目根的路径 */
	path: string;
	/** 触发的风险标签 */
	reasons: string[];
	/** 记录时间 */
	at: number;
}

export interface GuardState {
	mode: GuardMode;
	/** 进入 UI 会话前的激活工具列表，用于恢复 */
	savedTools: string[] | null;
	/** 本次 UI 会话中被判定为高风险的写入记录 */
	risks: RiskRecord[];
	/** 本次 UI 会话中实际改动过的文件 */
	touched: Set<string>;
	/** 编辑重建能力是否可用（深度导入 Pi 内部 edit-diff 成功） */
	reconstructReady: boolean;
	/** 匿名使用统计。关闭时为 NOOP，调用方无需判空 */
	telemetry: Telemetry;
	/** UI 会话开始时间，用于统计会话时长 */
	sessionStartedAt: number;
	/** 降级警告只弹一次（实战里每次 edit 都弹，刷屏反而让人忽略） */
	degradedNotified: boolean;
	/** 已提示过「改动影响面超出当前页面」的全局样式文件 */
	globalStyleNotified: Set<string>;
}

export function createState(): GuardState {
	return {
		mode: "off",
		savedTools: null,
		risks: [],
		touched: new Set(),
		reconstructReady: false,
		telemetry: NOOP,
		sessionStartedAt: Date.now(),
		degradedNotified: false,
		globalStyleNotified: new Set(),
	};
}

export function resetSession(state: GuardState): void {
	state.risks = [];
	state.touched = new Set();
	state.sessionStartedAt = Date.now();
	state.degradedNotified = false;
	state.globalStyleNotified = new Set();
}

export function describeMode(mode: GuardMode): string {
	switch (mode) {
		case "off":
			return "未激活（仅路径硬保护）";
		case "no-bash":
			return "UI 会话 · bash 已摘除（最严格）";
		case "guarded-bash":
			return "UI 会话 · bash 受控放行（逐条扫描）";
	}
}
