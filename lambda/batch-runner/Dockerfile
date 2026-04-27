# Batch Runner — ECS Fargate コンテナ
# ベースイメージ: Python 3.12 slim（ARM64 / x86_64 マルチプラットフォーム）
FROM python:3.12-slim

# -----------------------------------------------------------------------
# 依存ライブラリのインストール
# -----------------------------------------------------------------------
WORKDIR /app

# -----------------------------------------------------------------------
# OS パッケージのインストール (LibreOffice + CJK フォント)
# -----------------------------------------------------------------------
# Office 形式 (.pptx / .docx / .xlsx) を soffice 経由で PDF 化するための
# OS-level 依存。USER 切替前に root で install する必要がある。
# CJK フォント (Noto + IPAex) は日本語ドキュメントの "□" / "?" 化を防ぐ。
# msoffcrypto-tool は APT に該当 package が存在しないため (Debian 名は
# `python3-msoffcrypto`)、ここには含めず requirements.txt 経由で pip install する。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libreoffice-core libreoffice-impress libreoffice-writer libreoffice-calc \
       fonts-noto-cjk fonts-ipaexfont \
    && rm -rf /var/lib/apt/lists/*

# requirements.txt を先にコピーしてレイヤーキャッシュを最大化
COPY requirements.txt .
# yomitoku-client 0.2.0 は transitive に opencv-python (非 headless) を
# 引き込み、slim ベースに無い libxcb/libGL 等の X11 系共有ライブラリに
# ランタイム依存して ImportError となる。requirements.txt 直書きの
# opencv-python-headless と競合するので、非 headless 版だけを明示的に
# uninstall して Fargate 実行時の cv2 import を headless に収束させる。
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall --yes opencv-python \
    && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless

# -----------------------------------------------------------------------
# アプリケーションコードのコピー
# -----------------------------------------------------------------------
COPY settings.py .
COPY s3_sync.py .
COPY runner.py .
COPY async_invoker.py .
COPY process_log_reader.py .
COPY ddb_client.py .
COPY batch_store.py .
COPY control_table.py .
COPY main.py .

# -----------------------------------------------------------------------
# 実行ユーザーを非 root に変更（最小権限の原則）
# -----------------------------------------------------------------------
RUN useradd --no-create-home --shell /bin/false appuser
USER appuser

# -----------------------------------------------------------------------
# エントリポイント
# -----------------------------------------------------------------------
ENV PYTHONUNBUFFERED=1

CMD ["python", "main.py"]
