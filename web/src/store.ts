import { create } from "zustand";

import { cancelJob, createJob, createJobSocket, getJob, getMotion, listJobs } from "./api";
import type { ComparisonClip, JobDetail, JobEvent, JobRequest, JobSummary, MotionFrames, VariationSummary } from "./types";

let activeSocket: WebSocket | null = null;
let activeSelectionId: string | null = null;
const loadingMotionKeys = new Set<string>();

interface StudioState {
  jobs: JobSummary[];
  selectedJob: JobDetail | null;
  selectedVariationId: string | null;
  detailVariationId: string | null;
  comparisonClips: ComparisonClip[];
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
  loadComparisonVariation: (jobId: string, variation: VariationSummary) => Promise<void>;
  openVariationDetails: (variationId: string) => void;
  closeVariationDetails: () => void;
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

function motionKey(jobId: string, variationId: string): string {
  return `${jobId}:${variationId}`;
}

function clipFromVariation(variation: VariationSummary, frames: MotionFrames): ComparisonClip {
  return {
    variationId: variation.id,
    variationIndex: variation.index,
    seed: variation.seed,
    frames,
    frameCount: frames.length,
    seconds: variation.seconds,
    baseFilename: variation.baseFilename
  };
}

export const useStudioStore = create<StudioState>((set, get) => ({
  jobs: [],
  selectedJob: null,
  selectedVariationId: null,
  detailVariationId: null,
  comparisonClips: [],
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
    await Promise.all(fresh.variations.map((variation) => get().loadComparisonVariation(fresh.jobId, variation)));
  },

  selectJob: async (jobId) => {
    activeSocket?.close();
    activeSelectionId = jobId;
    loadingMotionKeys.clear();
    set({
      loading: true,
      error: null,
      selectedVariationId: null,
      detailVariationId: null,
      comparisonClips: [],
      currentFrame: 0,
      isPlaying: false,
      viewerReady: false
    });
    try {
      const job = await loadJobIntoState(jobId);
      set({ selectedJob: job, statusLine: phaseLabel(job) });
      activeSocket = createJobSocket(jobId);
      activeSocket.onmessage = async (message) => {
        const event = JSON.parse(message.data) as JobEvent;
        if (activeSelectionId !== jobId || get().selectedJob?.jobId !== jobId) return;
        set({ statusLine: event.message ?? phaseLabel(event) });
        const fresh = await loadJobIntoState(jobId);
        if (activeSelectionId !== jobId || get().selectedJob?.jobId !== jobId) return;
        set({ selectedJob: fresh });
        await get().fetchJobs();
        if (event.type === "variation_done" && event.variation?.id) {
          const variation = fresh.variations.find((item) => item.id === event.variation?.id) ?? event.variation;
          await get().loadComparisonVariation(jobId, variation);
        }
      };
      activeSocket.onerror = () => set({ error: "Job event stream disconnected" });
      await Promise.all(job.variations.map((variation) => get().loadComparisonVariation(jobId, variation)));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeSelectionId === jobId) {
        set({ loading: false });
      }
    }
  },

  loadComparisonVariation: async (jobId, variation) => {
    const key = motionKey(jobId, variation.id);
    if (loadingMotionKeys.has(key) || get().comparisonClips.some((clip) => clip.variationId === variation.id)) return;
    loadingMotionKeys.add(key);
    try {
      const frames = await getMotion(jobId, variation.id);
      if (get().selectedJob?.jobId !== jobId) return;
      const clip = clipFromVariation(variation, frames);
      set((state) => {
        const oldTotalFrames = Math.max(0, ...state.comparisonClips.map((item) => item.frames.length));
        const comparisonClips = [
          ...state.comparisonClips.filter((item) => item.variationId !== clip.variationId),
          clip
        ].sort((left, right) => left.variationIndex - right.variationIndex);
        const newTotalFrames = Math.max(0, ...comparisonClips.map((item) => item.frames.length));
        const currentFrame =
          oldTotalFrames > 1 && newTotalFrames > 1
            ? Math.min(
                newTotalFrames - 1,
                Math.round((state.currentFrame / (oldTotalFrames - 1)) * (newTotalFrames - 1))
              )
            : state.currentFrame;
        return {
          comparisonClips,
          currentFrame,
          selectedVariationId: state.selectedVariationId ?? variation.id,
          viewerReady: false
        };
      });
    } catch (error) {
      if (get().selectedJob?.jobId === jobId) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      loadingMotionKeys.delete(key);
    }
  },

  openVariationDetails: (variationId) => set({ selectedVariationId: variationId, detailVariationId: variationId }),
  closeVariationDetails: () => set({ detailVariationId: null }),

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
    activeSelectionId = "fixture";
    loadingMotionKeys.clear();
    set({
      loading: true,
      error: null,
      comparisonClips: [],
      detailVariationId: null,
      currentFrame: 0,
      selectedVariationId: "fixture"
    });
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error(response.statusText);
      const frames = (await response.json()) as MotionFrames;
      const variation: VariationSummary = { id: "fixture", index: 0, seed: 0, status: "succeeded", frameCount: frames.length };
      set({
        comparisonClips: [clipFromVariation(variation, frames)],
        selectedJob: {
          jobId: "fixture",
          status: "succeeded",
          phase: "succeeded",
          request: {
            prompt: "fixture motion",
            durationSeconds: 4,
            cfgScale: 5,
            steps: 50,
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
          variations: [variation],
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
