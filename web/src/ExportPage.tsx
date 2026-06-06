import { ArrowLeft, Box, Download, GitBranch, MoveVertical, Pause, Play, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { exportFbx } from "./api";
import { exportClipToGlb } from "./export/glbExporter";
import {
  clipFilenameBase,
  computeGroundStats,
  downloadBlob,
  formatMeters,
  motionHasMultipleActors,
  offsetAnimationToGround,
  offsetRestToGround
} from "./export/motionFix";
import { useStudioStore } from "./store";
import type { ComparisonClip, ExportFormat } from "./types";
import MotionViewer from "./viewer/MotionViewer";

const EXPORT_FPS = 30;

type PoseMode = "animation" | "rest";

function titleForClip(clip: ComparisonClip): string {
  return `V${clip.variationIndex + 1} · seed ${clip.seed}`;
}

function exportLabel(format: ExportFormat, includeSkin: boolean): string {
  return `${format.toUpperCase()} ${includeSkin ? "with skin" : "without skin"}`;
}

export default function ExportPage({ onBack }: { onBack: () => void }) {
  const selectedClipId = useStudioStore((state) => state.selectedClipId);
  const comparisonClips = useStudioStore((state) => state.comparisonClips);
  const resetToken = useStudioStore((state) => state.resetToken);
  const [poseMode, setPoseMode] = useState<PoseMode>("animation");
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [viewerReady, setViewerReady] = useState(false);
  const [yOffset, setYOffset] = useState(0);
  const [exporting, setExporting] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clip = comparisonClips.find((item) => item.id === selectedClipId);

  const singleClip = useMemo(() => (clip ? [{ ...clip }] : []), [clip]);
  const totalFrames = clip?.frames.length ?? 0;
  const displayFrame = Math.min(currentFrame, Math.max(totalFrames - 1, 0));
  const progress = totalFrames > 1 ? Math.round((displayFrame / (totalFrames - 1)) * 1000) / 10 : 0;
  const groundStats = useMemo(() => (clip ? computeGroundStats(clip.frames, yOffset) : null), [clip, yOffset]);
  const hasMultipleActors = clip ? motionHasMultipleActors(clip.frames) : false;

  async function handleExport(format: ExportFormat, includeSkin: boolean) {
    if (!clip) return;
    const label = exportLabel(format, includeSkin);
    setExporting(label);
    setError(null);
    setStatus(null);
    try {
      const filenameBase = clipFilenameBase(clip);
      const blob =
        format === "glb"
          ? await exportClipToGlb(clip, { includeSkin, yOffset, fps: EXPORT_FPS })
          : await exportFbx({
              motion: clip.frames,
              includeSkin,
              yOffset,
              fps: EXPORT_FPS,
              filenameBase
            });
      downloadBlob(blob, `${filenameBase}_${includeSkin ? "skin" : "skeleton"}.${format}`);
      setStatus(`${label} ready`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(null);
    }
  }

  if (!clip) {
    return (
      <div className="export-shell empty-export">
        <div className="export-topbar">
          <button className="secondary-button export-back" type="button" onClick={onBack}>
            <ArrowLeft size={16} />
            Back to studio
          </button>
        </div>
        <div className="empty-export-message">No animation selected</div>
      </div>
    );
  }

  return (
    <div className="export-shell">
      <header className="export-topbar">
        <button className="secondary-button export-back" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          Back to studio
        </button>
        <div className="export-title">
          <span>Export</span>
          <b>{titleForClip(clip)}</b>
        </div>
        <div className="export-mode-tabs" role="tablist" aria-label="Preview mode">
          <button className={poseMode === "animation" ? "active" : ""} type="button" onClick={() => setPoseMode("animation")}>
            Animation
          </button>
          <button className={poseMode === "rest" ? "active" : ""} type="button" onClick={() => setPoseMode("rest")}>
            Rest pose
          </button>
        </div>
      </header>

      <main className="export-main">
        <section className="export-preview">
          <div className="viewer-shell export-viewer-shell">
            <MotionViewer
              clips={singleClip}
              selectedClipId={clip.id}
              currentFrame={displayFrame}
              isPlaying={poseMode === "animation" && isPlaying}
              speed={speed}
              resetToken={resetToken}
              poseMode={poseMode}
              yOffset={yOffset}
              showFavoriteButtons={false}
              onFrameChange={setCurrentFrame}
              onReadyChange={setViewerReady}
            />
            {!viewerReady && <div className="loading-viewer">Loading model</div>}
            <div className="status-strip">
              <span>{poseMode === "rest" ? "Rest pose" : "Animation preview"}</span>
              <span>{poseMode === "animation" ? `${displayFrame + 1}/${totalFrames}` : formatMeters(yOffset)}</span>
            </div>
          </div>
          <div className="playback-bar export-playback">
            <button
              className="icon-button"
              onClick={() => setPlaying(!isPlaying)}
              disabled={poseMode !== "animation" || totalFrames < 2}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <input
              className="timeline"
              type="range"
              min={0}
              max={Math.max(totalFrames - 1, 0)}
              value={displayFrame}
              disabled={poseMode !== "animation" || totalFrames < 2}
              onChange={(event) => setCurrentFrame(Number(event.target.value))}
            />
            <span className="frame-percent">{progress.toFixed(1)}%</span>
            <input
              className="speed-slider"
              type="range"
              min={0.25}
              max={2}
              step={0.25}
              value={speed}
              disabled={poseMode !== "animation"}
              onChange={(event) => setSpeed(Number(event.target.value))}
            />
            <span className="speed-label">{speed.toFixed(2)}x</span>
          </div>
        </section>

        <aside className="panel export-panel">
          <div className="export-section">
            <div className="panel-title">
              <span>Ground fix</span>
              <MoveVertical size={16} />
            </div>
            <label>
              <span>Y offset</span>
              <div className="range-control export-offset-control">
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.01}
                  value={yOffset}
                  onChange={(event) => setYOffset(Number(event.target.value))}
                />
                <input
                  type="number"
                  min={-10}
                  max={10}
                  step={0.01}
                  value={Number(yOffset.toFixed(3))}
                  onChange={(event) => setYOffset(Number(event.target.value))}
                />
              </div>
            </label>
            <div className="export-action-row">
              <button className="secondary-button" type="button" onClick={() => setYOffset(offsetRestToGround(clip.frames))}>
                Rest to ground
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setYOffset(offsetAnimationToGround(clip.frames))}
              >
                Animation to ground
              </button>
            </div>
            <button className="secondary-button" type="button" onClick={() => setYOffset(0)}>
              <RotateCcw size={15} />
              Reset offset
            </button>
            {groundStats && (
              <div className="metadata-grid modal-grid export-measurements">
                <span>Rest bottom</span>
                <b>{formatMeters(groundStats.restBottomY)}</b>
                <span>Animation low</span>
                <b>{formatMeters(groundStats.animationMinBottomY)}</b>
                <span>Animation high</span>
                <b>{formatMeters(groundStats.animationMaxBottomY)}</b>
                <span>Frames</span>
                <b>{groundStats.frameCount}</b>
              </div>
            )}
          </div>

          <div className="export-section">
            <div className="panel-title">
              <span>Download</span>
              <Download size={16} />
            </div>
            <div className="export-grid">
              <button className="secondary-button" disabled={Boolean(exporting)} type="button" onClick={() => void handleExport("fbx", true)}>
                <Box size={15} />
                FBX skin
              </button>
              <button className="secondary-button" disabled={Boolean(exporting)} type="button" onClick={() => void handleExport("fbx", false)}>
                <GitBranch size={15} />
                FBX skeleton
              </button>
              <button className="secondary-button" disabled={Boolean(exporting)} type="button" onClick={() => void handleExport("glb", true)}>
                <Box size={15} />
                GLB skin
              </button>
              <button className="secondary-button" disabled={Boolean(exporting)} type="button" onClick={() => void handleExport("glb", false)}>
                <GitBranch size={15} />
                GLB skeleton
              </button>
            </div>
            {exporting && (
              <div className="busy-row" role="status" aria-live="polite">
                <span className="spinner small" aria-hidden="true" />
                <span>Exporting {exporting}</span>
              </div>
            )}
            {status && <div className="quiet-line">{status}</div>}
            {error && <div className="error-line">{error}</div>}
            {hasMultipleActors && <div className="quiet-line">Only actor 0 will be exported</div>}
          </div>

          <div className="export-section">
            <div className="metadata-grid modal-grid">
              <span>Source</span>
              <b>{clip.source}</b>
              <span>Seed</span>
              <b>{clip.seed}</b>
              <span>FPS</span>
              <b>{EXPORT_FPS}</b>
              <span>File base</span>
              <b>{clipFilenameBase(clip)}</b>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
