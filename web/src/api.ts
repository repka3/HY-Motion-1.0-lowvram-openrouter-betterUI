import type { JobDetail, JobRequest, JobSummary, MotionFrames } from "./types";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
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

export function createJobSocket(jobId: string): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${window.location.host}/api/jobs/${jobId}/events`);
}
