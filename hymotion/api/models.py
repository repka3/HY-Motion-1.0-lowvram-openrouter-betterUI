from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
JobPhase = Literal[
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
]


class JobCreateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    durationSeconds: float = Field(4.0, ge=0.5, le=20.0)
    cfgScale: float = Field(5.0, ge=1.0, le=10.0)
    steps: int = Field(50, ge=50, le=200, multiple_of=25)
    variationCount: int = Field(1, ge=1, le=8)
    seeds: Optional[List[int]] = None


class JobCreateResponse(BaseModel):
    jobId: str


class VariationSummary(BaseModel):
    id: str
    index: int
    seed: int
    status: JobStatus
    seconds: Optional[float] = None
    frameCount: Optional[int] = None
    baseFilename: Optional[str] = None


class JobSummary(BaseModel):
    jobId: str
    status: JobStatus
    phase: JobPhase
    request: Dict[str, Any]
    createdAt: str
    updatedAt: str
    startedAt: Optional[str] = None
    completedAt: Optional[str] = None
    queuePosition: Optional[int] = None
    cancelRequested: bool = False
    error: Optional[str] = None
    timing: Dict[str, float] = Field(default_factory=dict)
    variations: List[VariationSummary] = Field(default_factory=list)


class JobDetail(JobSummary):
    events: List[Dict[str, Any]] = Field(default_factory=list)


class FavoriteCreateRequest(BaseModel):
    jobId: Optional[str] = None
    variationId: str
    variationIndex: int = 0
    prompt: str = Field(..., min_length=1, max_length=2000)
    durationSeconds: float = Field(4.0, ge=0.5, le=20.0)
    cfgScale: float = Field(5.0, ge=1.0, le=10.0)
    steps: int = Field(50, ge=50, le=200, multiple_of=25)
    variationCount: int = Field(1, ge=1, le=8)
    seed: int
    seconds: Optional[float] = None
    frameCount: Optional[int] = None
    baseFilename: Optional[str] = None
    jobCreatedAt: Optional[str] = None
    jobStartedAt: Optional[str] = None
    jobCompletedAt: Optional[str] = None
    motion: Any


class OpenRouterSettingsResponse(BaseModel):
    hasApiKey: bool = False
    model: str = ""
    systemPrompt: str
    defaultSystemPrompt: str


class OpenRouterSettingsUpdate(BaseModel):
    apiKey: Optional[str] = Field(None, max_length=1000)
    model: Optional[str] = Field(None, max_length=240)
    systemPrompt: Optional[str] = Field(None, max_length=12000)
    clearApiKey: bool = False


class PromptEnhanceRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)


class PromptEnhanceResponse(BaseModel):
    prompt: str
    durationSeconds: float
    model: str


def model_to_dict(model: BaseModel) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()
