import { checkPath, DEFAULT_PROTECTED as R } from "../.pi/extensions/ui-guard/paths.ts";
import { analyzeChange } from "../.pi/extensions/ui-guard/analyze.ts";
import { checkBashCommand } from "../.pi/extensions/ui-guard/bash-guard.ts";
import { resolveTarget } from "../.pi/extensions/ui-guard/dev-server.ts";
import { pickDevScript, planCheckTasks, runArgs } from "../.pi/extensions/ui-guard/project.ts";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const cwd = process.cwd();
const t: [string, boolean][] = [];
const ok = (n: string, c: boolean) => t.push([n, c]);

// 路径保护
ok("阻止 src/api/", checkPath(cwd, "src/api/user.ts", R).blocked);
ok("放行 src/apiv2/（不误伤）", !checkPath(cwd, "src/apiv2/user.ts", R).blocked);
ok("放行 src/pages/", !checkPath(cwd, "src/pages/Index.tsx", R).blocked);
ok("阻止 ../ 逃逸", checkPath(cwd, "../../etc/passwd", R).blocked);
ok("阻止 ./src/store/ 变体", checkPath(cwd, "./src/store/auth.ts", R).blocked);
ok("阻止 src/./api/x.ts", checkPath(cwd, "src/./api/x.ts", R).blocked);
ok("阻止 undefined 路径", checkPath(cwd, undefined, R).blocked);

// 业务契约差分
const ui1 = `<div className="p-2 flex"><button onClick={handleSubmit}>提交</button></div>`;
const ui2 = `<div className="px-6 py-4 flex-col gap-3 rounded-lg"><button onClick={handleSubmit}>提交</button></div>`;
ok("纯 className 改动放行", !analyzeChange(ui1, ui2).risky);
const bad = `<div className="p-2"><button onClick={handleDelete}>提交</button></div>`;
ok("事件目标被换掉→拦截", analyzeChange(ui1, bad).risky);
const addImp = `import x from "../.pi/user";\n${ui1}`;
ok("新增 import→拦截", analyzeChange(ui1, addImp).risky);
ok("注释内容变化不误报", !analyzeChange(`// 旧注释\n${ui1}`, `// 新的注释文案\n${ui1}`).risky);

// Vue SFC：事件目标写在引号里，曾因先抹字符串导致完全漏护
const vue1 = '<template><div class="p-2"><button @click="handleSubmit">提交</button></div></template>';
const vue2 = '<template><div class="px-6 py-4"><button @click="handleSubmit">提交</button></div></template>';
const vue3 = '<template><div class="p-2"><button @click="handleDelete">提交</button></div></template>';
ok("Vue 纯 class 改动放行", !analyzeChange(vue1, vue2).risky);
ok("Vue @click 目标被偷换→拦截", analyzeChange(vue1, vue3).risky);
ok(
	"Vue 修饰符事件目标被偷换→拦截",
	analyzeChange('<form @submit.prevent="onSave" />', '<form @submit.prevent="onDrop" />').risky,
);
ok(
	"Vue v-model 绑定被改→拦截",
	analyzeChange('<input v-model="form.name" />', '<input v-model="form.password" />').risky,
);
ok(
	"v-on:click 写法同样生效",
	analyzeChange('<b v-on:click="save" />', '<b v-on:click="remove" />').risky,
);

// bash
ok("阻止 sed -i 改 api", checkBashCommand("sed -i '' 's/a/b/' src/api/u.ts", cwd, R).blocked);
ok("阻止 cat > store", checkBashCommand("cat > src/store/auth.ts", cwd, R).blocked);
ok("阻止 git checkout -- api", checkBashCommand("git checkout HEAD~1 -- src/api/", cwd, R).blocked);
ok("阻止命令替换", checkBashCommand("rm $(cat list.txt)", cwd, R).blocked);
ok("阻止通配符写", checkBashCommand("rm -rf src/*", cwd, R).blocked);
ok("阻止解释器", checkBashCommand("python3 -c \"open('x','w')\"", cwd, R).blocked);
ok("放行 git status", !checkBashCommand("git status --porcelain", cwd, R).blocked);
ok("放行 npm run build", !checkBashCommand("npm run build", cwd, R).blocked);
ok("放行 grep", !checkBashCommand("grep -rn foo src/pages", cwd, R).blocked);
ok("放行 sed 无 -i", !checkBashCommand("sed 's/a/b/' src/api/u.ts", cwd, R).blocked);

