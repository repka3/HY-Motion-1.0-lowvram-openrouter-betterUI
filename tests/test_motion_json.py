from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from hymotion.api.motion_json import npz_to_motion_frames, write_motion_json


class MotionJsonTests(unittest.TestCase):
    def test_npz_conversion_matches_viewer_schema(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            npz_path = Path(tmp) / "motion.npz"
            json_path = Path(tmp) / "motion.json"
            np.savez_compressed(
                npz_path,
                gender=np.array(["neutral"], dtype=str),
                Rh=np.zeros((2, 3), dtype=np.float32),
                trans=np.ones((2, 3), dtype=np.float32),
                poses=np.zeros((2, 52, 3), dtype=np.float32),
                betas=np.zeros((10,), dtype=np.float32),
            )

            frames = npz_to_motion_frames(npz_path)
            self.assertEqual(len(frames), 2)
            self.assertEqual(frames[0][0]["id"], 0)
            self.assertIn("Rh", frames[0][0])
            self.assertIn("Th", frames[0][0])
            self.assertIn("poses", frames[0][0])
            self.assertIn("shapes", frames[0][0])
            self.assertEqual(len(frames[0][0]["poses"][0]), 156)

            frame_count = write_motion_json(npz_path, json_path)
            self.assertEqual(frame_count, 2)
            self.assertTrue(json_path.exists())


if __name__ == "__main__":
    unittest.main()
