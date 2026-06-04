import {
  CircleStop,
  Copy,
  Dice5,
  Info,
  KeyRound,
  Pause,
  Play,
  RotateCcw,
  Save,
  Send,
  SlidersHorizontal,
  Star,
  Trash2,
  WandSparkles
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";

import { useStudioStore } from "./store";
import type { ComparisonClip, FavoriteSummary } from "./types";
import MotionViewer from "./viewer/MotionViewer";

const CONTROL_HELP = {
  prompt: "Describe the motion you want. Specific body action, direction, and style usually help more than long prose.",
  duration: "Target motion length in seconds. Longer clips use more frames and can require more memory.",
  cfg: "Classifier-free guidance strength. Higher values follow the prompt harder, but can look less natural.",
  steps: "Diffusion/ODE inference steps. More steps can improve quality but each variation takes longer.",
  variationCount: "How many seeded variations to generate for this prompt. They appear together in the viewer as they finish.",
  seeds: "Optional comma-separated seeds. Leave empty for automatic random seeds, or set fixed seeds for repeatable tests."
} as const;

type HelpKey = keyof typeof CONTROL_HELP;
type LeftPanelTab = "generate" | "openrouter";

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

function formatDateTime(value?: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}

function formatSeconds(value?: number | null): string {
  return typeof value === "number" ? `${value.toFixed(2)}s` : "-";
}

function clipTitle(clip: ComparisonClip | FavoriteSummary): string {
  return `V${clip.variationIndex + 1} · seed ${clip.seed}`;
}

function FieldShell({
  label,
  helpKey,
  activeHelp,
  onHelp,
  onReset,
  children
}: {
  label: string;
  helpKey: HelpKey;
  activeHelp: HelpKey | null;
  onHelp: (key: HelpKey | null) => void;
  onReset: () => void;
  children: ReactNode;
}) {
  const open = activeHelp === helpKey;
  return (
    <label className="control-field">
      <span className="field-head">
        <span>{label}</span>
        <span className="field-actions">
          <button
            type="button"
            className="icon-button tiny"
            aria-label={`Reset ${label}`}
            onClick={(event) => {
              event.preventDefault();
              onReset();
            }}
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            className={`icon-button tiny ${open ? "selected" : ""}`}
            aria-label={`${label} info`}
            onClick={(event) => {
              event.preventDefault();
              onHelp(open ? null : helpKey);
            }}
          >
            <Info size={13} />
          </button>
        </span>
      </span>
      {children}
      {open && <span className="help-popover">{CONTROL_HELP[helpKey]}</span>}
    </label>
  );
}

function OpenRouterSettingsPanel() {
  const settings = useStudioStore((state) => state.openRouterSettings);
  const loading = useStudioStore((state) => state.openRouterLoading);
  const saving = useStudioStore((state) => state.openRouterSaving);
  const saveSettings = useStudioStore((state) => state.saveOpenRouterSettings);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");

  useEffect(() => {
    if (!settings) return;
    setModel(settings.model);
    setSystemPrompt(settings.systemPrompt);
  }, [settings]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await saveSettings({
      apiKey: apiKey.trim() || undefined,
      model,
      systemPrompt
    });
    setApiKey("");
  };

  const handleClearKey = async () => {
    await saveSettings({
      clearApiKey: true,
      model,
      systemPrompt
    });
    setApiKey("");
  };

  const handleResetPrompt = () => {
    if (settings) setSystemPrompt(settings.defaultSystemPrompt);
  };

  return (
    <form className="control-form openrouter-form" onSubmit={handleSubmit}>
      <div className="settings-status">
        <KeyRound size={14} />
        <span>{loading ? "Loading settings" : settings?.hasApiKey ? "Key saved" : "No key saved"}</span>
      </div>
      <label>
        <span>API key</span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={settings?.hasApiKey ? "saved key unchanged" : "sk-or-v1-..."}
        />
      </label>
      <label>
        <span>Model</span>
        <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="tencent/hy3-preview" />
      </label>
      <label>
        <span>System prompt</span>
        <textarea
          className="system-prompt-input"
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          rows={14}
        />
      </label>
      <button className="secondary-button" disabled={!settings} type="button" onClick={handleResetPrompt}>
        <RotateCcw size={15} />
        Reset prompt to default
      </button>
      <div className="settings-actions">
        <button className="primary-button" disabled={saving || !model.trim() || !systemPrompt.trim()} type="submit">
          <Save size={16} />
          {saving ? "Saving" : "Save"}
        </button>
        <button
          className="secondary-button danger"
          disabled={saving || !settings?.hasApiKey}
          type="button"
          onClick={() => void handleClearKey()}
        >
          <KeyRound size={15} />
          Clear key
        </button>
      </div>
    </form>
  );
}

function ControlsPanel() {
  const [leftTab, setLeftTab] = useState<LeftPanelTab>("generate");
  const [activeHelp, setActiveHelp] = useState<HelpKey | null>(null);
  const form = useStudioStore((state) => state.generationForm);
  const openRouterSettings = useStudioStore((state) => state.openRouterSettings);
  const updateGenerationForm = useStudioStore((state) => state.updateGenerationForm);
  const resetGenerationFormField = useStudioStore((state) => state.resetGenerationFormField);
  const submitting = useStudioStore((state) => state.submitting);
  const promptEnhancing = useStudioStore((state) => state.promptEnhancing);
  const fetchOpenRouterSettings = useStudioStore((state) => state.fetchOpenRouterSettings);
  const enhanceGenerationPrompt = useStudioStore((state) => state.enhanceGenerationPrompt);
  const submitJob = useStudioStore((state) => state.submitJob);
  const canEnhance =
    Boolean(form.prompt.trim()) && Boolean(openRouterSettings?.hasApiKey) && !promptEnhancing && !submitting;

  useEffect(() => {
    void fetchOpenRouterSettings();
  }, [fetchOpenRouterSettings]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await submitJob({
      prompt: form.prompt,
      durationSeconds: form.durationSeconds,
      cfgScale: form.cfgScale,
      steps: form.steps,
      variationCount: form.variationCount,
      seeds: parseSeeds(form.seeds)
    });
  };

  return (
    <aside className="panel left-panel">
      <div className="panel-title">
        <span>{leftTab === "generate" ? "Generate" : "OpenRouter"}</span>
        {leftTab === "generate" ? <SlidersHorizontal size={16} /> : <KeyRound size={16} />}
      </div>
      <div className="tabs left-tabs">
        <button className={leftTab === "generate" ? "active" : ""} type="button" onClick={() => setLeftTab("generate")}>
          Generate
        </button>
        <button
          className={leftTab === "openrouter" ? "active" : ""}
          type="button"
          onClick={() => setLeftTab("openrouter")}
        >
          OpenRouter
        </button>
      </div>
      {leftTab === "openrouter" ? (
        <OpenRouterSettingsPanel />
      ) : (
        <form className="control-form" onSubmit={handleSubmit}>
          <FieldShell
            label="Motion text"
            helpKey="prompt"
            activeHelp={activeHelp}
            onHelp={setActiveHelp}
            onReset={() => resetGenerationFormField("prompt")}
          >
            <textarea
              value={form.prompt}
              onChange={(event) => updateGenerationForm({ prompt: event.target.value })}
              rows={7}
            />
          </FieldShell>
          <button
            className={`secondary-button enhance-button ${promptEnhancing ? "busy" : ""}`}
            disabled={!canEnhance}
            type="button"
            onClick={() => void enhanceGenerationPrompt()}
          >
            {promptEnhancing ? <span className="spinner" aria-hidden="true" /> : <WandSparkles size={16} />}
            {promptEnhancing ? "Enhancing" : "Enhance prompt and estimate duration"}
          </button>
          {promptEnhancing && (
            <div className="busy-row" role="status" aria-live="polite">
              <span className="spinner small" aria-hidden="true" />
              <span>Waiting for OpenRouter response</span>
            </div>
          )}
          <div className="field-grid">
            <FieldShell
              label="Duration"
              helpKey="duration"
              activeHelp={activeHelp}
              onHelp={setActiveHelp}
              onReset={() => resetGenerationFormField("durationSeconds")}
            >
              <input
                type="number"
                min={0.5}
                max={20}
                step={0.5}
                value={form.durationSeconds}
                onChange={(event) => updateGenerationForm({ durationSeconds: Number(event.target.value) })}
              />
            </FieldShell>
            <FieldShell
              label="CFG"
              helpKey="cfg"
              activeHelp={activeHelp}
              onHelp={setActiveHelp}
              onReset={() => resetGenerationFormField("cfgScale")}
            >
              <div className="range-control">
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={0.5}
                  value={form.cfgScale}
                  onChange={(event) => updateGenerationForm({ cfgScale: Number(event.target.value) })}
                />
                <span className="range-value">{form.cfgScale.toFixed(1)}</span>
              </div>
            </FieldShell>
            <FieldShell
              label="Steps"
              helpKey="steps"
              activeHelp={activeHelp}
              onHelp={setActiveHelp}
              onReset={() => resetGenerationFormField("steps")}
            >
              <div className="range-control">
                <input
                  type="range"
                  min={50}
                  max={200}
                  step={25}
                  value={form.steps}
                  onChange={(event) => updateGenerationForm({ steps: Number(event.target.value) })}
                />
                <span className="range-value">{form.steps}</span>
              </div>
            </FieldShell>
            <FieldShell
              label="Variations"
              helpKey="variationCount"
              activeHelp={activeHelp}
              onHelp={setActiveHelp}
              onReset={() => resetGenerationFormField("variationCount")}
            >
              <div className="range-control">
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={1}
                  value={form.variationCount}
                  onChange={(event) => updateGenerationForm({ variationCount: Number(event.target.value) })}
                />
                <span className="range-value">{form.variationCount}</span>
              </div>
            </FieldShell>
          </div>
          <FieldShell
            label="Seeds"
            helpKey="seeds"
            activeHelp={activeHelp}
            onHelp={setActiveHelp}
            onReset={() => resetGenerationFormField("seeds")}
          >
            <div className="seed-row">
              <input
                value={form.seeds}
                onChange={(event) => updateGenerationForm({ seeds: event.target.value })}
                placeholder="auto"
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => updateGenerationForm({ seeds: randomSeeds(form.variationCount) })}
              >
                <Dice5 size={17} />
              </button>
            </div>
          </FieldShell>
          <button className="primary-button" disabled={submitting || !form.prompt.trim()} type="submit">
            <Send size={17} />
            {submitting ? "Queued" : "Generate"}
          </button>
        </form>
      )}
    </aside>
  );
}

