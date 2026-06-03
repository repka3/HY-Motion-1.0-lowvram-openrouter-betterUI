import {
  CircleStop,
  Dice5,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Trash2
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { useStudioStore } from "./store";
import MotionViewer from "./viewer/MotionViewer";

const DEFAULT_PROMPT = "a female person kneeling down from a standing position in a feminine fashion";

function parseSeeds(value: string): number[] | undefined {
  const seeds = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0);
  return seeds.length ? seeds : undefined;
}

function randomSeeds(count: number): string {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 1_000_000_000)).join(", ");
}

function formatTime(value?: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function phaseClass(phase: string): string {
  if (phase === "succeeded") return "good";
  if (phase === "failed" || phase === "cancelled") return "bad";
  if (phase === "queued") return "muted";
  return "active";
}

function ControlsPanel() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [duration, setDuration] = useState(4);
  const [cfg, setCfg] = useState(5);
  const [variationCount, setVariationCount] = useState(4);
  const [seeds, setSeeds] = useState("");
  const submitting = useStudioStore((state) => state.submitting);
  const submitJob = useStudioStore((state) => state.submitJob);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await submitJob({
      prompt,
      durationSeconds: duration,
      cfgScale: cfg,
      variationCount,
      seeds: parseSeeds(seeds)
    });
  };

  return (
    <aside className="panel left-panel">
      <div className="panel-title">
        <span>Prompt</span>
        <SlidersHorizontal size={16} />
      </div>
      <form className="control-form" onSubmit={handleSubmit}>
        <label>
          <span>Motion text</span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} />
        </label>
        <div className="field-grid">
          <label>
            <span>Duration</span>
            <input
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
            />
          </label>
          <label>
            <span>CFG</span>
            <input
              type="number"
              min={1}
              max={20}
              step={0.5}
              value={cfg}
              onChange={(event) => setCfg(Number(event.target.value))}
            />
          </label>
        </div>
        <label>
          <span>Variations</span>
          <input
            type="number"
            min={1}
            max={16}
            value={variationCount}
            onChange={(event) => setVariationCount(Number(event.target.value))}
          />
        </label>
        <label>
          <span>Seeds</span>
          <div className="seed-row">
            <input value={seeds} onChange={(event) => setSeeds(event.target.value)} placeholder="auto" />
            <button type="button" className="icon-button" onClick={() => setSeeds(randomSeeds(variationCount))}>
              <Dice5 size={17} />
            </button>
          </div>
        </label>
        <button className="primary-button" disabled={submitting || !prompt.trim()} type="submit">
          <Send size={17} />
          {submitting ? "Queued" : "Generate"}
        </button>
      </form>
    </aside>
  );
}

function ViewerWorkspace() {
  const frames = useStudioStore((state) => state.frames);
  const currentFrame = useStudioStore((state) => state.currentFrame);
  const isPlaying = useStudioStore((state) => state.isPlaying);
  const speed = useStudioStore((state) => state.speed);
  const resetToken = useStudioStore((state) => state.resetToken);
  const statusLine = useStudioStore((state) => state.statusLine);
  const loading = useStudioStore((state) => state.loading);
  const viewerReady = useStudioStore((state) => state.viewerReady);
  const setCurrentFrame = useStudioStore((state) => state.setCurrentFrame);
  const setPlaying = useStudioStore((state) => state.setPlaying);
  const setSpeed = useStudioStore((state) => state.setSpeed);
  const resetCamera = useStudioStore((state) => state.resetCamera);
  const setViewerReady = useStudioStore((state) => state.setViewerReady);

  const totalFrames = frames?.length ?? 0;
  const progress = totalFrames > 1 ? Math.round((currentFrame / (totalFrames - 1)) * 1000) / 10 : 0;

  return (
    <main className="workspace">
      <div className="viewer-shell">
        <MotionViewer
          frames={frames}
          currentFrame={Math.min(currentFrame, Math.max(totalFrames - 1, 0))}
          isPlaying={isPlaying}
          speed={speed}
          resetToken={resetToken}
          onFrameChange={setCurrentFrame}
          onReadyChange={setViewerReady}
        />
        {!frames && <div className="empty-viewer">No motion selected</div>}
        {frames && (!viewerReady || loading) && <div className="loading-viewer">Loading model</div>}
        <div className="status-strip">
          <span>{statusLine}</span>
          <span>{totalFrames ? `${currentFrame + 1}/${totalFrames}` : "0/0"}</span>
        </div>
      </div>
      <div className="playback-bar">
        <button className="icon-button" onClick={() => setPlaying(!isPlaying)} disabled={!frames}>
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="icon-button" onClick={() => setPlaying(false)} disabled={!frames}>
          <CircleStop size={18} />
        </button>
        <button className="icon-button" onClick={resetCamera}>
          <RotateCcw size={18} />
        </button>
        <input
          className="timeline"
          type="range"
          min={0}
          max={Math.max(totalFrames - 1, 0)}
          value={Math.min(currentFrame, Math.max(totalFrames - 1, 0))}
          disabled={!frames}
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
          onChange={(event) => setSpeed(Number(event.target.value))}
        />
        <span className="speed-label">{speed.toFixed(2)}x</span>
      </div>
    </main>
  );
}

