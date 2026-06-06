export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobPhase =
  | "queued"
  | "text_encoder_loading"
  | "text_encoding"
  | "text_encoder_unloading"
  | "motion_loading"
  | "generating"
  | "variation_done"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface JobRequest {
  prompt: string;
  durationSeconds: number;
  cfgScale: number;
  steps?: number;
  variationCount: number;
  seeds?: number[];
}

export interface GenerationFormValues {
  prompt: string;
  durationSeconds: number;
  cfgScale: number;
  steps: number;
  variationCount: number;
  seeds: string;
}

export interface OpenRouterSettings {
  hasApiKey: boolean;
  model: string;
  systemPrompt: string;
  defaultSystemPrompt: string;
}

export interface OpenRouterSettingsUpdate {
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
  clearApiKey?: boolean;
}

export interface PromptEnhanceRequest {
  prompt: string;
}

export interface PromptEnhanceResponse {
  prompt: string;
  durationSeconds: number;
  model: string;
}

export interface VariationSummary {
  id: string;
  index: number;
  seed: number;
  status: JobStatus;
  seconds?: number;
  frameCount?: number;
  baseFilename?: string;
}

export interface FavoriteSummary {
  id: string;
  favoritedAt: string;
  jobId?: string | null;
  variationId: string;
  variationIndex: number;
  prompt: string;
  durationSeconds: number;
  cfgScale: number;
  steps: number;
  variationCount: number;
  seed: number;
  seconds?: number | null;
  frameCount?: number | null;
  baseFilename?: string | null;
  jobCreatedAt?: string | null;
  jobStartedAt?: string | null;
  jobCompletedAt?: string | null;
}

export interface FavoriteCreateRequest {
  jobId?: string | null;
  variationId: string;
  variationIndex: number;
  prompt: string;
  durationSeconds: number;
  cfgScale: number;
  steps: number;
  variationCount: number;
  seed: number;
  seconds?: number | null;
  frameCount?: number | null;
  baseFilename?: string | null;
  jobCreatedAt?: string | null;
  jobStartedAt?: string | null;
  jobCompletedAt?: string | null;
  motion: MotionFrames;
}

export interface JobSummary {
  jobId: string;
  status: JobStatus;
  phase: JobPhase;
  request: JobRequest;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  queuePosition?: number | null;
  cancelRequested: boolean;
  error?: string | null;
  timing: Record<string, number>;
  variations: VariationSummary[];
}

export interface JobDetail extends JobSummary {
  events: JobEvent[];
}

export interface JobEvent {
  type: JobPhase;
  jobId: string;
  timestamp: string;
  status?: JobStatus;
  variationId?: string;
  variationIndex?: number;
  seed?: number;
  message?: string;
  variation?: VariationSummary;
}

export interface MotionActorFrame {
  id: number;
  gender: string;
  Rh: number[][];
  Th: number[][];
  poses: number[][];
  shapes: number[][];
}

export type MotionFrame = MotionActorFrame[];
export type MotionFrames = MotionFrame[];

export type ExportFormat = "fbx" | "glb";
export type ExportSkinMode = "with_skin" | "without_skin";

export interface ExportFixSettings {
  yOffset: number;
  fps: number;
}

export interface ExportFbxRequest {
  motion: MotionFrames;
  includeSkin: boolean;
  yOffset: number;
  fps: number;
  filenameBase: string;
}

export interface ComparisonClip {
  id: string;
  source: "job" | "favorite" | "fixture";
  jobId?: string | null;
  favoriteId?: string | null;
  variationId: string;
  variationIndex: number;
  prompt: string;
  durationSeconds: number;
  cfgScale: number;
  steps: number;
  variationCount: number;
  seed: number;
  frames: MotionFrames;
  frameCount: number;
  seconds?: number | null;
  baseFilename?: string | null;
  status?: JobStatus;
  jobCreatedAt?: string | null;
  jobStartedAt?: string | null;
  jobCompletedAt?: string | null;
  favoritedAt?: string | null;
}