function ViewerWorkspace() {
  const comparisonClips = useStudioStore((state) => state.comparisonClips);
  const currentFrame = useStudioStore((state) => state.currentFrame);
  const isPlaying = useStudioStore((state) => state.isPlaying);
  const speed = useStudioStore((state) => state.speed);
  const resetToken = useStudioStore((state) => state.resetToken);
  const statusLine = useStudioStore((state) => state.statusLine);
  const loading = useStudioStore((state) => state.loading);
  const viewerReady = useStudioStore((state) => state.viewerReady);
  const selectedJob = useStudioStore((state) => state.selectedJob);
  const selectedClipId = useStudioStore((state) => state.selectedClipId);
  const setCurrentFrame = useStudioStore((state) => state.setCurrentFrame);
  const setPlaying = useStudioStore((state) => state.setPlaying);
  const setSpeed = useStudioStore((state) => state.setSpeed);
  const resetCamera = useStudioStore((state) => state.resetCamera);
  const setViewerReady = useStudioStore((state) => state.setViewerReady);
  const selectClip = useStudioStore((state) => state.selectClip);
  const toggleFavorite = useStudioStore((state) => state.toggleFavorite);

  const totalFrames = useMemo(() => Math.max(0, ...comparisonClips.map((clip) => clip.frames.length)), [comparisonClips]);
  const hasClips = comparisonClips.length > 0;
  const expectedCount = selectedJob?.request.variationCount ?? comparisonClips.length;
  const loadedCount = comparisonClips.length;
  const displayFrame = Math.min(currentFrame, Math.max(totalFrames - 1, 0));
  const progress = totalFrames > 1 ? Math.round((displayFrame / (totalFrames - 1)) * 1000) / 10 : 0;

  return (
    <main className="workspace">
      <div className="viewer-shell">
        <MotionViewer
          clips={comparisonClips}
          selectedClipId={selectedClipId}
          currentFrame={displayFrame}
          isPlaying={isPlaying}
          speed={speed}
          resetToken={resetToken}
          onFrameChange={setCurrentFrame}
          onReadyChange={setViewerReady}
          onClipClick={selectClip}
          onFavoriteClick={(clipId) => void toggleFavorite(clipId)}
        />
        {!hasClips && <div className="empty-viewer">{loading ? "Waiting for motion" : "No motion selected"}</div>}
        {hasClips && !viewerReady && <div className="loading-viewer">Loading model</div>}
        <div className="status-strip">
          <span>{statusLine}</span>
          <span>{hasClips ? `${loadedCount}/${expectedCount} loaded · ${displayFrame + 1}/${totalFrames}` : "0/0"}</span>
        </div>
      </div>
      <div className="playback-bar">
        <button className="icon-button" onClick={() => setPlaying(!isPlaying)} disabled={!hasClips}>
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="icon-button" onClick={() => setPlaying(false)} disabled={!hasClips}>
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
          value={displayFrame}
          disabled={!hasClips}
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

function InfoPanel({ clip }: { clip: ComparisonClip | undefined }) {
  const selectedJob = useStudioStore((state) => state.selectedJob);
  const cancelSelectedJob = useStudioStore((state) => state.cancelSelectedJob);
  const toggleFavorite = useStudioStore((state) => state.toggleFavorite);
  const copyClipToGenerationForm = useStudioStore((state) => state.copyClipToGenerationForm);
  const [copiedClipId, setCopiedClipId] = useState<string | null>(null);
  const canCancel = selectedJob?.status === "queued" || selectedJob?.status === "running";

  useEffect(() => {
    setCopiedClipId(null);
  }, [clip?.id]);

  if (!clip) {
    return <div className="quiet-line">Select a generation in the viewer</div>;
  }

  const favorited = Boolean(clip.favoriteId);

  return (
    <div className="info-panel">
      <div className="info-head">
        <div>
          <span>Selected</span>
          <b>{clipTitle(clip)}</b>
        </div>
        <div className="info-actions">
          <button
            className={`icon-button compact ${favorited ? "selected" : ""}`}
            onClick={() => void toggleFavorite(clip.id)}
            aria-label={favorited ? "Remove favorite" : "Favorite generation"}
          >
            <Star size={15} fill={favorited ? "currentColor" : "none"} />
          </button>
          <button className="icon-button compact danger" disabled={!canCancel} onClick={cancelSelectedJob}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <button
        className={`secondary-button ${copiedClipId === clip.id ? "selected" : ""}`}
        type="button"
        onClick={() => {
          copyClipToGenerationForm(clip.id);
          setCopiedClipId(clip.id);
        }}
      >
        <Copy size={15} />
        {copiedClipId === clip.id ? "Copied to controls" : "Copy to controls"}
      </button>
      <div className="modal-section inline-section">
        <span className="section-label">Prompt</span>
        <p className="prompt-full">{clip.prompt}</p>
      </div>
      <div className="metadata-grid modal-grid">
        <span>Source</span>
        <b>{clip.source}</b>
        <span>Status</span>
        <b>{clip.status ?? "-"}</b>
        <span>Seed</span>
        <b>{clip.seed}</b>
        <span>Frames</span>
        <b>{clip.frameCount}</b>
        <span>Generation</span>
        <b>{formatSeconds(clip.seconds)}</b>
        <span>Duration</span>
        <b>{clip.durationSeconds}s</b>
        <span>CFG</span>
        <b>{clip.cfgScale}</b>
        <span>Steps</span>
        <b>{clip.steps}</b>
        <span>Variations</span>
        <b>{clip.variationCount}</b>
        <span>Created</span>
        <b>{formatDateTime(clip.jobCreatedAt)}</b>
        <span>Started</span>
        <b>{formatDateTime(clip.jobStartedAt)}</b>
        <span>Completed</span>
        <b>{formatDateTime(clip.jobCompletedAt)}</b>
        <span>Favorited</span>
        <b>{formatDateTime(clip.favoritedAt)}</b>
        <span>Base file</span>
        <b>{clip.baseFilename ?? "-"}</b>
      </div>
    </div>
  );
}

function StarredPanel() {
  const favorites = useStudioStore((state) => state.favorites);
  const loadFavorite = useStudioStore((state) => state.loadFavorite);
  const deleteFavoriteById = useStudioStore((state) => state.deleteFavoriteById);

  if (!favorites.length) {
    return <div className="quiet-line">No starred generations</div>;
  }

  return (
    <div className="favorite-list">
      {favorites.map((favorite) => (
        <div className="favorite-row" key={favorite.id}>
          <button className="favorite-main" onClick={() => void loadFavorite(favorite.id)}>
            <span>{clipTitle(favorite)}</span>
            <b>{favorite.prompt}</b>
            <small>{formatDateTime(favorite.favoritedAt)}</small>
          </button>
          <button className="icon-button compact danger" onClick={() => void deleteFavoriteById(favorite.id)}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

function RightPanel() {
  const selectedClipId = useStudioStore((state) => state.selectedClipId);
  const comparisonClips = useStudioStore((state) => state.comparisonClips);
  const rightTab = useStudioStore((state) => state.rightTab);
  const setRightTab = useStudioStore((state) => state.setRightTab);
  const error = useStudioStore((state) => state.error);
  const favorites = useStudioStore((state) => state.favorites);
  const selectedClip = comparisonClips.find((clip) => clip.id === selectedClipId);

  return (
    <aside className="panel right-panel">
      <div className="tabs">
        <button className={rightTab === "info" ? "active" : ""} onClick={() => setRightTab("info")}>
          Info
        </button>
        <button className={rightTab === "starred" ? "active" : ""} onClick={() => setRightTab("starred")}>
          Starred <span>{favorites.length}</span>
        </button>
      </div>
      {error && <div className="error-line">{error}</div>}
      {rightTab === "info" ? <InfoPanel clip={selectedClip} /> : <StarredPanel />}
    </aside>
  );
}

export default function App() {
  const fetchFavorites = useStudioStore((state) => state.fetchFavorites);
  const loadFixture = useStudioStore((state) => state.loadFixture);
  const selectedJob = useStudioStore((state) => state.selectedJob);
  const selectedClipId = useStudioStore((state) => state.selectedClipId);
  const comparisonClips = useStudioStore((state) => state.comparisonClips);

  useEffect(() => {
    const fixture = new URLSearchParams(window.location.search).get("fixture");
    void fetchFavorites();
    if (fixture) {
      void loadFixture(fixture);
    }
  }, [fetchFavorites, loadFixture]);

  const activeSummary = useMemo(() => {
    if (selectedJob) return `${selectedJob.status} · ${selectedJob.phase}`;
    const clip = comparisonClips.find((item) => item.id === selectedClipId);
    if (clip?.source === "favorite") return "favorite selected";
    if (clip?.source === "fixture") return "fixture selected";
    return "HY-Motion Studio";
  }, [comparisonClips, selectedClipId, selectedJob]);

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
      <RightPanel />
    </div>
  );
}
