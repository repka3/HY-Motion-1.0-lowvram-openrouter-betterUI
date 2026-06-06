from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np


class ExportError(RuntimeError):
    pass


@dataclass
class FbxExportResult:
    filename: str
    content: bytes


def sanitize_filename_base(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    sanitized = sanitized.strip("._-")
    return sanitized[:120] or "hy_motion_export"


def motion_frames_to_npz_arrays(motion: Any, y_offset: float = 0.0) -> Dict[str, np.ndarray]:
    if not isinstance(motion, list) or not motion:
        raise ExportError("Motion must contain at least one frame")

    rh_values: List[List[float]] = []
    trans_values: List[List[float]] = []
    pose_values: List[np.ndarray] = []
    betas: Optional[np.ndarray] = None
    gender = "neutral"

    for frame_index, frame in enumerate(motion):
        actor = _actor_for_frame(frame)
        if actor is None:
            raise ExportError(f"Motion frame {frame_index + 1} has no actors")

        rh = _first_vector(actor.get("Rh"), 3, "Rh", frame_index)
        th = _first_vector(actor.get("Th"), 3, "Th", frame_index)
        th = [th[0], th[1] + float(y_offset), th[2]]
        pose = _full_pose_vector(actor.get("poses"), rh, frame_index)

        if betas is None:
            betas = _shape_vector(actor.get("shapes"))
        if isinstance(actor.get("gender"), str):
            gender = actor["gender"]

        rh_values.append(rh)
        trans_values.append(th)
        pose_values.append(pose)

    if betas is None:
        betas = np.zeros((10,), dtype=np.float32)

    return {
        "gender": np.array([gender], dtype=str),
        "Rh": np.asarray(rh_values, dtype=np.float32),
        "trans": np.asarray(trans_values, dtype=np.float32),
        "poses": np.stack(pose_values, axis=0).astype(np.float32),
        "betas": betas.astype(np.float32),
    }


def export_fbx_bytes(
    *,
    motion: Any,
    include_skin: bool,
    y_offset: float,
    fps: int,
    filename_base: str,
    repo_root: Path | None = None,
    timeout_seconds: int = 180,
) -> FbxExportResult:
    root = repo_root or Path(__file__).resolve().parents[2]
    safe_base = sanitize_filename_base(filename_base)

    arrays = motion_frames_to_npz_arrays(motion, y_offset=y_offset)
    with tempfile.TemporaryDirectory(prefix="hymotion_export_") as tmp:
        tmp_dir = Path(tmp)
        npz_path = tmp_dir / "motion.npz"
        output_path = tmp_dir / f"{safe_base}.fbx"
        request_path = tmp_dir / "request.json"
        status_path = tmp_dir / "status.json"

        np.savez_compressed(npz_path, **arrays)
        request = {
            "npzPath": str(npz_path),
            "templateFbxPath": str(root / "assets" / "wooden_models" / "boy_Rigging_smplx_tex.fbx"),
            "includeSkin": include_skin,
            "fps": fps,
        }
        request_path.write_text(json.dumps(request), encoding="utf-8")

        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "hymotion.api.fbx_export_worker",
                "--request",
                str(request_path),
                "--output",
                str(output_path),
                "--status",
                str(status_path),
            ],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )

        status = _read_status(status_path)
        if completed.returncode != 0 or not output_path.exists():
            detail = status.get("error") or completed.stderr.strip() or completed.stdout.strip()
            raise ExportError(f"FBX export failed: {detail or f'worker exited with {completed.returncode}'}")

        return FbxExportResult(filename=f"{safe_base}.fbx", content=output_path.read_bytes())


def _read_status(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _actor_for_frame(frame: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(frame, list) or not frame:
        return None
    for actor in frame:
        if isinstance(actor, dict) and actor.get("id") == 0:
            return actor
    first = frame[0]
    return first if isinstance(first, dict) else None


def _first_vector(value: Any, size: int, field: str, frame_index: int) -> List[float]:
    if not isinstance(value, list) or not value:
        raise ExportError(f"Motion frame {frame_index + 1} is missing {field}")
    vector = value[0]
    if not isinstance(vector, list) or len(vector) < size:
        raise ExportError(f"Motion frame {frame_index + 1} has invalid {field}")
    return [float(item) for item in vector[:size]]


def _full_pose_vector(value: Any, rh: List[float], frame_index: int) -> np.ndarray:
    pose = np.zeros((156,), dtype=np.float32)
    pose[:3] = np.asarray(rh, dtype=np.float32)

    pose_values: List[float] = []
    if isinstance(value, list) and value:
        raw = value[0]
        if isinstance(raw, list):
            pose_values = [float(item) for item in raw]

    if not pose_values:
        return pose
    if len(pose_values) == 156:
        pose[:] = np.asarray(pose_values, dtype=np.float32)
        pose[:3] = np.asarray(rh, dtype=np.float32)
        return pose
    if len(pose_values) > 156:
        raise ExportError(f"Motion frame {frame_index + 1} has too many pose values")

    available = min(153, len(pose_values))
    pose[3 : 3 + available] = np.asarray(pose_values[:available], dtype=np.float32)
    return pose


def _shape_vector(value: Any) -> np.ndarray:
    if isinstance(value, list):
        raw = value[0] if value and isinstance(value[0], list) else value
        if isinstance(raw, list) and raw:
            shape = np.zeros((10,), dtype=np.float32)
            values = [float(item) for item in raw[:10]]
            shape[: len(values)] = values
            return shape
    return np.zeros((10,), dtype=np.float32)
