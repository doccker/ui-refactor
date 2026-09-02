#!/usr/bin/env bash
# 把 pi-ui-refactor 安装到目标前端项目
# 用法：bash install-project.sh /path/to/your/project
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${1:-.}"

if [[ ! -d "$PROJECT" ]]; then
  echo "错误：目标目录不存在：$PROJECT" >&2
  exit 1
fi
PROJECT="$(cd "$PROJECT" && pwd)"

# 安装前预检：v0.1.2 的脚本在源文件缺失时会创建空的 .pi/extensions 后失败，
# 让用户误以为装好了。这里先把所有必需文件检查完再动手。
REQUIRED=(
  ".pi/extensions/redesign-guard.ts"
  ".pi/extensions/ui-guard/analyze.ts"
  ".pi/extensions/ui-guard/bash-guard.ts"
  ".pi/extensions/ui-guard/commands-core.ts"
  ".pi/extensions/ui-guard/commands-telemetry.ts"
  ".pi/extensions/ui-guard/commands-visual.ts"
  ".pi/extensions/ui-guard/detect.ts"
  ".pi/extensions/ui-guard/dev-server.ts"
  ".pi/extensions/ui-guard/edit-recon.ts"
  ".pi/extensions/ui-guard/paths.ts"
  ".pi/extensions/ui-guard/project.ts"
  ".pi/extensions/ui-guard/checks.ts"
  ".pi/extensions/ui-guard/identify.ts"
  ".pi/extensions/ui-guard/loop-state.ts"
  ".pi/extensions/ui-guard/loop.ts"
  ".pi/extensions/ui-guard/prompts.ts"
  ".pi/extensions/ui-guard/shot.ts"
  ".pi/extensions/ui-guard/server-identity.ts"
  ".pi/extensions/ui-guard/state.ts"
  ".pi/extensions/ui-guard/telemetry.ts"
  ".pi/extensions/ui-guard/tool-risk.ts"
  ".pi/extensions/ui-guard/track-command.ts"
  ".ai-protected-paths.txt.example"
)
MISSING=0
for f in "${REQUIRED[@]}"; do
  if [[ ! -f "$ROOT/$f" ]]; then
    echo "错误：缺少源文件 $f" >&2
    MISSING=1
  fi
done
if [[ "$MISSING" -ne 0 ]]; then
  echo "安装已中止，未对目标项目做任何修改。" >&2
  exit 1
fi

if [[ "$PROJECT" == "$ROOT" ]]; then
  cat >&2 <<'MSG'
本仓库自身已经带有 .pi/extensions/，不需要安装。

想在本仓库里试用，直接在这里启动 pi 即可：
    pi
然后在 pi 的交互界面里输入 /ui-init（注意：不是在 shell 里敲）。

想安装到你的前端项目，请把目标项目路径作为参数：
    bash install-project.sh /path/to/your-frontend
MSG
  exit 1
fi

mkdir -p "$PROJECT/.pi/extensions/ui-guard"
cp "$ROOT/.pi/extensions/redesign-guard.ts" "$PROJECT/.pi/extensions/redesign-guard.ts"
cp "$ROOT"/.pi/extensions/ui-guard/*.ts "$PROJECT/.pi/extensions/ui-guard/"

if [[ ! -f "$PROJECT/.ai-protected-paths.txt" ]]; then
  cp "$ROOT/.ai-protected-paths.txt.example" "$PROJECT/.ai-protected-paths.txt"
  echo "已生成 .ai-protected-paths.txt（默认值，请按项目实际情况调整）"
else
  echo "已存在 .ai-protected-paths.txt，保持不变"
fi

mkdir -p "$PROJECT/.ai/screenshots"

echo "pi-ui-refactor v0.3.3 已安装到：$PROJECT"
echo
echo "提示：本插件默认开启匿名使用统计（不收集路径/代码/命令原文）。"
echo "      查看：/ui-telemetry print   关闭：/ui-telemetry off   详情：PRIVACY.md"
echo
echo "下一步（以下 / 开头的都是 pi 交互界面内的命令，不是 shell 命令）："
echo "  1. 在项目目录启动 pi，或在已运行的 pi 内执行 /reload"
echo "  2. 运行 /ui-init      —— 会自动扫描目录树生成受保护路径"
echo "  3. 核对 .ai-protected-paths.txt 的探测结果，按需增删"
echo "  4. 运行 /ui-check     —— 建立基线"
