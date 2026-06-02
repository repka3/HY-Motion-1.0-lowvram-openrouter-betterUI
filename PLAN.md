# HY-Motion Low-VRAM / OpenRouter / Better UI Plan

## Purpose

This fork exists to turn Tencent's HY-Motion demo repo into a practical motion-generation workspace.

The original project is useful, but it is mostly a single-shot Gradio demo: enter prompt, choose duration/seed/CFG, generate, preview, export. The goal of this fork is to investigate whether we can make HY-Motion more usable for real animation workflows while keeping the expensive local compute as small as possible.

Main goals:

- Run the full HY-Motion model with lower VRAM pressure where possible.
- Replace the optional local prompt-rewrite/duration LLM with a remote LLM provider such as OpenRouter.
- Expose better generation controls than the stock Gradio UI.
- Save generation metadata and raw motion data so clips can be managed, compared, and exported cleanly.
- Build toward a better UI only after the low-VRAM feasibility is measured.

This fork is for experiments first, product UI second.

## Current Understanding

HY-Motion has three different model roles that are easy to confuse:

1. **Motion generation model**
   - The actual HY-Motion DiT / flow-matching motion model.
   - Full checkpoint folder is about 3.9 GiB on disk.
   - Lite checkpoint folder is about 1.7 GiB on disk.
   - Runtime VRAM is higher than file size.

2. **Required text encoders**
   - HY-Motion's normal text-conditioned generation needs CLIP and Qwen hidden states.
   - Code path: `hymotion/network/text_encoders/text_encoder.py`.
   - Uses `openai/clip-vit-large-patch14` and `Qwen/Qwen3-8B`.
   - Qwen is not being used as a chat assistant here; HY-Motion consumes its hidden states.
   - OpenRouter cannot directly replace this because chat APIs return text, not hidden states.

3. **Optional prompt engineering model**
   - `Text2MotionPrompter/Text2MotionPrompter`.
   - Used only for prompt rewriting and duration prediction.
   - Around 56.9 GiB on disk.
   - This is optional and can be disabled with `DISABLE_PROMPT_ENGINEERING=True`.
   - It can likely be replaced by OpenRouter/OpenAI/etc. because the code only asks for JSON with duration and a rewritten caption.

Important implication:

```text
OpenRouter can replace Text2MotionPrompter.
OpenRouter cannot directly replace Qwen3-8B text encoding.
```

## What Is Missing From Tencent's Gradio

The stock Gradio UI is enough for simple one-off generation, but it is not a take-generation workspace.

Useful improvements:

- Deterministic seed control and seed history.
- Batch generation across prompts/seeds/CFG values.
- Take management: favorite, reject, rename, compare, annotate.
- Metadata per output: original prompt, rewritten prompt, seed, CFG, duration, model, validation steps, timestamp.
- More inference controls: validation steps, exact frame count, smoothing on/off, model selection, output format.
- Raw data export: `rot6d`, `transl`, `keypoints3d`, `latent_denorm`, not only FBX/HTML.
- Blender-friendly naming and folder layout.
- Three.js preview and take browser, if/when backend feasibility is known.

Stitching and detailed animation editing should be handled in Blender, not in this UI. This UI should generate, organize, preview, and export clean motion takes.

## Model Control Notes

The lowest useful HY-Motion call is `MotionFlowMatching.generate(...)` in `hymotion/pipeline/motion_diffusion.py`.

Below that is the raw transformer call:

```python
motion_transformer(
    x=x_input,
    ctxt_input=ctxt_input,
    vtxt_input=vtxt_input,
    timesteps=t.expand(x_input.shape[0]),
    x_mask_temporal=x_mask_temporal,
    ctxt_mask_temporal=ctxt_mask_temporal,
)
```

The raw call is useful for sampler experiments, but too low-level for the first UI/backend.

Practical controllable parameters:

- `seed_input`
- `duration_slider`
- exact `length` in frames
- `cfg_scale`
- `validation_steps`
- ODE scheduler config
- smoothing on/off during decode
- prompt rewrite source
- output format and raw data persistence

The stock CLI hides some controls. For example, the CLI has `--num_seeds`, but it generates random seeds internally. Gradio and the runtime already support explicit seed lists.

## Low-VRAM Questions To Answer First

Before building a large UI, measure these facts:

1. Can `Qwen/Qwen3-8B` load and encode on an 8 GB card?
2. Can Qwen be loaded in 4-bit or with CPU offload and still produce compatible hidden states?
3. Can we encode text, cache hidden states, unload Qwen/CLIP, then load/generate with the HY-Motion model?
4. Can the full HY-Motion model run on 8 GB or 12 GB if the text encoder is unloaded before generation?
5. What is the true peak VRAM for:
   - Qwen only
   - CLIP only
   - Qwen + CLIP
   - HY-Motion full only
   - text encoding followed by generation with model unloading
