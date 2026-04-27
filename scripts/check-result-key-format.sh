#!/usr/bin/env bash
# check-result-key-format.sh
# result-filename-extension-preservation の resultKey / output_path 旧フォーマット
# ({stem}.json) の取り残しを CI で検出する契約ガード (Task 5.1)。
#
# 旧仕様: batches/{id}/output/{stem}.json (拡張子なし basename)
# 新仕様: batches/{id}/output/{原本ファイル名}.json (例: report.pdf.json / deck.pptx.json)
#
# 検出パターン:
#   A. Python f-string で {stem}.json / {file_stem}.json を組み立てる構築式
#      (例: output_dir / f"{stem}.json")
#   B. "output/<basename>.json" リテラルで basename portion に "." を含まないもの
#      マッチ:    output/a.json, output/sample.json, output/report.json
#      非マッチ:  output/a.pdf.json (新仕様), output/deck.pptx.json (新仕様)
#
# 除外:
#   - 同行に `legacy-on-purpose` コメントを持つ行 (R5.1/R5.2 検証用の意図的旧仕様)
#   - .kiro/, node_modules/, .git/, cdk.out/, docs/archive/, test/
#   - scripts/check-result-key-format.sh (本 script 自身)
#   - **/.venv/** (yomitoku-client 同梱の Python venv は対象外)
#
# 違反 1 件以上で exit 1、ゼロで exit 0。

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

# Pattern A: Python f-string で {stem}.json or {file_stem}.json を組み立てる構築式
PATTERN_A='f"\{(file_)?stem\}\.json"'

# Pattern B: "output/<basename>.json" で basename に "." を含まないもの
#   ([a-zA-Z0-9_-]+ は "." を含まない char class なので、新仕様 {name}.{ext}.json は
#    {name} 内の "." で char class マッチが切れて非マッチ)
#   末尾境界 (["'),\s] のいずれか) で .json と .jsonl の誤マッチを防ぐ
PATTERN_B='output/[a-zA-Z0-9_-]+\.json["'"'"'),[:space:]]'

# 除外 pathspec (git grep の ':!' 構文)
EXCLUDES=(
  ':!.kiro/'
  ':!node_modules/'
  ':!.git/'
  ':!cdk.out/'
  ':!scripts/check-result-key-format.sh'
  ':!test/'
  ':!docs/archive/'
  ':!**/.venv/**'
  # 旧設計検討資料 (履歴保持のため除外。check-legacy-refs.sh と同方針)
  ':!YomiToku-Pro_AWS構築検討.md'
)

FOUND=0

# Pattern A 検出 (legacy-on-purpose マーカ付き行は除外)
matches_a=$(git -C "$REPO_ROOT" grep -nE -- "$PATTERN_A" "${EXCLUDES[@]}" 2>/dev/null \
  | grep -v 'legacy-on-purpose' || true)
if [ -n "$matches_a" ]; then
  echo "❌  Legacy {stem}.json f-string construction found:"
  echo "$matches_a" | head -10 | sed 's/^/     /'
  FOUND=1
fi

# Pattern B 検出 (legacy-on-purpose マーカ付き行は除外)
matches_b=$(git -C "$REPO_ROOT" grep -nE -- "$PATTERN_B" "${EXCLUDES[@]}" 2>/dev/null \
  | grep -v 'legacy-on-purpose' || true)
if [ -n "$matches_b" ]; then
  echo "❌  Legacy 'output/<basename>.json' literal (without extension preserved) found:"
  echo "$matches_b" | head -10 | sed 's/^/     /'
  FOUND=1
fi

echo ""
if [ "$FOUND" -eq 1 ]; then
  echo "✗  Legacy {stem}.json reference detected. Update to {原本ファイル名}.json (e.g., a.pdf.json)."
  echo "    See .kiro/specs/result-filename-extension-preservation/ for the new naming convention."
  echo "    意図的に旧フォーマットを使う場合は同行に '# legacy-on-purpose' コメントを追加。"
  exit 1
else
  echo "✓  No legacy {stem}.json references found."
  exit 0
fi