// npx 绕过漏洞：`npx node -e '...'` 与 `node -e '...'` 等价，不封则路径保护形同虚设。
// 同时必须保证 npm run 类命令仍放行，否则前端项目没法构建。
ok("拦截 npx（可执行任意代码）", checkBashCommand("npx tsx foo.ts", cwd, R).blocked);
ok("拦截 bunx", checkBashCommand("bunx some-cli", cwd, R).blocked);
ok("拦截 pnpm dlx", checkBashCommand("pnpm dlx some-cli", cwd, R).blocked);
ok("拦截 yarn dlx", checkBashCommand("yarn dlx some-cli", cwd, R).blocked);
ok("拦截 npm exec", checkBashCommand("npm exec some-cli", cwd, R).blocked);
ok("放行 npm install（非 exec 子命令）", !checkBashCommand("npm install", cwd, R).blocked);
ok("放行 pnpm run dev", !checkBashCommand("pnpm run dev", cwd, R).blocked);
ok("放行 yarn test", !checkBashCommand("yarn test", cwd, R).blocked);

// 宽松档（off 模式，v0.3.0 方案 ①）：只拦确定命中受保护路径的写入。
// 背景：旧版 off 模式拦 node/npx 且 /ui-allow-bash 拒绝切换，用户无解。
ok("lenient 放行 node（日常开发不能废）", !checkBashCommand("node build.js", cwd, R, "lenient").blocked);
ok("lenient 放行 npx", !checkBashCommand("npx tsx foo.ts", cwd, R, "lenient").blocked);
ok("lenient 仍拦 sed -i 写受保护路径", checkBashCommand("sed -i '' 's/a/b/' src/api/u.ts", cwd, R, "lenient").blocked);
ok("lenient 仍拦重定向到受保护路径", checkBashCommand("echo x > src/api/a.ts", cwd, R, "lenient").blocked);
ok("lenient 仍拦 git checkout 受保护目录", checkBashCommand("git checkout -- src/api/", cwd, R, "lenient").blocked);
ok("lenient 仍拦通配符前缀命中（rm src/api/*）", checkBashCommand("rm src/api/*", cwd, R, "lenient").blocked);
ok("lenient 放行通配符前缀未命中（rm dist/*）", !checkBashCommand("rm dist/*", cwd, R, "lenient").blocked);
ok("lenient 放行写非保护路径", !checkBashCommand("echo hi > /tmp/x.txt", cwd, R, "lenient").blocked);
ok("strict 默认值不变（node 仍拦）", checkBashCommand("node build.js", cwd, R).blocked);
ok("strict 仍拦项目外写入（escape 标志不影响严格档）", checkBashCommand("echo hi > /tmp/x.txt", cwd, R).blocked);