6. Does quantized Qwen materially change generation quality versus Tencent's default BF16 text encoder?

Known local test machine from the original discussion:

```text
GPU: NVIDIA RTX 3070, 8 GiB VRAM
Current repo had no venv and no PyTorch installed.
```

## Recommended First Experiments

### 1. Environment

Create an isolated Python environment for experiments. Keep this separate from the original fork state.

Use the repo requirements as a starting point, but expect dependency changes for quantization/offload experiments.

### 2. VRAM Profiler

Add a script such as:

```text
tools/profile_text_encoder_vram.py
```

It should report:

- load mode
- peak GPU memory
- CPU RAM if easy to measure
- encode time
- output tensor shapes
- whether generation-compatible tensors are produced

Test modes:

- Tencent default `HYTextModel`
- Qwen BF16 with `device_map="auto"`
- Qwen 4-bit via bitsandbytes
- Qwen CPU/offload mode
- CLIP alone
- Qwen + CLIP together

### 3. Remote Prompt Rewrite

Replace the optional local Text2MotionPrompter with a small provider abstraction:

```text
PromptRewriteProvider
- disabled/manual
- local Tencent prompter
- OpenRouter/OpenAI-compatible endpoint
```

Contract:

```json
{
  "duration": 120,
  "short_caption": "A person walks forward and turns left."
}
```

Duration is frames at 30 fps, matching Tencent's prompt format.

### 4. Generation Metadata

Every generated take should save a metadata JSON beside the motion output:

```json
{
  "prompt": "...",
  "rewritten_prompt": "...",
  "duration_seconds": 4.0,
  "duration_frames": 120,
  "seed": 123,
  "cfg_scale": 5.0,
  "validation_steps": 50,
  "model": "HY-Motion-1.0",
  "created_at": "...",
  "outputs": {
    "npz": "...",
    "fbx": "..."
  }
}
```

### 5. Backend Before UI

If the VRAM path is viable, add a FastAPI backend before building a polished frontend.

Possible endpoints:

```text
POST /api/generations
GET  /api/generations/{id}
GET  /api/generations/{id}/preview
GET  /api/generations/{id}/download/fbx
```

The backend should load models once where possible, but support explicit unload/reload experiments for low VRAM.

## UI Direction

Three.js makes sense for preview, but the browser cannot run the model.

Architecture:

```text
React/Vite/Three.js frontend
        |
        | HTTP / WebSocket
        v
FastAPI Python backend
        |
        v
HY-Motion runtime / pipeline
```

Initial UI should be a take generator, not a replacement for Blender:

- prompt box
- duration
- seed
- CFG
- validation steps
- model selector
- generate queue
- take list
- preview
- export/download

Avoid building timeline stitching in this app for v1. Blender is the right place for stitching, transitions, graph editing, NLA, IK, and final cleanup.

## ComfyUI Plugin Observation

The existing community ComfyUI plugin confirms that HY-Motion can be integrated outside Gradio:

```text
https://github.com/jtydhr88/ComfyUI-HY-Motion1
```

That plugin vendors a `hymotion/` folder and manually reconstructs the generation flow:

- load network
- load/encode text
- run `torchdiffeq.odeint`
- call the raw motion transformer
- apply CFG manually
- decode latent motion data

This is more low-level than calling `T2MRuntime.generate_motion()`.

For this fork, start less fragile:

```text
T2MRuntime / MotionFlowMatching.generate first.
Manual raw sampler only when we need deeper control.
```

## Non-Goals For Now

- Do not recreate Blender.
- Do not implement true Kimodo-style constraints unless the model is fine-tuned or a serious constraint sampler/postprocessor is added.
- Do not depend on the 56.9 GiB local Text2MotionPrompter as the default.
- Do not build a large frontend before measuring VRAM feasibility.
- Do not copy-paste large sections of model internals unless there is a clear reason.

## Open Questions

- Can full HY-Motion plus required text encoding fit into 8 GB or 12 GB with unload/reload?
- Does quantized Qwen hidden-state encoding preserve quality enough?
- Is CPU offload latency acceptable for an interactive UI?
- Should the backend save hidden-state conditioning so prompts can be regenerated without reloading Qwen?
- Should exact-frame generation be the default instead of duration seconds?

## Suggested Branches

```text
main
  stay close to Tencent upstream

experiments/text-encoder-vram
  Qwen/CLIP profiling, quantization, unload/reload

experiments/openrouter-prompter
  remote rewrite/duration provider

experiments/backend-api
  FastAPI generation wrapper

experiments/take-manager
  metadata, raw output persistence, take browser groundwork
```

