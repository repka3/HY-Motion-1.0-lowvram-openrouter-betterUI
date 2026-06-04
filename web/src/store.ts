import { create } from "zustand";

import {
  cancelJob,
  createFavorite,
  createJob,
  createJobSocket,
  deleteFavorite,
  getFavoriteMotion,
  getJob,
  getMotion,
  listFavorites
} from "./api";
import type {
  ComparisonClip,
  FavoriteCreateRequest,
  FavoriteSummary,
  JobDetail,
  JobEvent,
  JobRequest,
  MotionFrames,
  VariationSummary
} from "./types";

let activeSocket: WebSocket | null = null;
let activeSelectionId: string | null = null;
const loadingMotionKeys = new Set<string>();

export type RightPanelTab = "info" | "starred";

interface StudioState {
  selectedJob: JobDetail | null;
  selectedClipId: string | null;
  rightTab: RightPanelTab;
  comparisonClips: ComparisonClip[];
  favorites: FavoriteSummary[];
  currentFrame: number;
  isPlaying: boolean;
  speed: number;
  resetToken: number;
  statusLine: string;
  loading: boolean;
  submitting: boolean;
  viewerReady: boolean;
  error: string | null;
  fetchFavorites: () => Promise<void>;
  submitJob: (request: JobRequest) => Promise<void>;
  refreshSelectedJob: () => Promise<void>;
  selectJob: (jobId: string) => Promise<void>;
  loadComparisonVariation: (jobId: string, variation: VariationSummary) => Promise<void>;
  selectClip: (clipId: string) => void;
  setRightTab: (tab: RightPanelTab) => void;
  toggleFavorite: (clipId: string) => Promise<void>;
  loadFavorite: (favoriteId: string) => Promise<void>;
  deleteFavoriteById: (favoriteId: string) => Promise<void>;
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

function clipIdForJob(jobId: string, variationId: string): string {
  return `${jobId}:${variationId}`;
}

function motionKey(jobId: string, variationId: string): string {
  return `${jobId}:${variationId}`;
}

function matchingFavorite(
  favorites: FavoriteSummary[],
  jobId: string | null | undefined,
  variationId: string,
  seed: number
): FavoriteSummary | undefined {
  return favorites.find(
    (favorite) => favorite.jobId === jobId && favorite.variationId === variationId && favorite.seed === seed
  );
}

function clipFromVariation(
  job: JobDetail,
  variation: VariationSummary,
  frames: MotionFrames,
  favorites: FavoriteSummary[]
): ComparisonClip {
  const favorite = matchingFavorite(favorites, job.jobId, variation.id, variation.seed);
  return {
    id: clipIdForJob(job.jobId, variation.id),
    source: "job",
    jobId: job.jobId,
    favoriteId: favorite?.id ?? null,
    variationId: variation.id,
    variationIndex: variation.index,
    prompt: job.request.prompt,
    durationSeconds: job.request.durationSeconds,
    cfgScale: job.request.cfgScale,
    steps: job.request.steps ?? 50,
    variationCount: job.request.variationCount,
    seed: variation.seed,
    frames,
    frameCount: frames.length,
    seconds: variation.seconds,
    baseFilename: variation.baseFilename,
    status: variation.status,
    jobCreatedAt: job.createdAt,
    jobStartedAt: job.startedAt,
    jobCompletedAt: job.completedAt,
    favoritedAt: favorite?.favoritedAt ?? null
  };
}

function clipFromFavorite(favorite: FavoriteSummary, frames: MotionFrames): ComparisonClip {
  return {
    id: favorite.id,
    source: "favorite",
    jobId: favorite.jobId ?? null,
    favoriteId: favorite.id,
    variationId: favorite.variationId,
    variationIndex: favorite.variationIndex,
    prompt: favorite.prompt,
    durationSeconds: favorite.durationSeconds,
    cfgScale: favorite.cfgScale,
    steps: favorite.steps,
    variationCount: favorite.variationCount,
    seed: favorite.seed,
    frames,
    frameCount: frames.length,
    seconds: favorite.seconds,
    baseFilename: favorite.baseFilename,
    status: "succeeded",
    jobCreatedAt: favorite.jobCreatedAt,
    jobStartedAt: favorite.jobStartedAt,
    jobCompletedAt: favorite.jobCompletedAt,
    favoritedAt: favorite.favoritedAt
  };
}

function favoriteRequestFromClip(clip: ComparisonClip): FavoriteCreateRequest {
  return {
    jobId: clip.jobId ?? null,
    variationId: clip.variationId,
    variationIndex: clip.variationIndex,
    prompt: clip.prompt,
    durationSeconds: clip.durationSeconds,
    cfgScale: clip.cfgScale,
    steps: clip.steps,
    variationCount: clip.variationCount,
    seed: clip.seed,
    seconds: clip.seconds,
    frameCount: clip.frameCount,
    baseFilename: clip.baseFilename,
    jobCreatedAt: clip.jobCreatedAt,
    jobStartedAt: clip.jobStartedAt,
    jobCompletedAt: clip.jobCompletedAt,
    motion: clip.frames
  };
}

async function loadJobIntoState(jobId: string): Promise<JobDetail> {
  return getJob(jobId);
}

export const useStudioStore = create<StudioState>((set, get) => ({
  selectedJob: null,
  selectedClipId: null,
  rightTab: "info",
  comparisonClips: [],
  favorites: [],
  currentFrame: 0,
  isPlaying: false,
  speed: 1,
  resetToken: 0,
  statusLine: "Idle",
  loading: false,
  submitting: false,
  viewerReady: false,
  error: null,

  fetchFavorites: async () => {
    const favorites = await listFavorites();
    set((state) => ({
      favorites,
      comparisonClips: state.comparisonClips.map((clip) => {
        const favorite = matchingFavorite(favorites, clip.jobId, clip.variationId, clip.seed);
        if (!favorite && clip.source !== "favorite") {
          return { ...clip, favoriteId: null, favoritedAt: null };
        }
        return {
          ...clip,
          favoriteId: favorite?.id ?? clip.favoriteId,
          favoritedAt: favorite?.favoritedAt ?? clip.favoritedAt
        };
      })
    }));
  },

  submitJob: async (request) => {
    set({
      submitting: true,
      error: null,
      statusLine: "Submitting",
      selectedJob: null,
      selectedClipId: null,
      comparisonClips: [],
      currentFrame: 0,
      isPlaying: false,
      rightTab: "info"
    });
    try {
      const jobId = await createJob(request);
      await get().selectJob(jobId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), statusLine: "Submit failed" });
    } finally {
      set({ submitting: false });
      await get().fetchFavorites();
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
      selectedClipId: null,
      comparisonClips: [],
      currentFrame: 0,
      isPlaying: false,
      viewerReady: false,
      rightTab: "info"
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
    const clipId = clipIdForJob(jobId, variation.id);
    if (loadingMotionKeys.has(key) || get().comparisonClips.some((clip) => clip.id === clipId)) return;
    loadingMotionKeys.add(key);
    try {
      const selectedJob = get().selectedJob;
      if (!selectedJob || selectedJob.jobId !== jobId) return;
      const frames = await getMotion(jobId, variation.id);
      if (get().selectedJob?.jobId !== jobId) return;
      const freshJob = get().selectedJob ?? selectedJob;
      const clip = clipFromVariation(freshJob, variation, frames, get().favorites);
      set((state) => {
        const oldTotalFrames = Math.max(0, ...state.comparisonClips.map((item) => item.frames.length));
        const comparisonClips = [...state.comparisonClips.filter((item) => item.id !== clip.id), clip].sort(
          (left, right) => left.variationIndex - right.variationIndex
        );
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
          selectedClipId: state.selectedClipId ?? clip.id,
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

  selectClip: (clipId) => set({ selectedClipId: clipId, rightTab: "info" }),
  setRightTab: (tab) => set({ rightTab: tab }),

  toggleFavorite: async (clipId) => {
    const clip = get().comparisonClips.find((item) => item.id === clipId);
    if (!clip) return;
    set({ error: null });
    try {
      if (clip.favoriteId) {
        const favoriteId = clip.favoriteId;
        await deleteFavorite(favoriteId);
        set((state) => ({
          favorites: state.favorites.filter((favorite) => favorite.id !== favoriteId),
          comparisonClips: state.comparisonClips.map((item) =>
            item.favoriteId === favoriteId ? { ...item, favoriteId: null, favoritedAt: null } : item
          )
        }));
        return;
      }

      const favorite = await createFavorite(favoriteRequestFromClip(clip));
      set((state) => ({
        favorites: [favorite, ...state.favorites.filter((item) => item.id !== favorite.id)],
        comparisonClips: state.comparisonClips.map((item) =>
          item.id === clip.id ? { ...item, favoriteId: favorite.id, favoritedAt: favorite.favoritedAt } : item
        )
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  loadFavorite: async (favoriteId) => {
    const favorite = get().favorites.find((item) => item.id === favoriteId);
    if (!favorite) return;
    set({ loading: true, error: null, rightTab: "info" });
    try {
      const frames = await getFavoriteMotion(favoriteId);
      const clip = clipFromFavorite(favorite, frames);
      activeSocket?.close();
      activeSelectionId = null;
      loadingMotionKeys.clear();
      set({
        selectedJob: null,
        comparisonClips: [clip],
        selectedClipId: clip.id,
        currentFrame: 0,
        isPlaying: false,
        viewerReady: false,
        statusLine: `${frames.length} favorite frames loaded`
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  deleteFavoriteById: async (favoriteId) => {
    set({ error: null });
    try {
      await deleteFavorite(favoriteId);
      set((state) => ({
        favorites: state.favorites.filter((favorite) => favorite.id !== favoriteId),
        comparisonClips: state.comparisonClips.map((clip) =>
          clip.favoriteId === favoriteId ? { ...clip, favoriteId: null, favoritedAt: null } : clip
        )
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  cancelSelectedJob: async () => {
    const selectedJob = get().selectedJob;
    if (!selectedJob) return;
    const job = await cancelJob(selectedJob.jobId);
    set({ selectedJob: job, statusLine: phaseLabel(job) });
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
      currentFrame: 0,
      selectedClipId: "fixture",
      rightTab: "info"
    });
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error(response.statusText);
      const frames = (await response.json()) as MotionFrames;
      set({
        comparisonClips: [
          {
            id: "fixture",
            source: "fixture",
            jobId: "fixture",
            favoriteId: null,
            variationId: "fixture",
            variationIndex: 0,
            prompt: "fixture motion",
            durationSeconds: 4,
            cfgScale: 5,
            steps: 50,
            variationCount: 1,
            seed: 0,
            frames,
            frameCount: frames.length,
            status: "succeeded",
            jobCreatedAt: new Date().toISOString(),
            jobStartedAt: null,
            jobCompletedAt: new Date().toISOString(),
            favoritedAt: null
          }
        ],
        selectedJob: null,
        statusLine: `${frames.length} fixture frames loaded`
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), statusLine: "Fixture failed" });
    } finally {
      set({ loading: false });
    }
  }
}));
