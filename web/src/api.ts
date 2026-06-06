import type {
  FavoriteCreateRequest,
  FavoriteSummary,
  ExportFbxRequest,
  JobDetail,
  JobRequest,
  JobSummary,
  MotionFrames,
  OpenRouterSettings,
  OpenRouterSettingsUpdate,
  PromptEnhanceRequest,
  PromptEnhanceResponse
} from "./types";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init
  });
  if (!response.ok) {
    const text = await response.text();
    let detail: unknown;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      detail = parsed.detail;
    } catch {
      // Fall through to the raw body when the backend did not return the usual FastAPI shape.
    }
    if (typeof detail === "string") throw new Error(detail);
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  let detail: unknown;
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    detail = parsed.detail;
  } catch {
    // Fall through to the raw response body.
  }
  if (typeof detail === "string") return new Error(detail);
  return new Error(text || response.statusText);
}

export function listJobs(): Promise<JobSummary[]> {
  return requestJson<JobSummary[]>("/api/jobs");
}

export async function createJob(request: JobRequest): Promise<string> {
  const response = await requestJson<{ jobId: string }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify(request)
  });
  return response.jobId;
}

export function getJob(jobId: string): Promise<JobDetail> {
  return requestJson<JobDetail>(`/api/jobs/${jobId}`);
}

export function cancelJob(jobId: string): Promise<JobDetail> {
  return requestJson<JobDetail>(`/api/jobs/${jobId}`, { method: "DELETE" });
}

export function getMotion(jobId: string, variationId: string): Promise<MotionFrames> {
  return requestJson<MotionFrames>(`/api/jobs/${jobId}/variations/${variationId}/motion`);
}

export function listFavorites(): Promise<FavoriteSummary[]> {
  return requestJson<FavoriteSummary[]>("/api/favorites");
}

export function createFavorite(request: FavoriteCreateRequest): Promise<FavoriteSummary> {
  return requestJson<FavoriteSummary>("/api/favorites", {
    method: "POST",
    body: JSON.stringify(request)
  });
}

export function getFavoriteMotion(favoriteId: string): Promise<MotionFrames> {
  return requestJson<MotionFrames>(`/api/favorites/${favoriteId}/motion`);
}

export function deleteFavorite(favoriteId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/favorites/${favoriteId}`, { method: "DELETE" });
}

export function getOpenRouterSettings(): Promise<OpenRouterSettings> {
  return requestJson<OpenRouterSettings>("/api/openrouter/settings");
}

export function saveOpenRouterSettings(request: OpenRouterSettingsUpdate): Promise<OpenRouterSettings> {
  return requestJson<OpenRouterSettings>("/api/openrouter/settings", {
    method: "PUT",
    body: JSON.stringify(request)
  });
}

export function enhancePrompt(request: PromptEnhanceRequest): Promise<PromptEnhanceResponse> {
  return requestJson<PromptEnhanceResponse>("/api/openrouter/enhance", {
    method: "POST",
    body: JSON.stringify(request)
  });
}

export async function exportFbx(request: ExportFbxRequest): Promise<Blob> {
  const response = await fetch("/api/export/fbx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export function createJobSocket(jobId: string): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${window.location.host}/api/jobs/${jobId}/events`);
}
