#!/usr/bin/env bash
# check-legacy-refs.sh
# 旧 API・DDB・S3 キーの禁止語が残存していないか git grep で検査する CI ガード。
# 禁止語が 1 件でも見つかった場合は非ゼロで終了する。
# クリーンな状態（禁止語ゼロ）ではゼロで終了する。
#
# 除外パス:
#   - .kiro/                       : 仕様書・設計資料（履歴保持のため）
#   - node_modules/, .git/, cdk.out/
#   - scripts/check-legacy-refs.sh : 本スクリプト自身
#   - test/                        : 旧リソースの不在を検証するネガティブ assert を含むため
#   - docs/archive/                : 旧設計資料のアーカイブ置き場（履歴保持のため）

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

# 禁止語リスト（実コード内での旧 API 参照を検出する）
# S3 プレフィックス系は `"input/{`・`"output/{`・`"visualizations/{` のように
# 文字列リテラルの先頭に来る形のみを対象とし、`batches/{id}/input/{...}` の
# ように `/input/` を内部に持つ新方式の正当な利用は誤検知しない。
FORBIDDEN_PATTERNS=(
  '"/jobs"'                # Hono ルート登録 app.route("/jobs", ...)
  'StatusTable'            # 旧 DynamoDB テーブル名
  '"job_id"'               # 旧 DDB パーティションキー
  'MainQueue'              # 旧 SQS キュー名
  'ProcessorFunction'      # 旧 Lambda 関数名
  '"input/{'               # 旧 S3 キーテンプレート（トップレベル input/）
  '"output/{'              # 旧 S3 キーテンプレート（トップレベル output/）
  '"visualizations/{'      # 旧 S3 キーテンプレート（トップレベル visualizations/）
)

# 除外 pathspec（git grep の ':!' 構文）
# README.md は migration 経緯・旧 API 言及を履歴として残す可能性があるため除外。
# 実コードに旧参照が残存していないことを保証するのが本スクリプトの目的であり、
# 人間向けドキュメントの表記ゆれまで CI で止める必要はない (L5)。
EXCLUDES=(
  ':!.kiro/'
  ':!node_modules/'
  ':!.git/'
  ':!cdk.out/'
  ':!scripts/check-legacy-refs.sh'
  ':!test/'
  ':!docs/archive/'
  ':!README.md'
  ':!**/README.md'
)

FOUND=0

for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  # --ignore-case は使わず大小文字を区別する
  if git -C "$REPO_ROOT" grep --quiet -F "$pattern" -- "${EXCLUDES[@]}" 2>/dev/null; then
    echo "❌  Legacy reference found: $pattern"
    # 該当ファイルを表示（最大 5 件）
    git -C "$REPO_ROOT" grep -F -l "$pattern" -- "${EXCLUDES[@]}" 2>/dev/null \
      | head -5 \
      | sed 's/^/     /'
    FOUND=1
  fi
done

echo ""
if [ "$FOUND" -eq 1 ]; then
  echo "✗  Legacy references detected. Remove or update the above files before merging."
  exit 1
else
  echo "✓  No legacy references found."
  exit 0
fi
