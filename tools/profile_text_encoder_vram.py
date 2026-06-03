#!/usr/bin/env python3
"""Profile HY-Motion text encoder VRAM and output tensor compatibility."""

from __future__ import annotations

import argparse
import gc
import os
import sys
import time
from collections import Counter
from pathlib import Path

import psutil
import torch
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    CLIPTextModel,
    CLIPTokenizer,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hymotion.network.text_encoders.model_constants import PROMPT_TEMPLATE_ENCODE_HUMAN_MOTION


QWEN_ID = "Qwen/Qwen3-8B"
CLIP_ID = "openai/clip-vit-large-patch14"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=("clip", "qwen-bf16", "qwen-4bit"),
        required=True,
        help="Text encoder mode to profile.",
    )
    parser.add_argument(
        "--prompt",
        default="A person walks forward, turns left, then raises both arms.",
        help="Prompt to encode.",
    )
    parser.add_argument("--max-length", type=int, default=512, help="HY-Motion Qwen crop length.")
    parser.add_argument("--device", default="cuda", help="Device for CLIP and non-sharded runs.")
    parser.add_argument(
        "--compute-dtype",
        choices=("auto", "float16", "bfloat16", "float32"),
        default="auto",
        help="Compute dtype for Qwen 4-bit and model dtype for Qwen BF16 mode.",
    )
    parser.add_argument(
        "--max-gpu-memory",
        default="7GiB",
        help="Accelerate max_memory entry for GPU 0 in Qwen modes.",
    )
    parser.add_argument(
        "--max-cpu-memory",
        default="48GiB",
        help="Accelerate max_memory entry for CPU in Qwen modes.",
    )
    parser.add_argument(
        "--local-files-only",
        action="store_true",
        help="Do not download models; use only existing Hugging Face cache.",
    )
    return parser.parse_args()


def resolve_dtype(name: str) -> torch.dtype:
    if name == "auto":
        if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
            return torch.bfloat16
        return torch.float16
    return {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }[name]


def cuda_snapshot(label: str) -> None:
    rss_gib = psutil.Process(os.getpid()).memory_info().rss / 1024**3
    print(f"[{label}] cpu_rss_gib={rss_gib:.2f}")
    if not torch.cuda.is_available():
        return
    torch.cuda.synchronize()
    free, total = torch.cuda.mem_get_info()
    allocated = torch.cuda.memory_allocated()
    reserved = torch.cuda.memory_reserved()
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    print(
        f"[{label}] gpu_free_gib={free / 1024**3:.2f} "
        f"gpu_total_gib={total / 1024**3:.2f} "
        f"allocated_gib={allocated / 1024**3:.2f} "
        f"reserved_gib={reserved / 1024**3:.2f} "
        f"peak_allocated_gib={peak_allocated / 1024**3:.2f} "
        f"peak_reserved_gib={peak_reserved / 1024**3:.2f}"
    )


def find_subseq(a: list[int], b: list[int]) -> int:
    for index in range(0, len(a) - len(b) + 1):
        if a[index : index + len(b)] == b:
            return index
    return -1


def qwen_prompt(tokenizer: AutoTokenizer, prompt: str) -> str:
    messages = [
        {"role": "system", "content": PROMPT_TEMPLATE_ENCODE_HUMAN_MOTION},
        {"role": "user", "content": prompt},
    ]
    return tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=False,
        enable_thinking=False,
    )


def qwen_crop_start(tokenizer: AutoTokenizer) -> int:
    marker = "<BOC>"
    full_ids = tokenizer(qwen_prompt(tokenizer, marker), return_tensors="pt", add_special_tokens=True)[
        "input_ids"
    ][0].tolist()
    marker_ids = tokenizer(marker, return_tensors="pt", add_special_tokens=False)["input_ids"][0].tolist()
    pos = find_subseq(full_ids, marker_ids)
    return pos if pos >= 0 else max(0, len(full_ids) - 1)


def model_input_device(model: torch.nn.Module) -> torch.device:
    embeddings = model.get_input_embeddings()
    if embeddings is not None:
        return embeddings.weight.device
    return next(model.parameters()).device


def print_device_map(model: torch.nn.Module) -> None:
    device_map = getattr(model, "hf_device_map", None)
    if not device_map:
        print("device_map=none")
        return
    counts = Counter(str(device) for device in device_map.values())
    print("device_map_counts=" + ", ".join(f"{device}:{count}" for device, count in sorted(counts.items())))


