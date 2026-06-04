from __future__ import annotations

import gc
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("HY_QWEN_PATH", "ckpts/Qwen3-8B")
os.environ.setdefault("HY_CLIP_PATH", "openai/clip-vit-large-patch14")
os.environ.setdefault("HY_QWEN_DEVICE_MAP", "auto")
os.environ.setdefault("HY_QWEN_MAX_GPU_MEMORY", "5GiB")
os.environ.setdefault("HY_QWEN_MAX_CPU_MEMORY", "48GiB")
os.environ.setdefault("HY_TEXT_LOCAL_FILES_ONLY", "1")

import torch
import yaml

from hymotion.api.motion_json import write_motion_json
from hymotion.utils.loaders import load_object
from hymotion.utils.visualize_mesh_web import save_visualization_data


Emit = Callable[[str], None]
EmitEvent = Callable[[str, Dict[str, Any]], None]
CancelCheck = Callable[[], bool]


class JobCancelled(RuntimeError):
    pass


@dataclass
class VariationArtifact:
    id: str
    index: int
    seed: int
    seconds: float
    frame_count: int
    base_filename: str
    npz_path: Path
    meta_path: Path
    motion_json_path: Path


def now_id() -> str:
    t = time.time()
    ms = int((t - int(t)) * 1000)
    return time.strftime("%Y%m%d_%H%M%S", time.localtime(t)) + f"{ms:03d}"


def cleanup_cuda() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


