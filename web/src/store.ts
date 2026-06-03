import { create } from "zustand";

import { cancelJob, createJob, createJobSocket, getJob, getMotion, listJobs } from "./api";
import type { JobDetail, JobEvent, JobRequest, JobSummary, MotionFrames } from "./types";

let activeSocket: WebSocket | null = null;

interface StudioState {
  jobs: JobSummary[];
  selectedJob: JobDetail | null;
  selectedVariationId: string | null;
  frames: MotionFrames | null;
  currentFrame: number;
  isPlaying: boolean;
  speed: number;
  resetToken: number;
  statusLine: string;
  loading: boolean;
  submitting: boolean;
  viewerReady: boolean;
  error: string | null;
  fetchJobs: () => Promise<void>;
  submitJob: (request: JobRequest) => Promise<void>;
  refreshSelectedJob: () => Promise<void>;
  selectJob: (jobId: string) => Promise<void>;
  selectVariation: (jobId: string, variationId: string) => Promise<void>;
  cancelSelectedJob: () => Promise<void>;
  setCurrentFrame: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  resetCamera: () => void;
  setViewerReady: (ready: boolean) => void;
  loadFixture: (path: string) => Promise<void>;
}

function phaseLabel(event: JobEvent | JobDetail | null): string {
  const phase = event ? ("type" in event ? event.type : event.phase) : undefined;
  if (!phase) return "Idle";
  switch (phase) {
    case "queued":
      return "Queued";
    case "text_encoder_loading":
      return "Loading text encoders";
    case "text_encoding":
      return "Encoding prompt";
    case "text_encoder_unloading":
      return "Releasing text encoders";
    case "motion_loading":
      return "Loading HY-Motion";
    case "generating":
      return event && "variationIndex" in event && event.variationIndex !== undefined
        ? `Generating variation ${event.variationIndex + 1}`
        : "Generating";
    case "variation_done":
      return "Variation ready";
    case "succeeded":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
  return "Idle";
}

async function loadJobIntoState(jobId: string): Promise<JobDetail> {
  return getJob(jobId);
}

export const useStudioStore = create<StudioState>((set, get) => ({
  jobs: [],
  selectedJob: null,
  selectedVariationId: null,
  frames: null,
  currentFrame: 0,
  isPlaying: false,
  speed: 1,
  resetToken: 0,
  statusLine: "Idle",
  loading: false,
  submitting: false,
  viewerReady: false,
  error: null,

  fetchJobs: async () => {
    const jobs = await listJobs();
    set({ jobs });
  },

  submitJob: async (request) => {
    set({ submitting: true, error: null, statusLine: "Submitting" });
    try {
      const jobId = await createJob(request);
      await get().selectJob(jobId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), statusLine: "Submit failed" });
    } finally {
      set({ submitting: false });
      await get().fetchJobs();
    }
  },

  refreshSelectedJob: async () => {
    const selectedJob = get().selectedJob;
    if (!selectedJob) return;
    const fresh = await loadJobIntoState(selectedJob.jobId);
    set({ selectedJob: fresh, statusLine: phaseLabel(fresh) });
  },

  selectJob: async (jobId) => {
    activeSocket?.close();
    set({ loading: true, error: null, selectedVariationId: null, frames: null, currentFrame: 0, viewerReady: false });
    try {
      const job = await loadJobIntoState(jobId);
      set({ selectedJob: job, statusLine: phaseLabel(job) });
      activeSocket = createJobSocket(jobId);
      activeSocket.onmessage = async (message) => {
        const event = JSON.parse(message.data) as JobEvent;
        set({ statusLine: event.message ?? phaseLabel(event) });
        const fresh = await loadJobIntoState(jobId);
        set({ selectedJob: fresh });
        await get().fetchJobs();
        if (event.type === "variation_done" && event.variation?.id && !get().selectedVariationId) {
          await get().selectVariation(jobId, event.variation.id);
        }
      };
      activeSocket.onerror = () => set({ error: "Job event stream disconnected" });
      if (job.variations[0]) {
        await get().selectVariation(jobId, job.variations[0].id);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  selectVariation: async (jobId, variationId) => {
    set({ loading: true, error: null, selectedVariationId: variationId, currentFrame: 0, isPlaying: false, viewerReady: false });
    try {
      const frames = await getMotion(jobId, variationId);
      set({ frames, statusLine: `${frames.length} frames loaded` });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), frames: null });
    } finally {
      set({ loading: false });
    }
  },

  cancelSelectedJob: async () => {
    const selectedJob = get().selectedJob;
    if (!selectedJob) return;
    const job = await cancelJob(selectedJob.jobId);
    set({ selectedJob: job, statusLine: phaseLabel(job) });
    await get().fetchJobs();
  },

  setCurrentFrame: (frame) => set({ currentFrame: frame }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  setSpeed: (speed) => set({ speed }),
  resetCamera: () => set((state) => ({ resetToken: state.resetToken + 1 })),
  setViewerReady: (ready) => set({ viewerReady: ready }),

  loadFixture: async (path) => {
    activeSocket?.close();
    set({ loading: true, error: null, frames: null, currentFrame: 0, selectedVariationId: "fixture" });
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error(response.statusText);
      const frames = (await response.json()) as MotionFrames;
      set({
        frames,
        selectedJob: {
          jobId: "fixture",
          status: "succeeded",
          phase: "succeeded",
          request: {
            prompt: "fixture motion",
            durationSeconds: 4,
            cfgScale: 5,
            variationCount: 1
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: null,
          completedAt: new Date().toISOString(),
          queuePosition: null,
          cancelRequested: false,
          error: null,
          timing: {},
          variations: [{ id: "fixture", index: 0, seed: 0, status: "succeeded", frameCount: frames.length }],
          events: []
        },
        statusLine: `${frames.length} fixture frames loaded`
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), statusLine: "Fixture failed" });
    } finally {
      set({ loading: false });
    }
  }
}));
