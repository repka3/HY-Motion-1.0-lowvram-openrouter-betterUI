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

export interface VariationSummary {
  id: string;
  index: number;
  seed: number;
  status: JobStatus;
  seconds?: number;
  frameCount?: number;
  baseFilename?: string;
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

export interface ComparisonClip {
  variationId: string;
  variationIndex: number;
  seed: number;
  frames: MotionFrames;
  frameCount: number;
  seconds?: number;
  baseFilename?: string;
}
