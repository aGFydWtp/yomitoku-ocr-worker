"""Dockerfile completeness regression test (Bug 007 defense-in-depth).

Background:
    The image previously shipped without ``office_converter.py`` because the
    new module was added but the matching ``COPY office_converter.py .`` line
    was forgotten in the Dockerfile. The container then failed at startup with
    ``ModuleNotFoundError: No module named 'office_converter'``.

This test asserts: every top-level ``*.py`` source file under
``lambda/batch-runner/`` (excluding ``tests/``, ``__pycache__/``, ``.venv/``)
is referenced by a ``COPY`` directive in the Dockerfile. New modules cannot
silently slip past the build without being copied into the image.
"""

from __future__ import annotations

from pathlib import Path

import pytest


_RUNNER_DIR = Path(__file__).resolve().parent.parent
_DOCKERFILE = _RUNNER_DIR / "Dockerfile"
_EXCLUDED_DIRS = {"tests", "__pycache__", ".venv", "venv", ".pytest_cache"}


def _collect_source_modules() -> list[str]:
    """Return basenames of all ``*.py`` files under ``lambda/batch-runner/``
    that should be present in the runtime image.
    """
    out: list[str] = []
    for entry in _RUNNER_DIR.iterdir():
        if entry.is_dir():
            continue
        if entry.suffix != ".py":
            continue
        out.append(entry.name)
    return sorted(out)


def _dockerfile_copy_targets() -> list[str]:
    """Return the basenames referenced by ``COPY ... .`` lines in Dockerfile.

    Only matches the simple ``COPY <file> .`` form used for source modules.
    Multi-source COPY (e.g. ``COPY a b /dest``) is not used in this Dockerfile.
    """
    targets: list[str] = []
    for raw in _DOCKERFILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line.startswith("COPY "):
            continue
        # ``COPY src dst`` — split on whitespace, keep srcs (everything except
        # the last token, which is the destination).
        parts = line.split()
        if len(parts) < 3:
            continue
        srcs = parts[1:-1]
        for src in srcs:
            # Only track top-level python module copies (no path separator).
            if src.endswith(".py") and "/" not in src:
                targets.append(src)
    return targets


class TestDockerfileCompleteness:
    def test_dockerfile_exists(self) -> None:
        assert _DOCKERFILE.exists(), f"Dockerfile not found at {_DOCKERFILE}"

    def test_every_source_module_is_copied(self) -> None:
        """Each top-level ``*.py`` module under lambda/batch-runner is COPY'd."""
        sources = _collect_source_modules()
        targets = set(_dockerfile_copy_targets())
        missing = [name for name in sources if name not in targets]
        assert not missing, (
            f"Dockerfile is missing COPY for: {missing}. "
            f"Found COPY targets: {sorted(targets)}; "
            f"Source modules: {sources}. "
            "Add 'COPY <module>.py .' to the Dockerfile."
        )

    @pytest.mark.parametrize(
        "required",
        [
            "main.py",
            "settings.py",
            "office_converter.py",  # bug 007 anchor: must always be present
            "batch_store.py",
            "process_log_reader.py",
            "runner.py",
            "async_invoker.py",
            "s3_sync.py",
            "control_table.py",
            "ddb_client.py",
        ],
    )
    def test_known_modules_are_present(self, required: str) -> None:
        """Belt-and-braces: explicitly assert each known module is COPY'd.

        ``test_every_source_module_is_copied`` already covers this dynamically,
        but listing the modules by name produces a much clearer failure message
        when (for example) ``office_converter.py`` is dropped from the image.
        """
        targets = set(_dockerfile_copy_targets())
        assert required in targets, (
            f"Dockerfile must contain `COPY {required} .` "
            f"(found: {sorted(targets)})"
        )
