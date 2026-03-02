# YomiToku 調査レポート

## 概要

**YomiToku**（読み解く）は、日本語に特化したAIベースの文書画像解析（Document AI）Pythonパッケージです。画像内の文字の全文OCRおよびレイアウト解析機能を備え、文字情報や図表を認識・抽出・変換します。

- **開発者**: Kotaro Kinoshita
- **GitHub**: https://github.com/kotaro-kinoshita/yomitoku
- **公式ドキュメント**: https://kotaro-kinoshita.github.io/yomitoku/en/
- **最新バージョン**: v0.11.0（2026年2月18日）
- **ライセンス**: CC BY-NC-SA 4.0（非商用利用は自由、商用は別途ライセンス）

---

## 開発背景

海外ではOCRや文書画像解析サービスが活発にリリースされている一方、日本語文書には以下の固有の課題があります：

- ひらがな・カタカナ・漢字・記号など **数千種類の文字** の識別が必要
- **縦書き** など日本語ドキュメント特有のレイアウトへの対応
- RAGやLLM連携での文書データ活用ニーズの増加

海外の開発者がこれらに対処する可能性は低いため、国産の日本語最適化ソリューションとして開発されました。

---

## 搭載AIモデル

日本語データセットで独自に学習された4種類のAIモデルを搭載しています。

| モデル | 機能 |
|--------|------|
| **テキスト検出（Text Detection）** | 画像内の文字位置を検知 |
| **テキスト認識（Text Recognition）** | 検出された文字列を認識 |
| **レイアウト解析（Layout Analysis）** | 段落・図表・見出し等の文書構造を解析 |
| **表構造認識（Table Structure Recognition）** | 表のセル構造・行列を認識 |

### 対応範囲

- **7,000文字以上** の日本語文字認識をサポート
- **縦書き** レイアウトに対応
- **手書き文字** の認識（v0.8.0以降）
- 印刷文字と手書き文字を **単一モデルで同時認識** 可能

---

## 主要機能

### OCR・文書解析
- 全文OCR（印刷文字・手書き文字）
- レイアウト解析と読み順推定（意味構造の保持）
- 表構造の認識・抽出
- 図表・画像の抽出
- ルビ（振り仮名）の除外オプション

### 出力形式
| 形式 | 説明 |
|------|------|
| **JSON** | 構造化データ出力 |
| **HTML** | Web表示用 |
| **Markdown** | ドキュメント用 |
| **CSV** | 表データ用 |
| **Searchable PDF** | テキスト検索・コピー可能なPDF（v0.9.3以降） |

### YomiToku Extractor（v0.11.0 ベータ）
帳票画像やPDFからYAMLスキーマに基づいて構造化データを抽出する機能。

- **Rule-based**（`yomitoku_extract`）: LLM不要。キーバリュー検索、グリッドマッチング、正規表現を使用
- **LLM-based**（`yomitoku_extract_with_llm`）: vLLMを使用した柔軟な抽出

---

## 動作環境

| 項目 | 要件 |
|------|------|
| **Python** | 3.8以上（3.13もサポート） |
| **PyTorch** | 2.5以上 |
| **CUDA** | 11.8以上（GPU利用時） |
| **VRAM** | 8GB未満で動作 |
| **対応デバイス** | CUDA（GPU）/ CPU / MPS（Apple Silicon, v0.11.0以降） |

> CPUでも動作しますが処理速度が遅くなるため、GPU利用が推奨されます。v0.10.1以降、CPU推論向けに最適化された軽量モデル（Lite）が利用可能です。

---

## インストール

```bash
pip install yomitoku
```

Extractor機能を使う場合：

```bash
pip install yomitoku[extract]
```

---

## 使い方

### CLI（コマンドライン）

```bash
# 基本的な使い方（Markdown出力）
yomitoku ${path_data} -f md -o results -v --figure

# 軽量モデルでCPU推論
yomitoku ${path_data} -f md --lite -d cpu -o results -v --figure
```

#### CLIオプション一覧

| オプション | 説明 |
|-----------|------|
| `--format / -f` | 出力形式（json, csv, html, md, pdf） |
| `--outdir / -o` | 出力ディレクトリ |
| `--vis / -v` | 結果を可視化 |
| `--lite` | 軽量モデルを使用 |
| `--device / -d` | 実行デバイス（cuda / cpu / mps） |
| `--figure` | 図表・画像を抽出 |
| `--figure_letter` | 図中のテキストも抽出 |
| `--encoding` | ファイルエンコーディング指定 |
| `--combine` | 複数ページPDFの結果を統合 |
| `--ignore_ruby` | ルビ（振り仮名）を除外 |

### Python API

3つの主要クラスが提供されています。

#### DocumentAnalyzer（統合解析）

