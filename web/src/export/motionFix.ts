import type { MotionActorFrame, MotionFrame, MotionFrames } from "../types";

export const WOODEN_TEMPLATE_MIN_Y = -1.1610013246536255;

export interface GroundStats {
  restBottomY: number;
  animationMinBottomY: number;
  animationMaxBottomY: number;
  frameCount: number;
  actorCount: number;
}

export function actorForFrame(frame: MotionFrame | undefined): MotionActorFrame | null {
  if (!frame?.length) return null;
  return frame.find((actor) => actor.id === 0) ?? frame[0] ?? null;
}

export function rootTranslation(actor: MotionActorFrame | null): [number, number, number] {
  const th = actor?.Th[0] ?? [0, 0, 0];
  return [th[0] ?? 0, th[1] ?? 0, th[2] ?? 0];
}

export function motionHasMultipleActors(frames: MotionFrames): boolean {
  return frames.some((frame) => frame.length > 1);
}

export function computeGroundStats(frames: MotionFrames, yOffset: number): GroundStats {
  const firstActor = actorForFrame(frames[0]);
  const restRootY = rootTranslation(firstActor)[1];
  const frameBottoms = frames
    .map((frame) => {
      const actor = actorForFrame(frame);
      if (!actor) return null;
      return rootTranslation(actor)[1] + yOffset + WOODEN_TEMPLATE_MIN_Y;
    })
    .filter((value): value is number => value !== null);

  const restBottomY = restRootY + yOffset + WOODEN_TEMPLATE_MIN_Y;
  return {
    restBottomY,
    animationMinBottomY: frameBottoms.length ? Math.min(...frameBottoms) : restBottomY,
    animationMaxBottomY: frameBottoms.length ? Math.max(...frameBottoms) : restBottomY,
    frameCount: frames.length,
    actorCount: Math.max(0, ...frames.map((frame) => frame.length))
  };
}

export function offsetRestToGround(frames: MotionFrames): number {
  return -computeGroundStats(frames, 0).restBottomY;
}

export function offsetAnimationToGround(frames: MotionFrames): number {
  return -computeGroundStats(frames, 0).animationMinBottomY;
}

export function formatMeters(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(3)} m`;
}

export function clipFilenameBase({
  baseFilename,
  variationIndex,
  seed
}: {
  baseFilename?: string | null;
  variationIndex: number;
  seed: number;
}): string {
  const fallback = `hy_motion_v${variationIndex + 1}_seed${seed}`;
  return sanitizeFilenameBase(baseFilename || fallback);
}

export function sanitizeFilenameBase(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return sanitized.slice(0, 120) || "hy_motion_export";
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
