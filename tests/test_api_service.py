from __future__ import annotations

import asyncio
import threading
import time
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

from hymotion.api.lowvram import JobCancelled, LowVramMotionGenerator
from hymotion.api.models import JobCreateRequest
from hymotion.api.service import JobService


class SuccessGenerator:
    def run_job(self, request: Dict[str, Any], job_dir: Path, emit, should_cancel) -> List[SimpleNamespace]:
        count = int(request["variationCount"])
        artifacts = []
        for index in range(count):
            if should_cancel():
                raise JobCancelled()
            variation_id = f"var_{index + 1:02d}"
            artifact = SimpleNamespace(
                id=variation_id,
                index=index,
                seed=(request.get("seeds") or [100 + index])[index],
                seconds=0.01,
                frame_count=12,
                base_filename=f"fixture_{variation_id}",
                npz_path=job_dir / f"fixture_{variation_id}.npz",
                meta_path=job_dir / f"fixture_{variation_id}_meta.json",
                motion_json_path=job_dir / f"{variation_id}_motion.json",
            )
            artifacts.append(artifact)
            emit("variation_done", {"variation": JobService._variation_public(artifact)})
        return artifacts


class BlockingGenerator:
    def __init__(self) -> None:
        self.started = threading.Event()

    def run_job(self, request: Dict[str, Any], job_dir: Path, emit, should_cancel):
        emit("motion_loading", {})
        self.started.set()
        while not should_cancel():
            time.sleep(0.01)
        raise JobCancelled()


async def wait_for_status(service: JobService, job_id: str, status: str) -> Dict[str, Any]:
    for _ in range(200):
        job = service.get_job(job_id, include_events=True)
        if job["status"] == status:
            return job
        await asyncio.sleep(0.01)
    raise AssertionError(f"Job {job_id} did not reach {status}")


class JobServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_successful_job_records_variations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            service = JobService(output_root=tmp, generator=SuccessGenerator())
            await service.start()
            try:
                created = await service.submit(
                    JobCreateRequest(
                        prompt="walk forward",
                        durationSeconds=4,
                        cfgScale=5,
                        variationCount=2,
                        seeds=[11, 22],
                    )
                )
                job = await wait_for_status(service, created["jobId"], "succeeded")
                self.assertEqual(job["phase"], "succeeded")
                self.assertEqual([item["seed"] for item in job["variations"]], [11, 22])
                self.assertGreaterEqual(len(job["events"]), 2)
            finally:
                await service.stop()

    async def test_running_job_cancel_is_checked_by_worker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            generator = BlockingGenerator()
            service = JobService(output_root=tmp, generator=generator)
            await service.start()
            try:
                created = await service.submit(JobCreateRequest(prompt="jump", variationCount=1))
                await asyncio.to_thread(generator.started.wait, 1)
                service.cancel(created["jobId"])
                job = await wait_for_status(service, created["jobId"], "cancelled")
                self.assertEqual(job["phase"], "cancelled")
            finally:
                await service.stop()

    async def test_queued_job_can_be_cancelled_before_worker_starts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            service = JobService(output_root=tmp, generator=SuccessGenerator())
            created = await service.submit(JobCreateRequest(prompt="turn around", variationCount=1))
            job = service.cancel(created["jobId"])
            self.assertEqual(job["status"], "cancelled")
            self.assertEqual(job["phase"], "cancelled")


class SeedResolutionTests(unittest.TestCase):
    def test_seed_resolution_clips_to_variation_count(self) -> None:
        seeds = LowVramMotionGenerator._resolve_seeds({"variationCount": 2, "seeds": [1, 2, 3]})
        self.assertEqual(seeds, [1, 2])

    def test_seed_resolution_fills_missing_seeds(self) -> None:
        seeds = LowVramMotionGenerator._resolve_seeds({"variationCount": 3, "seeds": [7]})
        self.assertEqual(seeds[0], 7)
        self.assertEqual(len(seeds), 3)

    def test_job_request_keeps_variation_count_with_partial_seeds(self) -> None:
        request = JobCreateRequest(prompt="walk", variationCount=4, seeds=[7])
        self.assertEqual(request.variationCount, 4)


if __name__ == "__main__":
    unittest.main()
