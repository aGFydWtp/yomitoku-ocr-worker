"""BatchRunner エントリポイント。

ECS Fargate タスクとして起動され、以下の処理を順に実行する:

1. 設定のロード (``settings.BatchRunnerSettings.from_env``)
2. ControlTable へ heartbeat 登録 (``BATCH_IN_FLIGHT#{id}`` + ``ACTIVE#COUNT``)
3. ``s3_sync.download_inputs`` で入力ファイルをローカルに取得
4. ``runner.run_async_batch`` で Async Endpoint 経路の OCR を実行
5. ``runner.generate_all_visualizations`` で可視化を生成 (非致命)
6. ``s3_sync.upload_outputs`` で成果物を S3 にアップロード
7. ``process_log_reader.read_process_log`` +
   ``batch_store.apply_process_log`` で DDB FILE アイテムを更新
8. ``batch_store.finalize_batch_status`` で META.status を
   COMPLETED/PARTIAL/FAILED に遷移
9. ControlTable から heartbeat 削除 (ACTIVE#COUNT -1)

``DRY_RUN=true`` のときは 1 のみ実行して終了する。

Exit code 仕様:
    * 0 : DDB の META.status を最終状態 (COMPLETED/PARTIAL/FAILED) に
          遷移できた。Step Functions の RunBatchTask は成功として
          AggregateResults → DetermineFinalStatus → MarkCompleted/MarkPartial/MarkFailed
          → ReleaseBatchLock → Done に抜ける。
    * 1 : インフラ側の致命的な失敗 (設定不足 / DDB / S3 等) で
          finalize に到達できなかった。Step Functions は RunBatchTask
          の失敗として MarkFailedForced → ReleaseBatchLockOnError → Failed
          に抜ける。
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import tempfile
from pathlib import Path

import boto3

from batch_store import apply_process_log, finalize_batch_status
from control_table import delete_heartbeat, register_heartbeat
from process_log_reader import read_process_log
from runner import generate_all_visualizations, run_async_batch
from s3_sync import download_inputs, upload_outputs
from settings import BatchRunnerSettings

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


def dry_run() -> None:
    """設定ロードの成功のみを確認するドライラン。

    ローカル検証や CI での smoke-test として使用する。
    例外が送出されなければ設定ロード成功とみなす。

    INFO には識別子 (batch_job_id) のみを出力し、
    インフラ識別子 (bucket/table 名など) は DEBUG レベルでのみ出力する。
    """
    settings = BatchRunnerSettings.from_env()
    logger.info(
        "dry_run: settings loaded successfully",
        extra={"batch_job_id": settings.batch_job_id},
    )
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "dry_run settings detail",
            extra={
                "batch_job_id": settings.batch_job_id,
                "bucket_name": settings.bucket_name,
                "batch_table_name": settings.batch_table_name,
                "max_file_concurrency": settings.max_file_concurrency,
                "max_page_concurrency": settings.max_page_concurrency,
                "extra_formats": settings.extra_formats,
            },
        )


def run(settings: BatchRunnerSettings) -> int:
    """バッチ処理本体。Exit code を返す (モジュール docstring 参照)。

    例外は呼び出し側 ``main()`` で捕捉する。``finally`` 節で heartbeat
    削除のみ行い、他のクリーンアップ (work dir 削除) は Fargate の
    ephemeral storage 破棄に委ねる。
    """
    s3 = boto3.client("s3")
    ddb = boto3.resource("dynamodb")
    batch_table = ddb.Table(settings.batch_table_name)
    control_table = ddb.Table(settings.control_table_name)

    work_root = Path(tempfile.mkdtemp(prefix=f"batch-{settings.batch_job_id}-"))
    input_dir = work_root / "input"
    output_dir = work_root / "output"
    log_path = output_dir / "process_log.jsonl"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info(
        "run: batch started",
        extra={
            "batch_job_id": settings.batch_job_id,
            "work_root": str(work_root),
        },
    )

    # 2. ControlTable heartbeat 登録。登録自体の失敗はバッチ失敗にはしない
    # (ACTIVE#COUNT のドリフトは API 側の concurrent 判定を保守側に寄せるだけで、
    # OCR 本体の整合性には影響しない)。
    heartbeat_registered = False
    try:
        register_heartbeat(
            table=control_table,
            batch_job_id=settings.batch_job_id,
            duration_sec=settings.batch_max_duration_sec,
        )
        heartbeat_registered = True
    except Exception:  # noqa: BLE001 — ObservabilityOnly
        logger.exception("register_heartbeat failed (non-fatal, continuing)")

    try:
        # 3. S3 → local input
        downloaded = download_inputs(
            bucket=settings.bucket_name,
            batch_job_id=settings.batch_job_id,
            input_dir=str(input_dir),
            s3_client=s3,
        )
        total_files = len(downloaded)
        if total_files == 0:
            logger.error(
                "no input files found",
                extra={"batch_job_id": settings.batch_job_id},
            )
            finalize_batch_status(
                table=batch_table,
                batch_job_id=settings.batch_job_id,
                total_files=0,
                succeeded=0,
                failed=0,
                expected_current="PROCESSING",
            )
            return 0

        # 4. Async 経路でバッチ実行
        result = asyncio.run(
            run_async_batch(
                settings=settings,
                input_dir=str(input_dir),
                output_dir=str(output_dir),
                log_path=str(log_path),
                deadline_seconds=float(settings.batch_max_duration_sec),
            )
        )
        logger.info(
            "run_async_batch returned",
            extra={
                "batch_job_id": settings.batch_job_id,
                "succeeded": len(result.succeeded_files),
                "failed": len(result.failed_files),
                "timeout": len(result.in_flight_timeout),
            },
        )

        # 5. 可視化生成 (ページ単位の失敗は非致命、runner.py が warning を残す)
        try:
            generate_all_visualizations(
                input_dir=str(input_dir),
                output_dir=str(output_dir),
            )
        except Exception:  # noqa: BLE001 — 非致命
            logger.exception(
                "generate_all_visualizations failed (non-fatal)",
                extra={"batch_job_id": settings.batch_job_id},
            )

        # 6. S3 upload (成果物 + process_log.jsonl)
        try:
            upload_counts = upload_outputs(
                bucket=settings.bucket_name,
                batch_job_id=settings.batch_job_id,
                output_dir=str(output_dir),
                s3_client=s3,
            )
            logger.info(
                "upload_outputs complete",
                extra={
                    "batch_job_id": settings.batch_job_id,
                    **{f"uploaded_{k}": v for k, v in upload_counts.items()},
                },
            )
        except Exception:
            # アップロード失敗時も DDB の finalize は行う。成果物が S3 に
            # 揃っていないリスクは error_message 経由では表現できないが、
            # バッチ全体の終端状態を PROCESSING のまま放置するよりはマシ。
            logger.exception(
                "upload_outputs failed (continuing to finalize)",
                extra={"batch_job_id": settings.batch_job_id},
            )

        # 7. process_log.jsonl → DDB FILE アイテム反映
        entries = list(read_process_log(str(log_path)))
        logger.info(
            "read_process_log entries",
            extra={
                "batch_job_id": settings.batch_job_id,
                "entry_count": len(entries),
            },
        )
        totals = apply_process_log(
            table=batch_table,
            batch_job_id=settings.batch_job_id,
            entries=entries,
        )

        # 8. META.status を最終状態に遷移
        final_status = finalize_batch_status(
            table=batch_table,
            batch_job_id=settings.batch_job_id,
            total_files=total_files,
            succeeded=totals["succeeded"],
            failed=totals["failed"],
            expected_current="PROCESSING",
        )
        logger.info(
            "batch finalized",
            extra={
                "batch_job_id": settings.batch_job_id,
                "total_files": total_files,
                "succeeded": totals["succeeded"],
                "failed": totals["failed"],
                "skipped": totals["skipped"],
                "status": final_status,
            },
        )
        return 0

    finally:
        # 9. heartbeat 削除。ACTIVE#COUNT の整合性を最優先するため、
        # 登録成功時のみ try でカバー (登録失敗時に delete を呼ぶと
        # TransactionCanceledException を吸収するロジックへ依存し、
        # 動作は同じだが無駄なコールとログを減らす)。
        if heartbeat_registered:
            try:
                delete_heartbeat(
                    table=control_table,
                    batch_job_id=settings.batch_job_id,
                )
            except Exception:  # noqa: BLE001 — ObservabilityOnly
                logger.exception(
                    "delete_heartbeat failed (non-fatal)",
                    extra={"batch_job_id": settings.batch_job_id},
                )


def main() -> int:
    """エントリポイント。終了コードを返す。"""
    if os.environ.get("DRY_RUN", "").lower() == "true":
        dry_run()
        return 0

    try:
        settings = BatchRunnerSettings.from_env()
    except ValueError as exc:
        logger.error("Failed to load settings: %s", exc)
        return 1

    try:
        return run(settings)
    except Exception:
        logger.exception("Unhandled exception in run()")
        return 1


if __name__ == "__main__":
    sys.exit(main())