OCRとレイアウト分析を統合し、段落・表構造の分析や図表検出を実行します。

```python
import cv2
from yomitoku import DocumentAnalyzer
from yomitoku.data.functions import load_pdf

PATH_IMAGE = "demo/sample.pdf"
analyzer = DocumentAnalyzer(visualize=True, device="cuda")
imgs = load_pdf(PATH_IMAGE)

for i, img in enumerate(imgs):
    results, ocr_vis, layout_vis = analyzer(img)

    # 各種形式で出力
    results.to_html(f"output_{i}.html", img=img)
    results.to_markdown(f"output_{i}.md")
    results.to_json(f"output_{i}.json")

    # 可視化結果を保存
    cv2.imwrite(f"output_ocr_{i}.jpg", ocr_vis)
    cv2.imwrite(f"output_layout_{i}.jpg", layout_vis)
```

#### OCR（テキスト検出・認識のみ）

```python
from yomitoku import OCR

ocr = OCR(device="cuda")
results = ocr(img)
# JSON形式のみ出力対応
```

#### LayoutAnalyzer（レイアウト解析のみ）

```python
from yomitoku import LayoutAnalyzer

layout = LayoutAnalyzer(device="cuda")
results = layout(img)
# JSON形式のみ出力対応
```

#### 共通設定オプション

| オプション | 型 | 説明 |
|-----------|------|------|
| `visualize` | bool | 処理結果の可視化 |
| `device` | str | "cuda" / "cpu" / "mps" |
| `configs` | dict | 詳細パラメータ設定（YAML設定ファイルも指定可能） |

#### DocumentAnalyzer固有オプション

| オプション | 型 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `ignore_ruby` | bool | False | ルビ（振り仮名）を除外 |
| `ruby_threshold` | float | 0.5 | ルビ検出の閾値比率 |

---

## バージョン履歴

| バージョン | リリース日 | 主な変更内容 |
|-----------|-----------|-------------|
| **v0.11.0** | 2026-02-18 | YomiToku Extractor（ベータ版）、MPS（Apple Silicon）サポート |
| **v0.10.3** | 2025-12-17 | CPU推論時の軽量モデルの不具合修正 |
| **v0.10.2** | 2025-12-01 | Python 3.13サポート、商用利用ガイドライン追加 |
| **v0.10.1** | 2025-11-05 | Text Recognizer Tiny（CPU最適化軽量モデル）、モデルDLコマンド、ページ指定・DPI設定 |
| **v0.9.5** | 2025-09-09 | 読み順番号の可視化、DocumentAnalyzer引数追加 |
| **v0.9.4** | 2025-06-12 | 改善・修正 |
| **v0.9.3** | 2025頃 | サーチャブルPDF生成 |
| **v0.9.1** | 2025頃 | 読み順推定アルゴリズム拡張、MCPサーバー実装 |
| **v0.8.0** | 2025-04-04 | **手書き文字認識サポート** |
| **v0.7.0** | 2024-12-31 | 改善・修正 |
| **v0.6.0** | 2024-12-15 | 改善・修正 |
| **v0.5.0** | 2024-11-26 | **初回公開（ベータ版）** |
| **v0.1.0** | 2024-10-30 | 初期開発版 |

---

## 他のOCRツールとの比較

| 項目 | YomiToku | Tesseract | EasyOCR |
|------|----------|-----------|---------|
| **日本語特化** | 専用設計 | 汎用（日本語も対応） | 汎用（日本語も対応） |
| **対応文字数** | 7,000文字以上 | 限定的 | 限定的 |
| **縦書き対応** | 対応 | 部分的 | 非対応 |
| **手書き対応** | 対応（v0.8.0〜） | 非対応 | 部分的 |
| **レイアウト解析** | 高度（段落・表・図表） | 基本的 | 基本的 |
| **表構造認識** | 対応 | 非対応 | 非対応 |
| **出力形式** | JSON/HTML/MD/CSV/PDF | テキスト | テキスト |
| **日本語精度** | 高い | 中程度 | 中程度 |

---

## 商用利用

### オープンソース版
- **ライセンス**: CC BY-NC-SA 4.0
- 非商用での個人利用・研究目的は自由
- 商用利用には別途ライセンスが必要

### 商用版（YomiToku-Pro）

#### 基本情報

| 項目 | 内容 |
|------|------|
| **提供元** | MLism株式会社（千葉県柏市、代表：木之下滉大郎、2024年12月設立） |
| **リリース日** | 2025年2月13日（プレスリリース） |
| **最新バージョン** | v1.1.0 |
| **提供形態** | AWS Marketplace上のAmazon SageMakerモデル |
| **クライアントSDK** | yomitoku-client（Apache License 2.0） |
| **サポート** | support-aws-marketplace@mlism.com |

#### OSS版との主な違い

