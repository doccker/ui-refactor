/**
 * /ui-telemetry —— 使用统计的查看与开关。
 *
 * 默认开启（opt-out）是个需要举证的选择，所以这里必须提供
 * `print` 子命令：让用户亲眼看到即将上报的完整内容。
 * 对一个「安全守卫」类产品来说，
 * 「你可以自己看我传了什么」比任何隐私声明都有说服力。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardState } from "./state.ts";
import { NOTICE_TEXT, isEnabled, setOptOut } from "./telemetry.ts";

const USAGE = [
	"用法：",
	"  /ui-telemetry status   查看当前状态",
	"  /ui-telemetry print    查看即将上报的完整内容",
	"  /ui-telemetry off      永久关闭（写入 ~/.pi-ui-refactor/optout）",
	"  /ui-telemetry on       重新开启",
].join("\n");

export function registerTelemetryCommands(pi: ExtensionAPI, state: GuardState): void {
	pi.registerCommand("ui-telemetry", {
		description: "查看或开关匿名使用统计",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			state.telemetry.track({ name: "command_used", cmd: "ui-telemetry" });

			if (sub === "off") {
				await setOptOut(true);
				ctx.ui.notify("使用统计已永久关闭。重启 pi 后生效。", "info");
				return;
			}

			if (sub === "on") {
				await setOptOut(false);
				ctx.ui.notify("使用统计已开启。重启 pi 后生效。", "info");
				return;
			}

			if (sub === "print") {
				const pending = state.telemetry.pending();
				const lines =
					pending.length === 0
						? ["当前队列为空。", "", "（事件会在每轮对话结束时上报，上报后队列清空）"]
						: [
								`当前待上报 ${pending.length} 条，完整内容如下：`,
								"",
								JSON.stringify(pending, null, 2),
							];
				ctx.ui.notify(
					[
						"=== 即将上报的内容 ===",
						"",
						...lines,
						"",
						"注意：以上就是全部内容。不含文件路径、文件名、代码、命令原文或截图。",
					].join("\n"),
					"info",
				);
				return;
			}

			if (sub === "" || sub === "status") {
				const on = await isEnabled();
				ctx.ui.notify(
					[
						`使用统计：${on ? "已开启" : "已关闭"}`,
						"",
						NOTICE_TEXT,
						"",
						USAGE,
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(`未知子命令：${sub}\n\n${USAGE}`, "warning");
		},
	});
}