function HistoryPanel() {
  const jobs = useStudioStore((state) => state.jobs);
  const selectedJob = useStudioStore((state) => state.selectedJob);
  const selectedVariationId = useStudioStore((state) => state.selectedVariationId);
  const fetchJobs = useStudioStore((state) => state.fetchJobs);
  const selectJob = useStudioStore((state) => state.selectJob);
  const selectVariation = useStudioStore((state) => state.selectVariation);
  const cancelSelectedJob = useStudioStore((state) => state.cancelSelectedJob);
  const error = useStudioStore((state) => state.error);

  const canCancel = selectedJob?.status === "queued" || selectedJob?.status === "running";
  const selectedPrompt = selectedJob?.request.prompt ?? "";

  return (
    <aside className="panel right-panel">
      <div className="panel-title">
        <span>Jobs</span>
        <button className="icon-button compact" onClick={fetchJobs}>
          <RefreshCw size={15} />
        </button>
      </div>
      {error && <div className="error-line">{error}</div>}
      <div className="job-list">
        {jobs.map((job) => (
          <button
            key={job.jobId}
            className={`job-row ${selectedJob?.jobId === job.jobId ? "selected" : ""}`}
            onClick={() => selectJob(job.jobId)}
          >
            <span className={`dot ${phaseClass(job.phase)}`} />
            <span className="job-text">{job.request.prompt}</span>
            <span className="job-time">{formatTime(job.createdAt)}</span>
          </button>
        ))}
        {!jobs.length && <div className="quiet-line">No jobs yet</div>}
      </div>
      <div className="detail-block">
        <div className="detail-head">
          <span>Selected</span>
          <button className="icon-button compact danger" disabled={!canCancel} onClick={cancelSelectedJob}>
            <Trash2 size={15} />
          </button>
        </div>
        {selectedJob ? (
          <>
            <p className="selected-prompt">{selectedPrompt}</p>
            <div className="metadata-grid">
              <span>Status</span>
              <b>{selectedJob.status}</b>
              <span>Duration</span>
              <b>{selectedJob.request.durationSeconds}s</b>
              <span>CFG</span>
              <b>{selectedJob.request.cfgScale}</b>
              <span>Queue</span>
              <b>{selectedJob.queuePosition ?? "-"}</b>
            </div>
            <div className="variation-list">
              {selectedJob.variations.map((variation) => (
                <button
                  key={variation.id}
                  className={`variation-row ${selectedVariationId === variation.id ? "selected" : ""}`}
                  onClick={() => selectVariation(selectedJob.jobId, variation.id)}
                >
                  <span>V{variation.index + 1}</span>
                  <b>{variation.seed}</b>
                  <span>{variation.frameCount ? `${variation.frameCount}f` : "-"}</span>
                </button>
              ))}
              {!selectedJob.variations.length && <div className="quiet-line">Waiting for variations</div>}
            </div>
          </>
        ) : (
          <div className="quiet-line">No job selected</div>
        )}
      </div>
    </aside>
  );
}

export default function App() {
  const fetchJobs = useStudioStore((state) => state.fetchJobs);
  const selectJob = useStudioStore((state) => state.selectJob);
  const loadFixture = useStudioStore((state) => state.loadFixture);
  const jobs = useStudioStore((state) => state.jobs);
  const selectedJob = useStudioStore((state) => state.selectedJob);

  useEffect(() => {
    const fixture = new URLSearchParams(window.location.search).get("fixture");
    if (fixture) {
      void loadFixture(fixture);
      return;
    }
    void fetchJobs();
  }, [fetchJobs, loadFixture]);

  useEffect(() => {
    if (selectedJob?.jobId === "fixture") return;
    if (!selectedJob && jobs[0]) {
      void selectJob(jobs[0].jobId);
    }
  }, [jobs, selectJob, selectedJob]);

  const activeSummary = useMemo(() => {
    if (!selectedJob) return "HY-Motion Studio";
    return `${selectedJob.status} · ${selectedJob.phase}`;
  }, [selectedJob]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>HY-Motion Studio</h1>
          <span>{activeSummary}</span>
        </div>
      </header>
      <ControlsPanel />
      <ViewerWorkspace />
      <HistoryPanel />
    </div>
  );
}
