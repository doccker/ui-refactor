/**
 * 业务契约差分（对应审查报告 P2-7）。
 *
 * 不使用「出现 useState 就危险」这类关键字启发式——误报率高会把用户训练成无脑确认。
 * 改为提取「业务契约指纹」并比对改动前后：
 *   - import 语句集合
 *   - 函数调用名多重集合
 *   - 事件绑定目标（React onX={...} / Vue @x="..." ）
 *   - await 数量
 * 纯 className / DOM 结构 / CSS 改动不会改变以上任何一项，因此不会误报。
 */

const UI_ONLY_CALLS = new Set([
	"clsx",
	"cn",
	"classNames",
	"cva",
	"twMerge",
	"tw",
	"styled",
	"css",
	"keyframes",
	"useId",
	"Boolean",
	"String",
	"Number",
	"Array",
	"map",
	"filter",
	"join",
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"typeof",
	"require",
]);

export interface Fingerprint {
	imports: string[];
	calls: string[];
	handlers: string[];
	awaits: number;
}

/** 只剥离注释，保留字符串字面量（import 路径依赖引号内容） */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** 在剥离注释的基础上再抹平字符串字面量，用于调用/事件绑定提取 */
function stripNoise(src: string): string {
	return stripComments(src)
		.replace(/`(?:\\.|[^`\\])*`/g, "``")
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function extractImports(src: string): string[] {
	const out: string[] = [];
	const re = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: 惯用的正则遍历
	while ((m = re.exec(src)) !== null) {
		const names = m[1].replace(/\s+/g, " ").trim();
		out.push(`${names} <- ${m[2]}`);
	}
	const bare = /import\s+["']([^"']+)["']/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: 惯用的正则遍历
	while ((m = bare.exec(src)) !== null) {
		out.push(`<- ${m[1]}`);
	}
	const dyn = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: 惯用的正则遍历
	while ((m = dyn.exec(src)) !== null) {
		out.push(`dynamic <- ${m[1]}`);
	}
	return out.sort();
}

function extractCalls(src: string): string[] {
	const out: string[] = [];
	const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: 惯用的正则遍历
	while ((m = re.exec(src)) !== null) {
		const name = m[1];
		if (UI_ONLY_CALLS.has(name)) {
			continue;
		}
		out.push(name);
	}
	return out.sort();
}

/**
 * 提取事件绑定目标。
 *
 * 必须跑在保留字符串字面量的文本上。Vue 的 @click="handleSubmit" 目标名就在引号里，
 * 若先把字符串抹成空串，@click="handleSubmit" 与 @click="handleDelete" 会得到同一个指纹，
 * 于是「偷换提交为删除」这类改动会被完全放行。
 */
function extractHandlers(src: string): string[] {
	const out: string[] = [];
	let m: RegExpExecArray | null;
	// React / JSX: onClick={handleSubmit}
	const jsx = /\b(on[A-Z][\w]*)\s*=\s*\{([^}]{0,200})\}/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: 惯用的正则遍历
	while ((m = jsx.exec(src)) !== null) {
		out.push(`${m[1]}=${m[2].replace(/\s+/g, "")}`);
	}
	// Vue: @click="handleSubmit" / v-on:click="..." / @submit.prevent="onSave"
	const vue = /(?:@|v-on:)([\w.:-]+)\s*=\s*("[^"]*"|'[^']*')/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: 惯用的正则遍历
	while ((m = vue.exec(src)) !== null) {
		out.push(`@${m[1]}=${m[2].slice(1, -1).replace(/\s+/g, "")}`);
	}
	// Vue 动态绑定的业务入参：:model-value="form.x" / v-model="form.x"
	const vmodel = /\bv-model(?::[\w.-]+)?\s*=\s*("[^"]*"|'[^']*')/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: 惯用的正则遍历
	while ((m = vmodel.exec(src)) !== null) {
		out.push(`v-model=${m[1].slice(1, -1).replace(/\s+/g, "")}`);
	}
	return out.sort();
}

export function fingerprint(src: string): Fingerprint {
	const clean = stripNoise(src);
	const withStrings = stripComments(src);
	return {
		// import 与事件绑定必须在保留引号内容的文本上提取，否则模块路径与
		// Vue 的 handler 名会被抹成空串，改动变得不可见
		imports: extractImports(withStrings),
		calls: extractCalls(clean),
		handlers: extractHandlers(withStrings),
		awaits: (clean.match(/\bawait\b/g) ?? []).length,
	};
}

function diffMultiset(before: string[], after: string[]): { added: string[]; removed: string[] } {
	const count = new Map<string, number>();
	for (const b of before) {
		count.set(b, (count.get(b) ?? 0) + 1);
	}
	const added: string[] = [];
	for (const a of after) {
		const c = count.get(a) ?? 0;
		if (c > 0) {
			count.set(a, c - 1);
		} else {
			added.push(a);
		}
	}
	const removed: string[] = [];
	for (const [k, c] of count) {
		for (let i = 0; i < c; i++) {
			removed.push(k);
		}
	}
	return { added, removed };
}

export interface RiskReport {
	risky: boolean;
	reasons: string[];
}

const MAX_SAMPLE = 6;

function sample(items: string[]): string {
	const head = items.slice(0, MAX_SAMPLE).join(", ");
	return items.length > MAX_SAMPLE ? `${head} …(共 ${items.length} 项)` : head;
}

export function analyzeChange(before: string, after: string): RiskReport {
	if (before === after) {
		return { risky: false, reasons: [] };
	}
	const fb = fingerprint(before);
	const fa = fingerprint(after);
	const reasons: string[] = [];

	const imp = diffMultiset(fb.imports, fa.imports);
	if (imp.added.length > 0) {
		reasons.push(`新增 import：${sample(imp.added)}`);
	}
	if (imp.removed.length > 0) {
		reasons.push(`移除 import：${sample(imp.removed)}`);
	}

	const call = diffMultiset(fb.calls, fa.calls);
	if (call.added.length > 0) {
		reasons.push(`新增函数调用：${sample(call.added)}`);
	}
	if (call.removed.length > 0) {
		reasons.push(`移除函数调用：${sample(call.removed)}`);
	}

	const h = diffMultiset(fb.handlers, fa.handlers);
	if (h.added.length > 0 || h.removed.length > 0) {
		reasons.push(`事件绑定变化：+[${sample(h.added)}] -[${sample(h.removed)}]`);
	}

	if (fb.awaits !== fa.awaits) {
		reasons.push(`await 数量 ${fb.awaits} -> ${fa.awaits}`);
	}

	return { risky: reasons.length > 0, reasons };
}