class LowVramMotionGenerator:
    def __init__(
        self,
        model_path: Path | str = "ckpts/tencent/HY-Motion-1.0",
        device_name: str | None = None,
    ) -> None:
        self.model_path = Path(os.environ.get("HY_MODEL_PATH", str(model_path)))
        self.ckpt_path = self.model_path / "latest.ckpt"
        self.config_path = self.model_path / "config.yml"
        self.device_name = device_name or os.environ.get("HY_MOTION_DEVICE", "cuda:0")
        self._pipeline = None

    def run_job(
        self,
        request: Dict[str, Any],
        job_dir: Path,
        emit: EmitEvent,
        should_cancel: CancelCheck,
    ) -> List[VariationArtifact]:
        self._configure_env()
        job_dir.mkdir(parents=True, exist_ok=True)
        self._check_cancel(should_cancel)

        device = self._resolve_device()
        if device.type == "cuda":
            torch.cuda.set_device(device)
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats(device)

        prompt = request["prompt"]
        seeds = self._resolve_seeds(request)
        duration = float(request.get("durationSeconds", 4.0))
        cfg_scale = float(request.get("cfgScale", 5.0))
        steps = int(request.get("steps", 50))

        self._unload_motion_pipeline()
        config = self._load_config()

        emit("text_encoder_loading", {"message": "Loading Qwen/CLIP text encoders"})
        hidden_cpu = self._encode_prompt_once(config, prompt, device, emit, should_cancel)

        self._check_cancel(should_cancel)
        emit("motion_loading", {"message": "Loading HY-Motion checkpoint"})
        pipeline = self._load_motion_pipeline(config, device)
        pipeline.validation_steps = steps

        artifacts: List[VariationArtifact] = []
        run_id = now_id()
        for index, seed in enumerate(seeds):
            self._check_cancel(should_cancel)
            variation_id = f"var_{index + 1:02d}"
            emit(
                "generating",
                {
                    "variationId": variation_id,
                    "variationIndex": index,
                    "seed": seed,
                    "message": f"Generating variation {index + 1}/{len(seeds)}",
                },
            )

            start = time.perf_counter()
            hidden_gpu = self._move_hidden_state_dict(hidden_cpu, device)
            with torch.no_grad():
                output = pipeline.generate(
                    prompt,
                    [seed],
                    duration,
                    cfg_scale=cfg_scale,
                    hidden_state_dict=hidden_gpu,
                )
            seconds = time.perf_counter() - start

            base_filename = f"{run_id}_{variation_id}_seed{seed}"
            _, saved_base_filename = save_visualization_data(
                output=output,
                text=prompt,
                rewritten_text=prompt,
                timestamp=run_id,
                output_dir=str(job_dir),
                output_filename=base_filename,
            )

            npz_path = job_dir / f"{saved_base_filename}_000.npz"
            meta_path = job_dir / f"{saved_base_filename}_meta.json"
            motion_json_path = job_dir / f"{variation_id}_motion.json"
            frame_count = write_motion_json(npz_path=npz_path, json_path=motion_json_path, actor_id=0)

            artifact = VariationArtifact(
                id=variation_id,
                index=index,
                seed=seed,
                seconds=seconds,
                frame_count=frame_count,
                base_filename=saved_base_filename,
                npz_path=npz_path,
                meta_path=meta_path,
                motion_json_path=motion_json_path,
            )
            artifacts.append(artifact)
            emit(
                "variation_done",
                {
                    "variation": variation_to_public_dict(artifact),
                    "message": f"Variation {index + 1} finished",
                },
            )

            del hidden_gpu, output
            cleanup_cuda()

        return artifacts

    def _configure_env(self) -> None:
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        os.environ.setdefault("HY_QWEN_PATH", "ckpts/Qwen3-8B")
        os.environ.setdefault("HY_CLIP_PATH", "openai/clip-vit-large-patch14")
        os.environ.setdefault("HY_QWEN_DEVICE_MAP", "auto")
        os.environ.setdefault("HY_QWEN_MAX_GPU_MEMORY", "5GiB")
        os.environ.setdefault("HY_QWEN_MAX_CPU_MEMORY", "48GiB")
        os.environ.setdefault("HY_TEXT_LOCAL_FILES_ONLY", "1")

    def _resolve_device(self) -> torch.device:
        if self.device_name.startswith("cuda") and not torch.cuda.is_available():
            return torch.device("cpu")
        return torch.device(self.device_name)

    def _load_config(self) -> Dict[str, Any]:
        if not self.config_path.exists():
            raise FileNotFoundError(f"Missing HY-Motion config: {self.config_path}")
        with self.config_path.open("r", encoding="utf-8") as f:
            return yaml.load(f, Loader=yaml.FullLoader)

    def _encode_prompt_once(
        self,
        config: Dict[str, Any],
        prompt: str,
        device: torch.device,
        emit: EmitEvent,
        should_cancel: CancelCheck,
    ) -> Dict[str, torch.Tensor]:
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
            self._check_cancel(should_cancel)

            emit("text_encoding", {"message": "Encoding prompt hidden states"})
            with torch.no_grad():
                vtxt_input, ctxt_input, ctxt_length = text_encoder.encode(text=[prompt])

            return {
                "text_vec_raw": vtxt_input.detach().cpu(),
                "text_ctxt_raw": ctxt_input.detach().cpu(),
                "text_ctxt_raw_length": ctxt_length.detach().cpu(),
            }
        finally:
            emit("text_encoder_unloading", {"message": "Unloading text encoders"})
            del text_encoder, vtxt_input, ctxt_input, ctxt_length
            cleanup_cuda()

    def _load_motion_pipeline(self, config: Dict[str, Any], device: torch.device):
        if not self.ckpt_path.exists():
            raise FileNotFoundError(f"Missing HY-Motion checkpoint: {self.ckpt_path}")
        pipeline = load_object(
            config["train_pipeline"],
            config["train_pipeline_args"],
            network_module=config["network_module"],
            network_module_args=config["network_module_args"],
        )
        pipeline.load_in_demo(str(self.ckpt_path), build_text_encoder=False, allow_empty_ckpt=False)
        pipeline.to(device)
        pipeline.eval()
        self._pipeline = pipeline
        cleanup_cuda()
        return pipeline

    def _unload_motion_pipeline(self) -> None:
        if self._pipeline is not None:
            del self._pipeline
            self._pipeline = None
        cleanup_cuda()

    @staticmethod
    def _move_hidden_state_dict(hidden_state_dict: Dict[str, torch.Tensor], device: torch.device) -> Dict[str, torch.Tensor]:
        return {key: value.to(device) for key, value in hidden_state_dict.items()}

    @staticmethod
    def _resolve_seeds(request: Dict[str, Any]) -> List[int]:
        seeds = request.get("seeds") or []
        variation_count = int(request.get("variationCount", 1))
        if seeds:
            seeds = [int(seed) for seed in seeds[:variation_count]]
        if len(seeds) < variation_count:
            generator = torch.Generator().manual_seed(int(time.time() * 1000) % 2**31)
            while len(seeds) < variation_count:
                seeds.append(int(torch.randint(0, 1_000_000_000, (1,), generator=generator).item()))
        return seeds

    @staticmethod
    def _check_cancel(should_cancel: CancelCheck) -> None:
        if should_cancel():
            raise JobCancelled("Job cancellation requested")


def variation_to_public_dict(artifact: VariationArtifact) -> Dict[str, Any]:
    return {
        "id": artifact.id,
        "index": artifact.index,
        "seed": artifact.seed,
        "status": "succeeded",
        "seconds": artifact.seconds,
        "frameCount": artifact.frame_count,
        "baseFilename": artifact.base_filename,
        "npzPath": str(artifact.npz_path),
        "metaPath": str(artifact.meta_path),
        "motionJsonPath": str(artifact.motion_json_path),
    }
