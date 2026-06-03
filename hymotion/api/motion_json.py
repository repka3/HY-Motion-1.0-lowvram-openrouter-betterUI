from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import numpy as np


MotionFrame = List[Dict[str, Any]]
MotionFrames = List[MotionFrame]


def npz_to_motion_frames(npz_path: Path, actor_id: int = 0) -> MotionFrames:
    with np.load(npz_path, allow_pickle=False) as data:
        gender = str(data["gender"][0])
        rh = data["Rh"]
        trans = data["trans"]
        poses = data["poses"]
        betas = data["betas"]

        if poses.ndim == 3:
            poses = poses.reshape(poses.shape[0], -1)

        frames: MotionFrames = []
        for frame_index in range(len(poses)):
            frames.append(
                [
                    {
                        "id": actor_id,
                        "gender": gender,
                        "Rh": rh[frame_index : frame_index + 1].tolist(),
                        "Th": trans[frame_index : frame_index + 1].tolist(),
                        "poses": poses[frame_index : frame_index + 1].tolist(),
                        "shapes": betas.tolist(),
                    }
                ]
            )

        return frames


def write_motion_json(npz_path: Path, json_path: Path, actor_id: int = 0) -> int:
    frames = npz_to_motion_frames(npz_path=npz_path, actor_id=actor_id)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(frames, f, ensure_ascii=False)
    return len(frames)
