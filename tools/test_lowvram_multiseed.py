#!/usr/bin/env python3
"""Test one text-encoder pass followed by multiple sequential HY-Motion generations."""

from __future__ import annotations

import argparse
import gc
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Dict, List

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hymotion.utils.loaders import load_object
from hymotion.utils.visualize_mesh_web import save_visualization_data


DEFAULT_PROMPT = "a female person kneeling down from a standing position in a feminine fashion"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", default="ckpts/tencent/HY-Motion-1.0")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--duration", type=float, default=4.0)
    parser.add_argument("--samples", type=int, default=4)
    parser.add_argument("--seeds", default="", help="Comma-separated seeds. Overrides --samples/--seed.")
    parser.add_argument("--seed", type=int, default=None, help="RNG seed used to create random generation seeds.")
    parser.add_argument("--cfg-scale", type=float, default=5.0)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--output-dir", default="output/lowvram_multiseed")
    parser.add_argument("--qwen-path", default="ckpts/Qwen3-8B")
    parser.add_argument("--clip-path", default="openai/clip-vit-large-patch14")
    parser.add_argument("--qwen-gpu-memory", default="5GiB")
    parser.add_argument("--qwen-cpu-memory", default="48GiB")
    parser.add_argument("--allow-download", action="store_true")
    return parser.parse_args()


def now_id() -> str:
    t = time.time()
    ms = int((t - int(t)) * 1000)
    return time.strftime("%Y%m%d_%H%M%S", time.localtime(t)) + f"{ms:03d}"


def cuda_snapshot(label: str) -> None:
    if not torch.cuda.is_available():
        print(f"[{label}] cuda_available=false")
        return
    torch.cuda.synchronize()
    free, total = torch.cuda.mem_get_info()
    allocated = torch.cuda.memory_allocated()
    reserved = torch.cuda.memory_reserved()
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    print(
        f"[{label}] free={free / 1024**3:.2f}GiB "
        f"allocated={allocated / 1024**3:.2f}GiB "
        f"reserved={reserved / 1024**3:.2f}GiB "
        f"peak_allocated={peak_allocated / 1024**3:.2f}GiB "
        f"peak_reserved={peak_reserved / 1024**3:.2f}GiB "
        f"total={total / 1024**3:.2f}GiB"
    )


def cleanup_cuda() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


def parse_seeds(args: argparse.Namespace) -> List[int]:
    if args.seeds.strip():
        return [int(seed.strip()) for seed in args.seeds.split(",") if seed.strip()]
    rng = random.Random(args.seed)
    return [rng.randrange(1_000_000_000) for _ in range(args.samples)]


def configure_text_encoder_env(args: argparse.Namespace) -> None:
    os.environ["HY_QWEN_PATH"] = args.qwen_path
    os.environ["HY_CLIP_PATH"] = args.clip_path
    os.environ["HY_QWEN_DEVICE_MAP"] = "auto"
    os.environ["HY_QWEN_MAX_GPU_MEMORY"] = args.qwen_gpu_memory
    os.environ["HY_QWEN_MAX_CPU_MEMORY"] = args.qwen_cpu_memory
    if not args.allow_download:
        os.environ["HY_TEXT_LOCAL_FILES_ONLY"] = "1"


def load_config(model_path: Path) -> dict:
    config_path = model_path / "config.yml"
    if not config_path.exists():
        raise FileNotFoundError(f"Missing config: {config_path}")
    with config_path.open("r", encoding="utf-8") as f:
        return yaml.load(f, Loader=yaml.FullLoader)


def encode_prompt_once(config: dict, prompt: str, device: torch.device) -> Dict[str, torch.Tensor]:
    print(">>> Loading text encoder...")
    start = time.perf_counter()
    text_encoder = None
    vtxt_input = None
    ctxt_input = None
    ctxt_length = None
    try:
        text_encoder = load_object(
            config["train_pipeline_args"]["text_encoder_module"],
            config["train_pipeline_args"]["text_encoder_cfg"],
        )
        text_encoder.to(device)
        print(f">>> Text encoder loaded in {time.perf_counter() - start:.2f}s")
        cuda_snapshot("after_text_encoder_load")

        start = time.perf_counter()
        with torch.no_grad():
            vtxt_input, ctxt_input, ctxt_length = text_encoder.encode(text=[prompt])
        print(f">>> Text encoded once in {time.perf_counter() - start:.2f}s")
        print(
            ">>> Hidden shapes: "
            f"vtxt={tuple(vtxt_input.shape)} ctxt={tuple(ctxt_input.shape)} length={ctxt_length.detach().cpu().tolist()}"
        )
        cuda_snapshot("after_text_encode")

        return {
            "text_vec_raw": vtxt_input.detach().cpu(),
            "text_ctxt_raw": ctxt_input.detach().cpu(),
            "text_ctxt_raw_length": ctxt_length.detach().cpu(),
        }
    finally:
        del text_encoder, vtxt_input, ctxt_input, ctxt_length
        cleanup_cuda()
        cuda_snapshot("after_text_encoder_unload")


