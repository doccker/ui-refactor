/**
 * 开发服务器自动拉起。
 *
 * /ui-screenshot 原本要求用户先手动 npm run dev 再传 URL，视觉闭环因此断在人工环节。
 * 这里在需要时自动启动 dev server、解析它打印的本地地址、截完图再关掉。
 *
 * 不用 pi.exec()：exec 会一直等到进程退出，而 dev server 不会退出。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { type PackageManager, runArgs } from "./project.ts";

/** 去掉 ANSI 颜色码，否则 Vite 打印的地址匹配不出来 */
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 需要匹配 ANSI 转义序列
	return s.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?[^\s/]*\/?[^\s]*)/i;

function normalizeUrl(raw: string): string {
	return raw.replace("0.0.0.0", "localhost").replace(/\/+$/, "");
}

/** 探测某个地址是否已经能访问 */
export async function isReachable(url: string, timeoutMs = 2000): Promise<boolean> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		await fetch(url, { signal: ac.signal, redirect: "manual" });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export interface DevServer {
	url: string;
	/** 是否由本插件启动（外部已有服务时为 false，不会被关掉） */
	owned: boolean;
	stop: () => void;
	/**
	 * 地址是否确认属于本项目（B0-3）。
	 * false = 端口能连上但无法证实，调用方必须把这个不确定性告知出去，
	 * 不能默默拿它去做双图比对。
	 */
	verified: boolean;
}

export interface StartOptions {
	cwd: string;
	pm: PackageManager;
	script: string;
	/** 等待服务器就绪的超时时间 */
	timeoutMs?: number;
	onLog?: (line: string) => void;
	signal?: AbortSignal;
}

/** 启动 dev server 并等它打印出本地地址 */
export function startDevServer(opts: StartOptions): Promise<DevServer> {
	const { cwd, pm, script, timeoutMs = 90_000, onLog, signal } = opts;

	return new Promise<DevServer>((resolvePromise, rejectPromise) => {
		let child: ChildProcess;
		try {
			child = spawn(pm, runArgs(pm, script), {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
				env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none" },
			});
		} catch (err) {
			rejectPromise(new Error(`无法启动 ${pm} run ${script}：${String(err)}`));
			return;
		}

		let settled = false;
		let buffer = "";

		const stop = () => {
			if (!child.killed) {
				child.kill("SIGTERM");
				// 兜底：部分脚手架会派生子进程，SIGTERM 后仍存活
				setTimeout(() => {
					if (!child.killed) {
						child.kill("SIGKILL");
					}
				}, 3000).unref?.();
			}
		};

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				stop();
				rejectPromise(
					new Error(`等待开发服务器就绪超时（${timeoutMs / 1000}s）。最后输出：\n${buffer.slice(-600)}`),
				);
			}
		}, timeoutMs);

		const onAbort = () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				stop();
				rejectPromise(new Error("已取消"));
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const finish = async (rawUrl: string) => {
			const url = normalizeUrl(rawUrl);
			// 打印出地址不代表立刻可连，轮询确认
			for (let i = 0; i < 20; i++) {
				if (await isReachable(url, 1500)) {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolvePromise({ url, owned: true, stop, verified: true });
					return;
				}
				await new Promise((r) => setTimeout(r, 500));
			}
		};

		const handle = (chunk: Buffer) => {
			const text = stripAnsi(chunk.toString());
			buffer += text;
			onLog?.(text.trim());
			if (settled) {
				return;
			}
			const m = URL_RE.exec(buffer);
			if (m) {
				void finish(m[1]);
			}
		};

		child.stdout?.on("data", handle);
		child.stderr?.on("data", handle);

		child.on("error", (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				rejectPromise(new Error(`开发服务器启动失败：${err.message}`));
			}
		});

		child.on("exit", (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				rejectPromise(new Error(`开发服务器意外退出（code=${code}）。输出：\n${buffer.slice(-600)}`));
			}
		});
	});
}

/**
 * 解析 /ui-screenshot 的目标地址：
 *   - 传完整 URL      → 直接用，不启动任何东西
 *   - 传路径或不传    → 复用已在跑的服务器，没有就自动拉起
 */
export async function resolveTarget(
	arg: string | undefined,
	start: () => Promise<DevServer>,
): Promise<DevServer & { path: string }> {
	const raw = (arg ?? "").trim();

	if (/^https?:\/\//i.test(raw)) {
		return { url: normalizeUrl(raw), owned: false, stop: () => {}, verified: true, path: "" };
	}

	const path = raw.startsWith("/") ? raw : raw ? `/${raw}` : "/";
	const server = await start();
	return { ...server, path };
}
