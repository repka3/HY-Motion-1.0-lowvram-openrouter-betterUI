from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from hymotion.api.models import (
    FavoriteCreateRequest,
    JobCreateRequest,
    JobCreateResponse,
    OpenRouterSettingsResponse,
    OpenRouterSettingsUpdate,
    PromptEnhanceRequest,
    PromptEnhanceResponse,
)
from hymotion.api.openrouter_prompt import OpenRouterConfigError, OpenRouterPromptService, OpenRouterResponseError
from hymotion.api.service import JobNotFound, JobService


service = JobService()
openrouter_service = OpenRouterPromptService()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await service.start()
    try:
        yield
    finally:
        await service.stop()


app = FastAPI(title="HY-Motion Creator Studio API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/openrouter/settings", response_model=OpenRouterSettingsResponse)
def get_openrouter_settings():
    try:
        return openrouter_service.public_settings()
    except OpenRouterConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.put("/api/openrouter/settings", response_model=OpenRouterSettingsResponse)
def update_openrouter_settings(request: OpenRouterSettingsUpdate):
    try:
        return openrouter_service.update_settings(
            api_key=request.apiKey,
            model=request.model,
            system_prompt=request.systemPrompt,
            clear_api_key=request.clearApiKey,
        )
    except OpenRouterConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/openrouter/enhance", response_model=PromptEnhanceResponse)
def enhance_prompt(request: PromptEnhanceRequest):
    try:
        return openrouter_service.enhance_prompt(request.prompt)
    except OpenRouterConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OpenRouterResponseError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OpenRouter request failed: {exc}")


@app.post("/api/jobs", response_model=JobCreateResponse)
async def create_job(request: JobCreateRequest):
    job = await service.submit(request)
    return {"jobId": job["jobId"]}


@app.get("/api/jobs")
def list_jobs():
    return service.list_jobs()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    try:
        return service.get_job(job_id, include_events=True)
    except JobNotFound:
        raise HTTPException(status_code=404, detail="Job not found")


@app.delete("/api/jobs/{job_id}")
def cancel_job(job_id: str):
    try:
        return service.cancel(job_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail="Job not found")


@app.get("/api/jobs/{job_id}/variations/{variation_id}/motion")
def get_motion(job_id: str, variation_id: str):
    try:
        return service.get_motion(job_id, variation_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail="Job or variation not found")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Motion JSON not found")


@app.get("/api/favorites")
def list_favorites():
    return service.list_favorites()


@app.post("/api/favorites")
def create_favorite(request: FavoriteCreateRequest):
    try:
        return service.create_favorite(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/favorites/{favorite_id}")
def get_favorite(favorite_id: str):
    try:
        return service.get_favorite(favorite_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail="Favorite not found")


@app.get("/api/favorites/{favorite_id}/motion")
def get_favorite_motion(favorite_id: str):
    try:
        return service.get_favorite_motion(favorite_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail="Favorite not found")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Favorite motion JSON not found")


@app.delete("/api/favorites/{favorite_id}")
def delete_favorite(favorite_id: str):
    try:
        service.delete_favorite(favorite_id)
        return {"ok": True}
    except JobNotFound:
        raise HTTPException(status_code=404, detail="Favorite not found")


@app.websocket("/api/jobs/{job_id}/events")
async def job_events(websocket: WebSocket, job_id: str):
    await websocket.accept()
    try:
        queue = await service.subscribe(job_id)
    except JobNotFound:
        await websocket.send_json({"type": "failed", "jobId": job_id, "message": "Job not found"})
        await websocket.close(code=1008)
        return

    try:
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        service.unsubscribe(job_id, queue)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("hymotion.api.main:app", host="127.0.0.1", port=8000, reload=False)