// 以下两条来自真实运行中的误拦截
ok(
	"2>/dev/null 不算写操作（真实误报）",
	!checkBashCommand("find /Users/example/.pi -type f -iname '*.md' 2>/dev/null | head -80", cwd, R).blocked,
);
ok(
	"2>&1 不算写操作",
	!checkBashCommand("npm run build 2>&1 | tail -5", cwd, R).blocked,
);
ok(
	"rmdir 纯目录名可解析（真实误报）",
	!checkBashCommand("rmdir .playwright-mcp", cwd, R).blocked,
);
ok(
	"rm 纯文件名可解析",
	!checkBashCommand("rm proxy-before.png proxy-round-1.png", cwd, R).blocked,
);
// 修复后仍须拦住的场景
ok(
	"真实重定向写受保护文件仍拦",
	!!checkBashCommand("echo x > src/api/user.ts 2>/dev/null", cwd, R).blocked,
);
ok(
	"重定向时只看重定向目标，不误伤只读参数",
	!checkBashCommand("cat src/api/user.ts > /tmp/out.txt", cwd, R).blocked === false ||
		checkBashCommand("cat src/pages/a.vue > notes.txt", cwd, R).blocked === false,
);
ok(
	"rmdir 受保护目录仍拦",
	!!checkBashCommand("rmdir src/api", cwd, R).blocked,
);

// 校验任务规划（6 个真实项目中 5 个只有 build）
const full = planCheckTasks({ "type-check": "tsc --noEmit", lint: "eslint .", build: "vite build" });
ok("有 typecheck+lint 时不跑 build", full.length === 2 && !full.some((x) => x.fallback));
const onlyBuild = planCheckTasks({ build: "vue-tsc -b && vite build", preview: "vite preview" });
ok("只有 build 时回退到 build", onlyBuild.length === 1 && onlyBuild[0].fallback === true);
ok("什么都没时不凭空造任务", planCheckTasks({ preview: "vite preview" }).length === 0);
ok("yarn 不带 run 前缀", runArgs("yarn", "dev")[0] === "dev");
ok("npm 带 run 前缀", runArgs("npm", "dev")[0] === "run");
ok("dev 脚本识别", pickDevScript({ serve: "vite" }) === "serve" && pickDevScript({ build: "x" }) === null);

// 截图目标解析：传完整 URL 时绝不能去启动 dev server
let started = false;
const boom = async () => {
	started = true;
	return { url: "http://never", owned: true, stop: () => {} };
};
const direct = await resolveTarget("http://localhost:9999/admin", boom);
ok("传完整 URL 时不拉起 dev server", !started && direct.url === "http://localhost:9999/admin" && !direct.owned);
const viaPath = await resolveTarget("login", async () => ({ url: "http://localhost:5173", owned: true, stop: () => {} }));
ok("传路径时拼接到 dev server 地址", viaPath.url === "http://localhost:5173" && viaPath.path === "/login");

// 识别输出解析（含真实运行里模型的实际格式）
const { parseIdentity } = await import("../.pi/extensions/ui-guard/identify.ts");
const realOutput = [
	"CANDIDATE: src/components/DataListPanel.vue | 列表表格与截图结构最接近",
	"CANDIDATE: src/assets/styles/data-list.css | 该表格唯一样式来源",
	"ROUTE: /",
	"STEPS: 启动后在首页点击左侧栏“数据管理” → 选中“数据管理”页签 → 点击“数据列表”子页签",
	"GAPS: 缺分组、来源、字段拆分与自动刷新",
	"CANDIDATE_END",
].join("\n");
const pid = parseIdentity(realOutput);
ok("解析真实输出：候选", pid.candidates.length === 2 && pid.candidates[0].path.endsWith("DataListPanel.vue"));
ok("解析真实输出：ROUTE", pid.route === "/");
ok("解析真实输出：STEPS不为空（决定是否委托截图）", pid.steps.includes("数据列表"));
ok("解析真实输出：GAPS", pid.gaps.includes("分组"));
ok("STEPS 为“无”时不误判为需导航", parseIdentity("STEPS: 无\nCANDIDATE_END").steps === "无");

// ---------------- telemetry 隐私红线 ----------------
// 这组断言是硬性门槛：本插件能看到用户的私有代码，
// 一旦埋点把路径/命令/文件名传出去就是安全事故。
const { sanitize, normVersion, isAnonymousId, createTelemetry } = await import(
	"../.pi/extensions/ui-guard/telemetry.ts"
);

