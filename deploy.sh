#!/bin/bash
# 一键更新布丁课程表线上版本
# 用法: ./deploy.sh "本次修改说明"
set -e

cd "$(dirname "$0")"

MSG="${1:-更新课程表}"

# gh 的配置目录（~/.config 被系统权限限制，改用这个位置）
export GH_CONFIG_DIR="$HOME/.workbuddy-ai/ghconfig"
GH_BIN="$HOME/.local/bin/gh"

git add -A
if git diff --cached --quiet; then
  echo "没有改动需要提交"
else
  git -c commit.gpgsign=false commit -m "$MSG"
fi

git push origin main
echo ""
echo "✓ 已推送，约 1 分钟后生效"
echo "  地址: https://11331139-lizzie.github.io/buding-schedule/"
echo ""
echo "查看构建状态:"
"$GH_BIN" api "repos/11331139-Lizzie/buding-schedule/pages" --jq '.status' 2>/dev/null || true
