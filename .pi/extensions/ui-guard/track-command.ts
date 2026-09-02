/**
 * 命令埋点包装器。
 *
 * 用途：回答「哪个命令没人用」。
 *
 * 刻意不用 Proxy 去劫持整个 pi 对象——那样虽然零侵入，但调试时
 * 完全看不出命令是在哪被包了一层，违反可预测性。
 * 这里让每个 register*Commands 文件显式换用 makeRegistrar()，
 * 读代码的人一眼能看见「这些命令带埋点」。
 */

import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { GuardState } from "./state.ts";
import type { CommandName } from "./telemetry.ts";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export type Registrar = (name: CommandName, options: CommandOptions) => void;

/**
 * 返回一个带使用统计的 registerCommand。
 * 埋点失败绝不影响命令本身执行。
 */
export function makeRegistrar(pi: ExtensionAPI, state: GuardState): Registrar {
	return (name, options) => {
		pi.registerCommand(name, {
			...options,
			handler: async (args, ctx) => {
				try {
					state.telemetry.track({ name: "command_used", cmd: name });
				} catch {
					// 埋点问题不能让命令用不了
				}
				return options.handler(args, ctx);
			},
		});
	};
}