def load_motion_pipeline(config: dict, ckpt_path: Path, device: torch.device) -> torch.nn.Module:
    if not ckpt_path.exists():
        raise FileNotFoundError(f"Missing checkpoint: {ckpt_path}")

    print(">>> Loading HY-Motion without text encoder...")
    start = time.perf_counter()
    pipeline = load_object(
        config["train_pipeline"],
        config["train_pipeline_args"],
        network_module=config["network_module"],
        network_module_args=config["network_module_args"],
    )
    pipeline.load_in_demo(str(ckpt_path), build_text_encoder=False, allow_empty_ckpt=False)
    pipeline.to(device)
    pipeline.eval()
    print(f">>> HY-Motion loaded in {time.perf_counter() - start:.2f}s")
    cuda_snapshot("after_motion_load")
    return pipeline


def move_hidden(hidden_cpu: Dict[str, torch.Tensor], device: torch.device) -> Dict[str, torch.Tensor]:
    return {key: value.to(device) for key, value in hidden_cpu.items()}


def write_manifest(output_dir: Path, manifest: dict) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / f"{manifest['run_id']}_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f">>> Manifest: {manifest_path}")


def main() -> None:
    args = parse_args()
    configure_text_encoder_env(args)

    if not torch.cuda.is_available() and args.device.startswith("cuda"):
        raise RuntimeError("CUDA requested but torch.cuda.is_available() is false")

    device = torch.device(args.device if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        torch.cuda.set_device(device)
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats(device)

    model_path = Path(args.model_path)
    ckpt_path = model_path / "latest.ckpt"
    output_dir = Path(args.output_dir)
    seeds = parse_seeds(args)
    run_id = now_id()

    print(f">>> Prompt: {args.prompt}")
    print(f">>> Duration: {args.duration}s  CFG: {args.cfg_scale}  Seeds: {seeds}")
    print(f">>> Model: {model_path}")
    cuda_snapshot("start")

    config = load_config(model_path)
    hidden_cpu = encode_prompt_once(config, args.prompt, device)
    pipeline = load_motion_pipeline(config, ckpt_path, device)

    manifest = {
        "run_id": run_id,
        "prompt": args.prompt,
        "duration": args.duration,
        "cfg_scale": args.cfg_scale,
        "seeds": seeds,
        "model_path": str(model_path),
        "outputs": [],
    }

    for index, seed in enumerate(seeds):
        print(f">>> Generating {index + 1}/{len(seeds)} with seed={seed}...")
        start = time.perf_counter()
        hidden_gpu = move_hidden(hidden_cpu, device)
        with torch.no_grad():
            output = pipeline.generate(
                args.prompt,
                [seed],
                args.duration,
                cfg_scale=args.cfg_scale,
                hidden_state_dict=hidden_gpu,
            )
        elapsed = time.perf_counter() - start

        sample_name = f"{run_id}_seed{seed}"
        _, base_filename = save_visualization_data(
            output=output,
            text=args.prompt,
            rewritten_text=args.prompt,
            timestamp=run_id,
            output_dir=str(output_dir),
            output_filename=sample_name,
        )
        manifest["outputs"].append(
            {
                "seed": seed,
                "seconds": elapsed,
                "base_filename": base_filename,
                "npz": str(output_dir / f"{base_filename}_000.npz"),
                "meta": str(output_dir / f"{base_filename}_meta.json"),
            }
        )
        print(f">>> Seed {seed} done in {elapsed:.2f}s -> {output_dir / (base_filename + '_000.npz')}")

        del hidden_gpu, output
        cleanup_cuda()
        cuda_snapshot(f"after_seed_{seed}")

    write_manifest(output_dir, manifest)
    print(">>> Done.")


if __name__ == "__main__":
    main()