| 項目 | OSS版 | YomiToku-Pro |
|------|-------|-------------|
| **モデル精度** | 標準 | より高精度（手書き認識精度の向上等） |
| **ライセンス** | CC BY-NC-SA 4.0（非商用） | 商用利用可 |
| **実行環境** | ローカル（GPU/CPU/MPS） | AWS SageMaker（お客様のAWS環境内） |
| **追加機能** | — | 自動画像方向補正、レイアウト解析強化（開発中の機能含む） |
| **並列処理** | — | バッチ処理対応（大量文書の並列処理） |
| **データセキュリティ** | ローカル完結 | AWS環境内完結（外部サーバーへのデータ送信なし） |

#### デプロイ方式

YomiToku-Proはサーバー組み込み型パッケージとして提供されます。

- **クラウド**: AWS SageMakerエンドポイントとしてデプロイ（リアルタイム推論 / バッチ変換）
- **オンプレミス**: 閉域ネットワーク環境にも対応可能（別途ライセンス）
- **セキュリティ**: すべての解析処理がお客様のAWS環境内で完結し、外部へのデータ送信なし

#### 対応インスタンスタイプと価格

すべてのインスタンスタイプで **$10.00/host/hour**（ソフトウェア利用料）+ AWS基盤コスト（別途）。
課金はデプロイ完了からアンデプロイまで、1秒単位で計測されます。

| インスタンスタイプ | 推奨用途 |
|-------------------|----------|
| **ml.g4dn.xlarge** | リアルタイム推論（推奨） |
| **ml.g5.xlarge** | バッチ処理（推奨）、リアルタイム推論 |
| **ml.g6.xlarge** | リアルタイム推論 / バッチ処理 |
| **ml.c7i.xlarge** | リアルタイム推論 / バッチ処理（CPU） |
| **ml.c7i.2xlarge** | リアルタイム推論 / バッチ処理（CPU） |

> 長期・大規模利用にはプライベートオファーも対応。

#### パフォーマンス

- **ml.g5.xlarge** 使用時: 約 **0.60秒/ページ**（理論値）、約 **6,000ページ/時間** 処理可能
- A4片面文書を平均1秒未満で解析

#### 入出力仕様

| 項目 | 内容 |
|------|------|
| **入力形式** | PDF, JPEG, PNG, TIFF |
| **API出力** | JSON（SageMakerエンドポイントからの直接レスポンス） |
| **クライアント経由出力** | JSON, HTML, Markdown, CSV, Searchable PDF |
| **推奨画像解像度** | 短辺 720px 以上（低解像度では品質低下の可能性） |

#### クライアントSDK（yomitoku-client）

YomiToku-Proのエンドポイントを効率的に呼び出すためのPythonクライアントライブラリ。

```bash
pip install yomitoku-client
```

##### Python APIでの利用例

```python
from yomitoku_client import YomitokuClient, parse_pydantic_model

with YomitokuClient(endpoint="endpoint-name", region="ap-northeast-1") as client:
    result = client.analyze("document.pdf")
    model = parse_pydantic_model(result)
    model.to_markdown(output_path="output.md")
```

##### CLIでの利用例

```bash
# 単一ファイル解析
yomitoku-client single image.jpg -e your-endpoint -f json

# バッチ処理
yomitoku-client batch -i input_dir -o output_dir -e your-endpoint -f md
```

#### 業務提携

株式会社Relicと業務提携し、AI/LLM活用ソリューションの提供拡大を予定。

---

## 関連リンク

- [GitHub リポジトリ（OSS版）](https://github.com/kotaro-kinoshita/yomitoku)
- [公式ドキュメント](https://kotaro-kinoshita.github.io/yomitoku/en/)
- [PyPI パッケージ](https://pypi.org/project/yomitoku/)
- [開発者紹介記事（note）](https://note.com/kotaro_kinoshita/n/n70df91659afc)
- [Qiita 紹介記事](https://qiita.com/kanzoo/items/9d382fe4ec991a7eacd2)
- [Zenn 解説記事](https://zenn.dev/headwaters/articles/8087acc5a4b5db)
- [WEEL 解説記事](https://weel.co.jp/media/tech/ai-ocr-yomitoku/)
- [AWS Marketplace（YomiToku-Pro）](https://aws.amazon.com/marketplace/pp/prodview-64qkuwrqi4lhi)
- [YomiToku-Pro プレスリリース](https://prtimes.jp/main/html/rd/p/000000001.000157087.html)
- [yomitoku-client GitHub](https://github.com/MLism-Inc/yomitoku-client)
- [YomiToku-Pro 商用版レビュー（Qiita）](https://qiita.com/m5t0/items/0f13127a93742e85488c)
- [MLism株式会社 公式サイト](https://www.mlism.com/)
