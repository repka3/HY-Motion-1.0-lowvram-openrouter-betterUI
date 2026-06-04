from __future__ import annotations

import asyncio
import json
import shutil
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from hymotion.api.lowvram import JobCancelled, LowVramMotionGenerator
from hymotion.api.models import FavoriteCreateRequest, JobCreateRequest, model_to_dict


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobNotFound(KeyError):
    pass


class JobService:
    def __init__(
        self,
        output_root: Path | str | None = None,
        generator: LowVramMotionGenerator | None = None,
        favorites_root: Path | str | None = None,
    ) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        self.output_root = Path(output_root) if output_root is not None else repo_root / "output" / "api"
        if favorites_root is not None:
            self.favorites_root = Path(favorites_root)
        elif self.output_root.name == "api":
            self.favorites_root = self.output_root.parent / "favorites"
        else:
            self.favorites_root = self.output_root / "favorites"
        self.generator = generator or LowVramMotionGenerator()
        self._jobs: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._favorites: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker_task: Optional[asyncio.Task] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock = threading.RLock()
        self._subscribers: Dict[str, set[asyncio.Queue]] = {}

    async def start(self) -> None:
        self.output_root.mkdir(parents=True, exist_ok=True)
        self.favorites_root.mkdir(parents=True, exist_ok=True)
        self._loop = asyncio.get_running_loop()
        self._purge_transient_job_dirs()
        self._load_favorites()
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

    def list_favorites(self) -> List[Dict[str, Any]]:
        with self._lock:
            favorites = sorted(self._favorites.values(), key=lambda item: item.get("favoritedAt", ""), reverse=True)
            return [self._public_favorite(item) for item in favorites]

    def get_favorite(self, favorite_id: str) -> Dict[str, Any]:
        with self._lock:
            if favorite_id not in self._favorites:
                raise JobNotFound(favorite_id)
            return self._public_favorite(self._favorites[favorite_id])

    def get_favorite_motion(self, favorite_id: str) -> Any:
        with self._lock:
            if favorite_id not in self._favorites:
                raise JobNotFound(favorite_id)
            motion_path = Path(self._favorites[favorite_id]["motionJsonPath"])
        if not motion_path.exists():
            raise FileNotFoundError(str(motion_path))
        with motion_path.open("r", encoding="utf-8") as f:
            return json.load(f)

    def create_favorite(self, request: FavoriteCreateRequest) -> Dict[str, Any]:
        payload = model_to_dict(request)
        motion = payload.pop("motion")
        if not isinstance(motion, list):
            raise ValueError("Favorite motion must be a JSON list of frames")

        favorite_id = f"fav_{uuid.uuid4().hex[:12]}"
        now = utc_now()
        frame_count = payload.get("frameCount")
        if frame_count is None:
            frame_count = len(motion)

        favorite_dir = self._favorite_dir(favorite_id)
        motion_path = favorite_dir / "motion.json"
        record = {
            "id": favorite_id,
            "favoritedAt": now,
            "frameCount": frame_count,
            "motionJsonPath": str(motion_path),
            **payload,
        }

        favorite_dir.mkdir(parents=True, exist_ok=True)
        with motion_path.open("w", encoding="utf-8") as f:
            json.dump(motion, f, ensure_ascii=False)
        self._persist_favorite(record)

        with self._lock:
            self._favorites[favorite_id] = record
        return self._public_favorite(record)

    def delete_favorite(self, favorite_id: str) -> None:
        with self._lock:
            if favorite_id not in self._favorites:
                raise JobNotFound(favorite_id)
            self._favorites.pop(favorite_id, None)
        shutil.rmtree(self._favorite_dir(favorite_id), ignore_errors=True)

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
            motion_frames = variation.get("motionFrames")
        if motion_frames is not None:
            return motion_frames
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
                self._cache_job_motion_frames(job)
                job["status"] = "succeeded"
                job["phase"] = "succeeded"
                job["completedAt"] = utc_now()
                job["updatedAt"] = job["completedAt"]
                job["timing"]["totalSeconds"] = time.perf_counter() - start
                self._persist(job)
            self._publish(job_id, "succeeded", {"status": "succeeded", "message": "Job complete"})
            self._cleanup_job_files(job_id)
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
            self._cleanup_job_files(job_id)
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
            self._cleanup_job_files(job_id)

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

    def _favorite_dir(self, favorite_id: str) -> Path:
        return self.favorites_root / favorite_id

    def _favorite_json_path(self, favorite_id: str) -> Path:
        return self._favorite_dir(favorite_id) / "favorite.json"

    def _persist(self, job: Dict[str, Any]) -> None:
        path = self._job_json_path(job["jobId"])
        path.parent.mkdir(parents=True, exist_ok=True)
        persisted = self._job_without_motion_frames(job)
        with path.open("w", encoding="utf-8") as f:
            json.dump(persisted, f, indent=2, ensure_ascii=False)

    def _persist_favorite(self, favorite: Dict[str, Any]) -> None:
        path = self._favorite_json_path(favorite["id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        public = self._public_favorite(favorite)
        with path.open("w", encoding="utf-8") as f:
            json.dump(public, f, indent=2, ensure_ascii=False)

    def _purge_transient_job_dirs(self) -> None:
        if not self.output_root.exists():
            return
        for path in self.output_root.glob("job_*"):
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)

    def _load_favorites(self) -> None:
        if not self.favorites_root.exists():
            return
        with self._lock:
            for path in sorted(self.favorites_root.glob("fav_*/favorite.json")):
                try:
                    with path.open("r", encoding="utf-8") as f:
                        favorite = json.load(f)
                    favorite_id = favorite["id"]
                    favorite["motionJsonPath"] = str(self._favorite_dir(favorite_id) / "motion.json")
                    self._favorites[favorite_id] = favorite
                except Exception:
                    continue

    def _cleanup_job_files(self, job_id: str) -> None:
        shutil.rmtree(self._job_dir(job_id), ignore_errors=True)

    @staticmethod
    def _cache_job_motion_frames(job: Dict[str, Any]) -> None:
        for variation in job.get("variations", []):
            if variation.get("motionFrames") is not None:
                continue
            motion_path = variation.get("motionJsonPath")
            if not motion_path:
                continue
            path = Path(motion_path)
            if not path.exists():
                continue
            try:
                with path.open("r", encoding="utf-8") as f:
                    variation["motionFrames"] = json.load(f)
            except Exception:
                continue

    @staticmethod
    def _job_without_motion_frames(job: Dict[str, Any]) -> Dict[str, Any]:
        persisted = dict(job)
        persisted["variations"] = [
            {key: value for key, value in variation.items() if key != "motionFrames"}
            for variation in job.get("variations", [])
        ]
        return persisted

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

    @staticmethod
    def _public_favorite(favorite: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": favorite["id"],
            "favoritedAt": favorite["favoritedAt"],
            "jobId": favorite.get("jobId"),
            "variationId": favorite["variationId"],
            "variationIndex": favorite.get("variationIndex", 0),
            "prompt": favorite["prompt"],
            "durationSeconds": favorite["durationSeconds"],
            "cfgScale": favorite["cfgScale"],
            "steps": favorite.get("steps", 50),
            "variationCount": favorite.get("variationCount", 1),
            "seed": favorite["seed"],
            "seconds": favorite.get("seconds"),
            "frameCount": favorite.get("frameCount"),
            "baseFilename": favorite.get("baseFilename"),
            "jobCreatedAt": favorite.get("jobCreatedAt"),
            "jobStartedAt": favorite.get("jobStartedAt"),
            "jobCompletedAt": favorite.get("jobCompletedAt"),
        }
