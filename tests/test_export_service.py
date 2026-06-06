from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from hymotion.api.export_service import export_fbx_bytes, motion_frames_to_npz_arrays, sanitize_filename_base


def sample_motion(pose_values=None):
    if pose_values is None:
        pose_values = [0.0] * 156
    if len(pose_values) == 156:
        pose_values[0:3] = [0.1, 0.2, 0.3]
    return [
        [
            {
                "id": 0,
                "gender": "neutral",
                "Rh": [[0.1, 0.2, 0.3]],
                "Th": [[1.0, 2.0, 3.0]],
                "poses": [pose_values],
                "shapes": [[0.5, 0.25]],
            }
        ],
        [
            {
                "id": 0,
                "gender": "neutral",
                "Rh": [[0.4, 0.5, 0.6]],
                "Th": [[4.0, 5.0, 6.0]],
                "poses": [[0.0] * 156],
                "shapes": [[0.5, 0.25]],
            }
        ],
    ]


class ExportServiceTests(unittest.TestCase):
    def test_motion_frames_to_npz_arrays_maps_root_and_y_offset(self) -> None:
        arrays = motion_frames_to_npz_arrays(sample_motion(), y_offset=-0.75)

        self.assertEqual(arrays["Rh"].shape, (2, 3))
        self.assertEqual(arrays["trans"].shape, (2, 3))
        self.assertEqual(arrays["poses"].shape, (2, 156))
        np.testing.assert_allclose(arrays["poses"][0, :3], [0.1, 0.2, 0.3])
        np.testing.assert_allclose(arrays["poses"][1, :3], [0.4, 0.5, 0.6])
        np.testing.assert_allclose(arrays["trans"][:, 1], [1.25, 4.25])
        self.assertEqual(arrays["betas"].shape, (10,))

    def test_motion_frames_to_npz_arrays_expands_pose_without_root(self) -> None:
        arrays = motion_frames_to_npz_arrays(sample_motion([1.0] * 69))

        np.testing.assert_allclose(arrays["poses"][0, :3], [0.1, 0.2, 0.3])
        np.testing.assert_allclose(arrays["poses"][0, 3:72], [1.0] * 69)
        np.testing.assert_allclose(arrays["poses"][0, 72:], [0.0] * 84)

    def test_sanitize_filename_base_keeps_download_name_safe(self) -> None:
        self.assertEqual(sanitize_filename_base("../bad name!.fbx"), "bad_name_.fbx")
        self.assertEqual(sanitize_filename_base(""), "hy_motion_export")

    def test_export_fbx_bytes_uses_worker_output(self) -> None:
        def fake_run(args, cwd, capture_output, text, timeout, check):
            output_path = Path(args[args.index("--output") + 1])
            status_path = Path(args[args.index("--status") + 1])
            output_path.write_bytes(b"fake-fbx")
            status_path.write_text('{"ok": true}', encoding="utf-8")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as tmp:
            with patch("hymotion.api.export_service.subprocess.run", fake_run):
                result = export_fbx_bytes(
                    motion=sample_motion(),
                    include_skin=False,
                    y_offset=0.1,
                    fps=30,
                    filename_base="seed 1",
                    repo_root=Path(tmp),
                )

        self.assertEqual(result.filename, "seed_1.fbx")
        self.assertEqual(result.content, b"fake-fbx")


if __name__ == "__main__":
    unittest.main()
