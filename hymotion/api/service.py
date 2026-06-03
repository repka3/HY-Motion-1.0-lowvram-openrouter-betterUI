from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from hymotion.api.lowvram import JobCancelled, LowVramMotionGenerator
from hymotion.api.models import JobCreateRequest, model_to_dict


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobNotFound(KeyError):
    pass


class JobService:
    def __init__(self, output_root: Path | str | None = None, generator: LowVramMotionGenerator | None = None) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        self.output_root = Path(output_root) if output_root is not None else repo_root / "output" / "api"
        self.generator = generator or LowVramMotionGenerator()
        self._jobs: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker_task: Optional[asyncio.Task] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock = threading.RLock()
        self._subscribers: Dict[str, set[asyncio.Queue]] = {}

    async def start(self) -> None:
        self.output_root.mkdir(parents=True, exist_ok=True)
        self._loop = asyncio.get_running_loop()
        self._load_persisted_jobs()
        self._worker_task = asyncio.create_task(self._worker(), name="hymotion-api-worker")

    async def stop(self) -> None:
        if self._worker_task is None:
            return
        self._worker_task.cancel()
        try:
            await self._worker_task
        except asyncio.CancelledError:
            pass
        self._worker_task = None

    async def submit(self, request: JobCreateRequest) -> Dict[str, Any]:
        payload = model_to_dict(request)
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        now = utc_now()
        record: Dict[str, Any] = {
            "jobId": job_id,
            "status": "queued",
            "phase": "queued",
            "request": payload,
            "createdAt": now,
            "updatedAt": now,
            "startedAt": None,
            "completedAt": None,
            "cancelRequested": False,
            "error": None,
            "timing": {},
            "variations": [],
            "events": [],
            "outputDir": str(self._job_dir(job_id)),
        }
        with self._lock:
            self._jobs[job_id] = record
        self._publish(job_id, "queued", {"status": "queued", "message": "Job queued"})
        await self._queue.put(job_id)
        return self.get_job(job_id, include_events=True)

    def list_jobs(self, limit: int = 25) -> List[Dict[str, Any]]:
        with self._lock:
            jobs = list(reversed(self._jobs.values()))[:limit]
            queued = [job_id for job_id, job in self._jobs.items() if job["status"] == "queued"]
            return [self._public_job(job, include_events=False, queued=queued) for job in jobs]

    def get_job(self, job_id: str, include_events: bool = False) -> Dict[str, Any]:
        with self._lock:
            if job_id not in self._jobs:
                raise JobNotFound(job_id)
            queued = [jid for jid, job in self._jobs.items() if job["status"] == "queued"]
            return self._public_job(self._jobs[job_id], include_events=include_events, queued=queued)

    def cancel(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            if job_id not in self._jobs:
                raise JobNotFound(job_id)
            job = self._jobs[job_id]
            status = job["status"]
            if status == "queued":
                job["cancelRequested"] = True
                job["status"] = "cancelled"
                job["phase"] = "cancelled"
                job["completedAt"] = utc_now()
                job["updatedAt"] = job["completedAt"]
                self._persist(job)
                event_needed = True
            elif status == "running":
                job["cancelRequested"] = True
                job["updatedAt"] = utc_now()
                self._persist(job)
                event_needed = False
            else:
                event_needed = False
        if event_needed:
            self._publish(job_id, "cancelled", {"status": "cancelled", "message": "Queued job cancelled"})
        elif status == "running":
            self._publish(job_id, job["phase"], {"status": "running", "message": "Cancellation requested"})
        return self.get_job(job_id, include_events=True)

    def get_motion(self, job_id: str, variation_id: str) -> Any:
        with self._lock:
            if job_id not in self._jobs:
                raise JobNotFound(job_id)
            variations = self._jobs[job_id].get("variations", [])
            variation = next((item for item in variations if item["id"] == variation_id), None)
            if variation is None:
                raise JobNotFound(f"{job_id}/{variation_id}")
            motion_path = Path(variation["motionJsonPath"])
        if not motion_path.exists():
            raise FileNotFoundError(str(motion_path))
        with motion_path.open("r", encoding="utf-8") as f:
            return json.load(f)

    async def subscribe(self, job_id: str) -> asyncio.Queue:
        with self._lock:
            if job_id not in self._jobs:
                raise JobNotFound(job_id)
            queue: asyncio.Queue = asyncio.Queue()
            self._subscribers.setdefault(job_id, set()).add(queue)
            backlog = list(self._jobs[job_id].get("events", []))
        for event in backlog:
            await queue.put(event)
        return queue

    def unsubscribe(self, job_id: str, queue: asyncio.Queue) -> None:
        with self._lock:
            queues = self._subscribers.get(job_id)
            if queues is not None:
                queues.discard(queue)

    async def _worker(self) -> None:
        while True:
            job_id = await self._queue.get()
            try:
                with self._lock:
                    job = self._jobs.get(job_id)
                    if job is None or job["status"] == "cancelled" or job.get("cancelRequested"):
                        continue
                    job["status"] = "running"
                    job["startedAt"] = utc_now()
                    job["updatedAt"] = job["startedAt"]
                    self._persist(job)
                await asyncio.to_thread(self._run_job_sync, job_id)
            finally:
                self._queue.task_done()

    def _run_job_sync(self, job_id: str) -> None:
        start = time.perf_counter()

        def emit(event_type: str, payload: Dict[str, Any]) -> None:
            self._publish(job_id, event_type, payload)

        try:
            with self._lock:
                request = dict(self._jobs[job_id]["request"])
            artifacts = self.generator.run_job(
                request=request,
                job_dir=self._job_dir(job_id),
                emit=emit,
                should_cancel=lambda: self._is_cancel_requested(job_id),
            )
            with self._lock:
                job = self._jobs[job_id]
                job["variations"] = [self._variation_public(artifact) for artifact in artifacts]
                job["status"] = "succeeded"
                job["phase"] = "succeeded"
                job["completedAt"] = utc_now()
                job["updatedAt"] = job["completedAt"]
                job["timing"]["totalSeconds"] = time.perf_counter() - start
                self._persist(job)
            self._publish(job_id, "succeeded", {"status": "succeeded", "message": "Job complete"})
        except JobCancelled:
            with self._lock:
                job = self._jobs[job_id]
                job["status"] = "cancelled"
                job["phase"] = "cancelled"
                job["completedAt"] = utc_now()
                job["updatedAt"] = job["completedAt"]
                job["timing"]["totalSeconds"] = time.perf_counter() - start
                self._persist(job)
            self._publish(job_id, "cancelled", {"status": "cancelled", "message": "Job cancelled"})
        except Exception as exc:
            with self._lock:
                job = self._jobs[job_id]
                job["status"] = "failed"
                job["phase"] = "failed"
                job["error"] = str(exc)
                job["completedAt"] = utc_now()
                job["updatedAt"] = job["completedAt"]
                job["timing"]["totalSeconds"] = time.perf_counter() - start
                self._persist(job)
            self._publish(job_id, "failed", {"status": "failed", "message": str(exc)})

    def _publish(self, job_id: str, event_type: str, payload: Dict[str, Any]) -> None:
        event = {
            "type": event_type,
            "jobId": job_id,
            "timestamp": utc_now(),
            **payload,
        }
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if event_type in {
                "queued",
                "text_encoder_loading",
                "text_encoding",
                "text_encoder_unloading",
                "motion_loading",
                "generating",
                "variation_done",
                "succeeded",
                "failed",
                "cancelled",
            }:
                job["phase"] = event_type
            if "status" in payload:
                job["status"] = payload["status"]
            if event_type == "variation_done" and payload.get("variation"):
                variation = payload["variation"]
                existing = [item for item in job["variations"] if item["id"] != variation["id"]]
                job["variations"] = [*existing, variation]
            job["updatedAt"] = event["timestamp"]
            job.setdefault("events", []).append(event)
            job["events"] = job["events"][-200:]
            self._persist(job)
            subscribers = list(self._subscribers.get(job_id, set()))

        loop = self._loop
        if loop is None:
            return
        for queue in subscribers:
            loop.call_soon_threadsafe(queue.put_nowait, event)

    def _is_cancel_requested(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            return bool(job is None or job.get("cancelRequested") or job.get("status") == "cancelled")

    def _job_dir(self, job_id: str) -> Path:
        return self.output_root / job_id

    def _job_json_path(self, job_id: str) -> Path:
        return self._job_dir(job_id) / "job.json"

    def _persist(self, job: Dict[str, Any]) -> None:
        path = self._job_json_path(job["jobId"])
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as f:
            json.dump(job, f, indent=2, ensure_ascii=False)

    def _load_persisted_jobs(self) -> None:
        if not self.output_root.exists():
            return
        with self._lock:
            for path in sorted(self.output_root.glob("job_*/job.json")):
                try:
                    with path.open("r", encoding="utf-8") as f:
                        job = json.load(f)
                    if job.get("status") in {"queued", "running"}:
                        job["status"] = "failed"
                        job["phase"] = "failed"
                        job["error"] = "Server stopped before the job finished"
                        job["completedAt"] = utc_now()
                    self._jobs[job["jobId"]] = job
                except Exception:
                    continue

    @staticmethod
    def _variation_public(artifact) -> Dict[str, Any]:
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

    @staticmethod
    def _public_job(job: Dict[str, Any], include_events: bool, queued: Optional[List[str]] = None) -> Dict[str, Any]:
        public = {
            "jobId": job["jobId"],
            "status": job["status"],
            "phase": job["phase"],
            "request": job["request"],
            "createdAt": job["createdAt"],
            "updatedAt": job["updatedAt"],
            "startedAt": job.get("startedAt"),
            "completedAt": job.get("completedAt"),
            "cancelRequested": job.get("cancelRequested", False),
            "error": job.get("error"),
            "timing": job.get("timing", {}),
            "variations": [
                {
                    "id": item["id"],
                    "index": item["index"],
                    "seed": item["seed"],
                    "status": item.get("status", "succeeded"),
                    "seconds": item.get("seconds"),
                    "frameCount": item.get("frameCount"),
                    "baseFilename": item.get("baseFilename"),
                }
                for item in job.get("variations", [])
            ],
        }
        if queued and job["status"] == "queued":
            public["queuePosition"] = queued.index(job["jobId"]) + 1 if job["jobId"] in queued else None
        else:
            public["queuePosition"] = None
        if include_events:
            public["events"] = job.get("events", [])
        return public