def no_grad_encode_qwen(model: torch.nn.Module, tokenizer: AutoTokenizer, prompt: str, max_length: int) -> None:
    crop_start = qwen_crop_start(tokenizer)
    full_max_length = crop_start + max_length
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    encoded = tokenizer(
        [qwen_prompt(tokenizer, prompt)],
        truncation=True,
        return_attention_mask=True,
        max_length=full_max_length,
        padding="max_length",
        return_tensors="pt",
    )
    input_device = model_input_device(model)
    encoded = {key: value.to(input_device) for key, value in encoded.items()}

    with torch.no_grad():
        outputs = model(**encoded, output_hidden_states=True)
        ctxt_raw = outputs.hidden_states[-1].clone()
        ctxt_raw = ctxt_raw[:, crop_start : crop_start + max_length].contiguous()
        ctxt_length = (encoded["attention_mask"].sum(dim=-1) - crop_start).clamp(min=0, max=max_length)

    print(f"crop_start={crop_start} full_max_length={full_max_length}")
    print(f"ctxt_raw_shape={tuple(ctxt_raw.shape)} dtype={ctxt_raw.dtype} device={ctxt_raw.device}")
    print(f"ctxt_length={ctxt_length.detach().cpu().tolist()}")


def run_qwen(args: argparse.Namespace, quantized: bool) -> None:
    dtype = resolve_dtype(args.compute_dtype)
    tokenizer = AutoTokenizer.from_pretrained(QWEN_ID, padding_side="right", local_files_only=args.local_files_only)

    kwargs = {
        "low_cpu_mem_usage": True,
        "device_map": "auto",
        "max_memory": {0: args.max_gpu_memory, "cpu": args.max_cpu_memory},
        "local_files_only": args.local_files_only,
    }
    if quantized:
        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=dtype,
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
        )
    else:
        kwargs["torch_dtype"] = dtype

    cuda_snapshot("before_load")
    start = time.perf_counter()
    model = AutoModelForCausalLM.from_pretrained(QWEN_ID, **kwargs).eval().requires_grad_(False)
    print(f"load_seconds={time.perf_counter() - start:.2f}")
    print(f"model_hidden_size={model.config.hidden_size}")
    print_device_map(model)
    cuda_snapshot("after_load")

    start = time.perf_counter()
    no_grad_encode_qwen(model, tokenizer, args.prompt, args.max_length)
    print(f"encode_seconds={time.perf_counter() - start:.2f}")
    cuda_snapshot("after_encode")


def run_clip(args: argparse.Namespace) -> None:
    dtype = resolve_dtype(args.compute_dtype)
    device = torch.device(args.device if torch.cuda.is_available() else "cpu")
    if device.type == "cpu":
        dtype = torch.float32

    cuda_snapshot("before_load")
    start = time.perf_counter()
    tokenizer = CLIPTokenizer.from_pretrained(CLIP_ID, local_files_only=args.local_files_only)
    model = CLIPTextModel.from_pretrained(CLIP_ID, local_files_only=args.local_files_only)
    model = model.to(device=device, dtype=dtype).eval().requires_grad_(False)
    print(f"load_seconds={time.perf_counter() - start:.2f}")
    print(f"model_hidden_size={model.config.hidden_size}")
    cuda_snapshot("after_load")

    encoded = tokenizer(
        [args.prompt],
        truncation=True,
        return_attention_mask=True,
        max_length=77,
        padding=True,
        return_tensors="pt",
    )
    encoded = {key: value.to(device) for key, value in encoded.items()}
    start = time.perf_counter()
    with torch.no_grad():
        output = model(**encoded)
        vtxt_raw = output.pooler_output.unsqueeze(1)
    print(f"vtxt_raw_shape={tuple(vtxt_raw.shape)} dtype={vtxt_raw.dtype} device={vtxt_raw.device}")
    print(f"encode_seconds={time.perf_counter() - start:.2f}")
    cuda_snapshot("after_encode")


def main() -> None:
    args = parse_args()
    print(f"torch={torch.__version__} torch_cuda={torch.version.cuda} cuda_available={torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"gpu={torch.cuda.get_device_name(0)} bf16_supported={torch.cuda.is_bf16_supported()}")
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    if args.mode == "clip":
        run_clip(args)
    elif args.mode == "qwen-bf16":
        run_qwen(args, quantized=False)
    elif args.mode == "qwen-4bit":
        run_qwen(args, quantized=True)
    else:
        raise ValueError(args.mode)

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