ok("sanitize 丢弃文件路径", sanitize({ p: "src/api/user.ts" }).p === undefined);
ok("sanitize 丢弃命令原文", sanitize({ c: "sed -i s/a/b/ x.ts" }).c === undefined);
ok("sanitize 丢弃裸文件名（含点）", sanitize({ f: "user.ts" }).f === undefined);
ok("sanitize 丢弃中文描述", sanitize({ n: "业务目录 src/api/" }).n === undefined);
ok("sanitize 丢弃驼峰组件名", sanitize({ c: "DataListPanel" }).c === undefined);
ok("sanitize 丢弃超长字符串", sanitize({ s: "a".repeat(40) }).s === undefined);
ok("sanitize 丢弃 NaN", sanitize({ n: Number.NaN }).n === undefined);
ok("sanitize 丢弃对象", sanitize({ o: { a: 1 } }).o === undefined);
ok("sanitize 保留枚举", sanitize({ k: "recon_fail" }).k === "recon_fail");
ok("sanitize 保留数字与布尔", sanitize({ n: 3, b: true }).n === 3 && sanitize({ b: true }).b === true);
ok("normVersion 去掉小数点", normVersion("0.84.3") === "0_84_3");
ok("isAnonymousId 只认 UUID", isAnonymousId("550e8400-e29b-41d4-a716-446655440000"));
ok("isAnonymousId 拒绝主机名", !isAnonymousId("my-macbook-pro.local"));

// 关闭时必须零网络请求
const realFetch = globalThis.fetch;
let fetchCount = 0;
let lastBody = "";
globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
	fetchCount++;
	lastBody = String(init?.body ?? "");
	return { ok: true } as unknown as Response;
}) as typeof fetch;

process.env.PI_UI_REFACTOR_TELEMETRY = "0";
const offT = await createTelemetry({ cwd, version: "0.2.4", piVersion: "0.84.3" });
offT.track({ name: "guard_blocked", kind: "path" });
await offT.flush();
ok("关闭时零网络请求", fetchCount === 0);
ok("关闭时队列为空", offT.pending().length === 0);

// 开启时的上报体必须不含任何路径与命令原文
process.env.PI_UI_REFACTOR_TELEMETRY = "1";
const onT = await createTelemetry({ cwd, version: "0.2.4", piVersion: "0.84.3" });
onT.track({ name: "guard_blocked", kind: "bash" });
await onT.flush();
ok("开启时确实上报", fetchCount === 1);
ok("上报体不含斜杠路径", !/"[^"]*\/[^"]*\.(ts|vue|tsx|js)"/.test(lastBody));
ok("上报体不含当前工作目录", !lastBody.includes(cwd));
ok("上报体不含主机名", !lastBody.includes(hostname()));
ok("上报体含预期事件名", lastBody.includes("guard_blocked"));

// ---------------------------------------------------------------------------
// 版本号一致性：忘记同步会让所有用户上报的 version 停在旧值，
// PostHog 里无法按版本区分修复效果（2026-09-01 真实发生：v0.3.1 上报成 0_3_0）
{
	const { PLUGIN_VERSION, readPiVersion } = await import(
		"../.pi/extensions/ui-guard/telemetry.ts"
	);
	const pkg = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf-8"),
	) as { version: string };
	ok(`PLUGIN_VERSION(${PLUGIN_VERSION}) 与 package.json(${pkg.version}) 一致`, PLUGIN_VERSION === pkg.version);
	// pi_version 丢失 = degraded 告警响了也不知道是 pi 哪个版本打挂的
	ok("pi_version 可解析（不是 unknown）", (await readPiVersion()) !== "unknown");
}

