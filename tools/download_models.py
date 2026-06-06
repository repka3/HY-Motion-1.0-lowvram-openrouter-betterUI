#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from huggingface_hub import snapshot_download


MOTION_REPO_ID = "tencent/HY-Motion-1.0"
QWEN_REPO_ID = "Qwen/Qwen3-8B"
CLIP_REPO_ID = "openai/clip-vit-large-patch14"
PROMPTER_REPO_ID = "Text2MotionPrompter/Text2MotionPrompter"
MOTION_VARIANTS = ("HY-Motion-1.0", "HY-Motion-1.0-Lite")


@dataclass(frozen=True)
class ModelTask:
    name: str
    repo_id: str
    local_dir: Path
    required_files: tuple[Path, ...]
    required_globs: tuple[str, ...] = ()
    required_any_globs: tuple[str, ...] = ()
    allow_patterns: tuple[str, ...] | None = None


def log(message: str) -> None:
    print(f"[models] {message}", flush=True)


def die(message: str) -> None:
    print(f"[models][error] {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def missing_for(task: ModelTask) -> list[str]:
    missing: list[str] = []
    for path in task.required_files:
        if not path.is_file() or path.stat().st_size == 0:
            missing.append(str(path))
    for pattern in task.required_globs:
        if not any(task.local_dir.glob(pattern)):
            missing.append(f"{task.local_dir}/{pattern}")
    if task.required_any_globs and not any(
        any(task.local_dir.glob(pattern)) for pattern in task.required_any_globs
    ):
        missing.append(
            "one of "
            + ", ".join(f"{task.local_dir}/{pattern}" for pattern in task.required_any_globs)
        )
    return missing


def is_present(task: ModelTask) -> bool:
    return not missing_for(task)


def snapshot(task: ModelTask, *, force: bool) -> None:
    if is_present(task) and not force:
        log(f"{task.name} already present: {task.local_dir}")
        return

    log(f"Downloading {task.name} from {task.repo_id} -> {task.local_dir}")
    kwargs: dict[str, object] = {
        "repo_id": task.repo_id,
        "local_dir": str(task.local_dir),
    }
    if task.allow_patterns:
        kwargs["allow_patterns"] = list(task.allow_patterns)
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        kwargs["token"] = token
    snapshot_download(**kwargs)

    missing = missing_for(task)
    if missing:
        die(f"{task.name} download finished, but required files are still missing: {', '.join(missing)}")
    log(f"{task.name} ready")


def build_tasks(args: argparse.Namespace) -> list[ModelTask]:
    motion_dir = Path(args.motion_dir)
    motion_path = motion_dir / args.model_variant
    tasks = [
        ModelTask(
            name=args.model_variant,
            repo_id=MOTION_REPO_ID,
            local_dir=motion_dir,
            allow_patterns=(f"{args.model_variant}/*",),
            required_files=(motion_path / "config.yml", motion_path / "latest.ckpt"),
        )
    ]

    if not args.skip_qwen:
        qwen_dir = Path(args.qwen_dir)
        tasks.append(
            ModelTask(
                name="Qwen3-8B text encoder",
                repo_id=QWEN_REPO_ID,
                local_dir=qwen_dir,
                required_files=(
                    qwen_dir / "config.json",
                    qwen_dir / "tokenizer.json",
                    qwen_dir / "model.safetensors.index.json",
                ),
                required_globs=("model-*.safetensors",),
            )
        )

    if not args.skip_clip:
        clip_dir = Path(args.clip_dir)
        tasks.append(
            ModelTask(
                name="CLIP ViT-L/14 text encoder",
                repo_id=CLIP_REPO_ID,
                local_dir=clip_dir,
                required_files=(clip_dir / "config.json",),
                required_any_globs=("*.safetensors", "pytorch_model*.bin"),
            )
        )

    if args.with_prompter:
        prompter_dir = Path(args.prompter_dir)
        tasks.append(
            ModelTask(
                name="Text2MotionPrompter",
                repo_id=PROMPTER_REPO_ID,
                local_dir=prompter_dir,
                required_files=(prompter_dir / "config.json",),
                required_any_globs=("*.safetensors", "pytorch_model*.bin"),
            )
        )

    return tasks


def check_tasks(tasks: Sequence[ModelTask]) -> bool:
    ok = True
    for task in tasks:
        missing = missing_for(task)
        if missing:
            ok = False
            log(f"{task.name} missing: {', '.join(missing)}")
        else:
            log(f"{task.name} present: {task.local_dir}")
    return ok


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download the model checkpoints required by the HY-Motion studio."
    )
    parser.add_argument(
        "--model-variant",
        choices=MOTION_VARIANTS,
        default=os.environ.get("HY_MODEL_VARIANT", "HY-Motion-1.0"),
        help="HY-Motion checkpoint folder to download from tencent/HY-Motion-1.0.",
    )
    parser.add_argument("--motion-dir", default="ckpts/tencent", help="Directory that contains HY-Motion variant folders.")
    parser.add_argument("--qwen-dir", default="ckpts/Qwen3-8B", help="Local Qwen3-8B directory.")
    parser.add_argument(
        "--clip-dir",
        default="ckpts/clip-vit-large-patch14",
        help="Local CLIP ViT-L/14 directory.",
    )
    parser.add_argument(
        "--prompter-dir",
        default="ckpts/Text2MotionPrompter",
        help="Optional local prompt rewriter model directory.",
    )
    parser.add_argument("--skip-qwen", action="store_true", help="Do not download/check Qwen3-8B.")
    parser.add_argument("--skip-clip", action="store_true", help="Do not download/check CLIP.")
    parser.add_argument(
        "--with-prompter",
        action="store_true",
        help="Also download Text2MotionPrompter. The studio normally uses OpenRouter instead.",
    )
    parser.add_argument("--force", action="store_true", help="Run snapshot_download even when files already exist.")
    parser.add_argument("--check-only", action="store_true", help="Only validate local files; do not download.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    tasks = build_tasks(args)

    if args.check_only:
        if not check_tasks(tasks):
            raise SystemExit(1)
        return

    log("This may download tens of GB. Set HF_TOKEN if Hugging Face requires authentication.")
    for task in tasks:
        snapshot(task, force=args.force)
    log("All requested model assets are ready.")


if __name__ == "__main__":
    main()
