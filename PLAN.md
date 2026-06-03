# Better UI Stack Plan

## Summary

Replace the current Gradio-first workflow with a proper local creator-studio app:

- Frontend: React + Vite + TypeScript + React Three Fiber.
- Backend: FastAPI with a single local GPU job queue.
- Renderer: rewrite the current three.js iframe viewer as first-class React/Three code.
- Runtime: keep the validated low-VRAM strategy: encode text once, unload text encoders, load full HY-Motion, generate variations from cached hidden states.
- V1 exports: no export UI yet. Focus on prompt, history, generation progress, and 3D viewing.

## Key Decisions

- Do not build the real UI in Gradio. Keep Gradio only as a validation/demo harness.
- Use a single local GPU queue for v1. No concurrent GPU jobs.
- Generate multiple variations sequentially by default, because real batch generation fits but does not meaningfully improve timing on the 8GB test GPU.
- Reuse the existing low-VRAM runtime behavior but expose it through a clean backend service instead of Gradio.
- Rewrite the viewer now with React Three Fiber, not an iframe migration.
- No prompt rewriting, duration estimation, FBX export, auth, or multi-user scheduling in v1.

## Implementation Changes

### Frontend

Create a Vite React TypeScript app in `web/`.

Core dependencies:

- `react`
- `vite`
- `typescript`
- `three`
- `@react-three/fiber`
- `@react-three/drei`
- `zustand`
- `lucide-react`

UI structure:

- Left panel: prompt, duration, CFG, variation count, seed controls, generate button.
- Main workspace: full 3D viewer canvas with playback controls.
- Right or lower panel: job history and variation list.
- Status area: current queue state, text encoding phase, model loading phase, generation progress per variation.

Viewer behavior:

- Load motion frame JSON from backend.
- Render the wooden character with React Three Fiber.
- Support play/pause, scrub timeline, camera orbit, reset camera, variation switching.
- Use the existing motion frame schema from the current static viewer: per-frame SMPL-like objects containing `Rh`, `Th`, `poses`, `shapes`, and `gender`.

### Backend

Add a FastAPI backend under `hymotion/api/`.

Core dependencies to make explicit in `requirements.txt`:

- `fastapi`
- `uvicorn`
- `websockets`

Runtime behavior:

1. One worker processes one generation job at a time.
2. Each job unloads HY-Motion if currently resident.
3. Load Qwen/CLIP with CPU/GPU offload.
4. Encode prompt once.
5. Move hidden states to CPU.
6. Unload text encoders and clear CUDA.
7. Load full `HY-Motion-1.0/latest.ckpt`.
8. Generate each variation sequentially from cached hidden states.
9. Store frontend-readable motion JSON and job metadata.

Default low-VRAM settings:

- `HY_QWEN_DEVICE_MAP=auto`
- `HY_QWEN_MAX_GPU_MEMORY=5GiB`
- `HY_QWEN_MAX_CPU_MEMORY=48GiB`
- `HY_TEXT_LOCAL_FILES_ONLY=1`
- Full model path: `ckpts/tencent/HY-Motion-1.0`

### API Shape

REST:

- `POST /api/jobs`
  - Body: `prompt`, `durationSeconds`, `cfgScale`, `variationCount`, optional `seeds`.
  - Defaults: `durationSeconds=4`, `cfgScale=5`, `variationCount=4`.
  - Returns: `jobId`.

- `GET /api/jobs`
  - Returns recent job history.

- `GET /api/jobs/{jobId}`
  - Returns job status, request settings, timing, variation metadata.

- `GET /api/jobs/{jobId}/variations/{variationId}/motion`
  - Returns motion frame JSON for the viewer.

- `DELETE /api/jobs/{jobId}`
  - Cancels queued jobs.
  - For running jobs, cancellation is checked between major phases and between seed generations.

WebSocket:

- `WS /api/jobs/{jobId}/events`
  - Emits phase/status events:
    - `queued`
    - `text_encoder_loading`
    - `text_encoding`
    - `text_encoder_unloading`
    - `motion_loading`
    - `generating`
    - `variation_done`
    - `succeeded`
    - `failed`
    - `cancelled`

## Test Plan

Backend:

- Unit test job state transitions and seed generation.
- Unit test cancellation for queued jobs and between variations.
- Integration test one full 4-variation run with the validated prompt and assert:
  - text encoder runs once
  - four variations are created
  - motion JSON is readable
  - no Gradio dependency is used
  - peak VRAM stays within the validated low-VRAM envelope

Frontend:

- Mock backend API and verify:
  - prompt submission creates a job
  - WebSocket events update progress
  - generated variations appear in history
  - selecting a variation loads the viewer
- Playwright test that the React Three Fiber canvas renders nonblank pixels with fixture motion JSON.
- Manual GPU acceptance test:
  - prompt: `a female person kneeling down from a standing position in a feminine fashion`
  - duration: `4.0`
  - CFG: `5.0`
  - variations: `4`
  - expected: all four variations generated and viewable on an 8GB GPU.

## Assumptions

- V1 is a local single-user creator studio.
- V1 viewer only; no export UI yet.
- Internally stored artifacts are acceptable, but the UI should not expose NPZ/FBX downloads yet.
- The full model remains `HY-Motion-1.0`, not Lite.
- The validated precision remains unchanged: HY-Motion FP32, Qwen BF16, CLIP FP32, no quantization.
- Gradio remains available for testing but is not the target production UI.

## References

- FastAPI WebSockets: https://fastapi.tiangolo.com/advanced/websockets/
- FastAPI Background Tasks: https://fastapi.tiangolo.com/tutorial/background-tasks/
- Vite Guide: https://vite.dev/guide/
- React TypeScript docs: https://react.dev/learn/typescript
- three.js docs: https://threejs.org/docs/
- Gradio docs: https://www.gradio.app/docs