// 安装形态（B0-4）：pi install git: 落地目录没有 node_modules，
// 本仓库和 CI 都恰好能解析到 pi，所以这个缺陷在常规测试里永远看不见。
// 必须把模块拷到一个无 node_modules 的临时目录再加载，才能真正挡住 B0-1 复发。
{
	const dir = await mkdtemp(join(tmpdir(), "ui-refactor-install-"));
	await copyFile(
		new URL("../.pi/extensions/ui-guard/edit-recon.ts", import.meta.url),
		join(dir, "edit-recon.ts"),
	);
	const mod = await import(pathToFileURL(join(dir, "edit-recon.ts")).href);
	const loaded = await mod.loadEditDiff();
	ok("无 node_modules 的安装目录下仍能加载 edit-diff（B0-1）", loaded !== null);
	ok(
		"加载到的 splitBom 语义正确（返回 {bom,text}）",
		loaded !== null && loaded.stripBom("\uFEFFa").text === "a",
	);
	await rm(dir, { recursive: true, force: true });
}

// MCP 侧任意代码执行入口（B0-2）
{
	const { detectCodeExecRisk, isGlobalStyleFile } = await import(
		"../.pi/extensions/ui-guard/tool-risk.ts"
	);
	ok(
		"拦截 playwright run_code_unsafe",
		detectCodeExecRisk("playwright_browser_run_code_unsafe", {}).blocked,
	);
	ok("拦截 mcpScript", detectCodeExecRisk("mcp__pi__mcpScript", { code: "x" }).blocked);
	ok(
		"拦截经网关转发的 run_code_unsafe",
		detectCodeExecRisk("mcp", { tool: "browser_run_code_unsafe", args: {} }).blocked,
	);
	ok(
		"放行 playwright 截图（委托截图链路不能断）",
		!detectCodeExecRisk("playwright_browser_take_screenshot", { filename: "a.png" }).blocked,
	);
	ok(
		"放行普通导航",
		!detectCodeExecRisk("playwright_browser_navigate", { url: "http://localhost:5173" }).blocked,
	);
	ok("内置 edit 不走 MCP 判定", !detectCodeExecRisk("edit", { path: "a.ts" }).blocked);

	// 全局样式影响面（B0-6）
	ok("src/styles.css 判为全局", isGlobalStyleFile("apps/web/src/styles.css"));
	ok("tailwind.config.ts 判为全局", isGlobalStyleFile("tailwind.config.ts"));
	ok(
		"组件私有样式不算全局",
		!isGlobalStyleFile("apps/web/src/components/ip-results.css"),
	);
	ok("视图私有样式不算全局", !isGlobalStyleFile("src/views/lookup-view.css"));
}

// dev server 归属（B0-3）
{
	const { discoverProjectPorts, readProjectTitle, checkServerIdentity } = await import(
		"../.pi/extensions/ui-guard/server-identity.ts"
	);
	const dir = await mkdtemp(join(tmpdir(), "ui-refactor-ports-"));
	await mkdir(join(dir, "apps", "web"), { recursive: true });
	await writeFile(
		join(dir, "apps", "web", "package.json"),
		JSON.stringify({ scripts: { dev: "vite --port 11966" } }),
	);
	await writeFile(
		join(dir, "apps", "web", "index.html"),
		"<html><head><title>My Project</title></head></html>",
	);
	const ports = await discoverProjectPorts(dir);
	ok("从 monorepo 子包配置里发现真实端口", ports.includes(11966));
	ok("项目标题指纹可读", (await readProjectTitle(dir)) === "My Project");
	ok(
		"端口没起服务时判为 unknown（不复用）",
		(await checkServerIdentity("http://localhost:1", "My Project", 300)) === "unknown",
	);
	await rm(dir, { recursive: true, force: true });
}

globalThis.fetch = realFetch;
process.env.PI_UI_REFACTOR_TELEMETRY = "0";

let fail = 0;
for (const [n, c] of t) { if (!c) fail++; console.log(`${c ? "  ✓" : "  ✗"} ${n}`); }
console.log(`\n${t.length - fail}/${t.length} 通过`);
process.exit(fail ? 1 : 0);
