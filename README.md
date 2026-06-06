# HyMotion studio

![HyMotion studio interface](screenshots/home1.png)

![HyMotion export page](screenshots/export.png)

![HyMotion retargeting in Blender](screenshots/retarget.png)

HyMotion studio is a local creator interface for Tencent HY-Motion 1.0, focused on making the full model usable on consumer GPUs with limited VRAM. The current app pairs a React/Three.js frontend with a FastAPI backend and a low-VRAM generation schedule that runs the full `HY-Motion-1.0/latest.ckpt` path on an RTX 3070 8GB class card without quantizing the motion model or switching to the Lite checkpoint.

## Fresh Install

This fork is set up for a one-command local install after cloning. The install path is Linux-focused and assumes an NVIDIA GPU. The validated low-VRAM path uses the full `HY-Motion-1.0` checkpoint on an RTX 3070 8GB class GPU.

### System Requirements

Install these before cloning:

- `git` and `git-lfs`
- `python3` with `venv`
- `node` and `npm`
- `curl` and `lsof`
- A recent NVIDIA driver compatible with the CUDA `12.8` PyTorch wheels in `requirements.txt`

Ubuntu example:

```bash
sudo apt update
sudo apt install -y git git-lfs python3 python3-venv python3-pip nodejs npm curl lsof
git lfs install
```

If your distro packages an old Node.js, install a newer Node runtime with `nvm` or your package manager. This workspace was tested with Python `3.12`, Node `24`, and npm `11`.

### Clone

```bash
git clone <your-repo-url>
cd HY-Motion-1.0-lowvram-openrouter-betterUI
git lfs pull
```

`git lfs pull` is important because the repository contains binary template assets, stats, screenshots, and other files tracked by Git LFS. If those files are still text pointer files, model viewing and export will break even if the Python dependencies are installed.

### Install Dependencies And Models

```bash
./install.sh
```

`./install.sh` runs `./run.sh --install --check`. It creates `venv/`, installs Python dependencies from `requirements.txt`, installs frontend dependencies with `npm ci`, and downloads the default model assets into `ckpts/`.

Default downloaded layout:

```text
ckpts/
├── tencent/
│   └── HY-Motion-1.0/
├── Qwen3-8B/
└── clip-vit-large-patch14/
```

The first install downloads tens of GB:

- HY-Motion full checkpoint: about 4 GB
- Qwen3-8B text encoder: about 16 GB
- CLIP ViT-L/14 text encoder: smaller, but still downloaded locally for offline-stable startup

If Hugging Face requires authentication, set a token before installing:

```bash
export HF_TOKEN=hf_your_token_here
./install.sh
```

### Launch

After installation:

```bash
./run.sh
```

Open the app at:

```text
http://127.0.0.1:5173/
```

The backend runs at `http://127.0.0.1:8000/`. Logs are written to `.logs/backend.log` and `.logs/frontend.log`.

Alternative install-and-launch command:

```bash
./run.sh --install
```

### Useful Install Variants

Install the Lite checkpoint instead of the full checkpoint:

```bash
HY_MODEL_VARIANT=HY-Motion-1.0-Lite ./install.sh
HY_MODEL_VARIANT=HY-Motion-1.0-Lite ./run.sh
```

Install dependencies but skip model downloads:

```bash
./run.sh --install --skip-model-download --check
```

Download or verify only model assets:

```bash
venv/bin/python tools/download_models.py
venv/bin/python tools/download_models.py --check-only
venv/bin/python tools/download_models.py --help
```

Optionally download the upstream local prompt rewriter model. The studio normally uses OpenRouter instead, so this is not required:

```bash
HY_DOWNLOAD_PROMPTER=1 ./install.sh
```

### OpenRouter Setup

Prompt enhancement and automatic duration estimation use OpenRouter. The app can still generate without it, but those helper buttons need an API key.

Create `openrouter_config.local.json` in the repository root:

```json
{
  "apiKey": "sk-or-your-key",
  "model": "openai/gpt-4.1-mini"
}
```

This file is ignored by git.

### Verification

Check the installed environment without starting servers:

```bash
./run.sh --check
```

Run the backend tests:

```bash
venv/bin/python -m unittest tests.test_export_service tests.test_api_service tests.test_motion_json tests.test_openrouter_prompt
```

Build the frontend:

```bash
npm --prefix web run build
```

### Common Issues

- `Missing HY-Motion checkpoint`: run `venv/bin/python tools/download_models.py` or rerun `./install.sh`.
- `Missing Qwen safetensor shards`: Qwen did not finish downloading; rerun the downloader.
- `CLIP model is not locally available`: run `venv/bin/python tools/download_models.py --skip-qwen` to fetch just the missing CLIP path.
- `CUDA is not available`: install/update the NVIDIA driver. CPU fallback is not practical for normal generation.
- `Port 8000/5173 is already in use`: stop the existing server or set `BACKEND_PORT` / `FRONTEND_PORT`.
- Browser loads but model/export viewer is broken: run `git lfs pull` and confirm the binary assets are not LFS pointer text files.

## Current App State

The app currently supports:

- Full `HY-Motion-1.0`, not `HY-Motion-1.0-Lite`.
- Full `Qwen/Qwen3-8B` text encoder and `openai/clip-vit-large-patch14`.
- Text encoding once per prompt, then unloading the text encoders before loading HY-Motion.
- One or more seeded variations generated sequentially from cached hidden states.
- Browser-based generation controls for prompt, duration, CFG, inference steps, variations, and seeds.
- A Three.js motion viewer with side-by-side variation comparison, playback controls, selected-clip metadata, and favorites.
- An export/fix page with animation and rest-pose preview, global ground offset correction, and FBX/GLB downloads with or without skin.
- A validated Blender Auto-Rig Pro retarget path for skeleton-only GLB exports.
- OpenRouter-powered prompt enhancement and duration estimation, avoiding the local Text2MotionPrompter LLM download.

## Export And Retargeting

The current reliable Blender path is:

1. Select a generated motion in the studio.
2. Open the export page.
3. Use `Rest to ground` if the rest pose needs grounding.
4. Export `GLB skeleton`.
5. Import the GLB in Blender.
6. In Auto-Rig Pro Remap, use the source armature `HYMotionArmature`.
7. Import the preset at `autorig_presets/hymotion_preset.bmap`.
8. Retarget to the character rig.

The HYMotion preset maps the exported SMPL-H-style source bones to the working Auto-Rig Pro target controls. `Pelvis` is mapped as the root to `c_root_master.x`; `Spine1` maps to `c_spine_01.x`; `Spine3` maps to `c_spine_02.x`; `Spine2` is intentionally unmapped.

Skeleton-only GLB exports can show a tiny `Mesh_0` carrier object in Blender. That is expected: it lets glTF import as a real skinned armature instead of loose animated transform nodes. Use `HYMotionArmature` as the retarget source and ignore the carrier mesh.

FBX skeleton exports now apply the same rest-height correction to the FBX root default transform, so Blender Rest Position should match the corrected frame-0 height. Skinned GLB/FBX export buttons exist, but the validated production retarget path is currently the skeleton-only GLB workflow above.

## Missing / Planned

- Add stronger progress feedback and recovery paths around long-running generation jobs.
- Validate multi-GPU and CPU-only fallback paths.
- Validate skinned GLB/FBX exports against Blender and Auto-Rig Pro.

## Precision

No quantization is used in the validated low-VRAM path.

| Component | Precision / dtype | Notes |
|:--|:--|:--|
| HY-Motion full checkpoint | FP32 | `latest.ckpt` tensors are `torch.float32`. |
| Qwen3-8B text encoder | BF16 | This matches the upstream/default HY-Motion text encoder loading path. |
| CLIP ViT-L/14 text encoder | FP32 | Loaded without dtype override. |
| Quantization | None | No 4-bit, no 8-bit, no bitsandbytes quantized path for the validated run. |

So the current result is not "everything FP32" because Qwen is BF16 by upstream design, but it is the full-quality non-quantized path: full model, full text encoders, no Lite checkpoint.

## Low-VRAM Strategy

The working memory schedule is:

1. Load Qwen/CLIP text encoder.
2. Encode the prompt into HY-Motion hidden states.
3. Move hidden states to CPU.
4. Unload Qwen/CLIP and clear CUDA cache.
5. Load full HY-Motion on GPU.
6. Generate outputs from the cached hidden states.

For multiple variations of the same prompt, the text encoder output is deterministic and can be reused. The variation comes from the HY-Motion generation seed, not from the text encoder.

## Measured 8GB Results

Test prompt:

```text
a female person kneeling down from a standing position
```

Test settings:

- Duration: `4.0s`
- CFG: `5.0`
- Full model: `ckpts/tencent/HY-Motion-1.0/latest.ckpt`
- GPU: RTX 3070 8GB class card

Measured flow:

| Step | Time / VRAM |
|:--|:--|
| Text encoder load | ~3.0s |
| Text encode once | ~1.8s |
| HY-Motion load | ~7.0s |
| Sequential generation | ~7.3s per seed |
| Peak VRAM during text encoding | ~5.5 GiB |
| Peak VRAM during generation | ~5.5 GiB |

Actual HY-Motion batch generation also fits after hidden-state caching, but it did not improve runtime meaningfully on the 8GB test GPU:

| Generation mode | Time |
|:--|:--|
| 1 seed, CFG 5 | ~7.5s |
| 4 seeds as real batch, CFG 5 | ~28.0s |
| 4 seeds sequential, CFG 5 | ~29.0s total |

The main VRAM issue is batched Qwen text encoding, not HY-Motion generation from already cached hidden states. For 8GB, the current practical strategy is encode once, then generate variations sequentially.

## Test Scripts

Profile Qwen/CLIP text encoder memory:

```bash
venv/bin/python tools/profile_text_encoder_vram.py --mode qwen-bf16 --local-files-only --max-gpu-memory 5GiB
```

Run the validated 4-variation test:

```bash
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
venv/bin/python tools/test_lowvram_multiseed.py
```

Run with fixed seeds:

```bash
venv/bin/python tools/test_lowvram_multiseed.py --seeds 1,2,3,4
```

## Gradio Low-VRAM Test Mode

The fork currently has a low-VRAM Gradio test path controlled by environment variables. It is useful for validation, but it is not the final UI plan.

Example launch:

```bash
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
HY_MODEL_PATH=ckpts/tencent/HY-Motion-1.0 \
HY_LOWVRAM_TEXT_FIRST=1 \
HY_LOWVRAM_MAX_SEEDS=1 \
HY_QWEN_PATH=ckpts/Qwen3-8B \
HY_CLIP_PATH=ckpts/clip-vit-large-patch14 \
HY_QWEN_DEVICE_MAP=auto \
HY_QWEN_MAX_GPU_MEMORY=5GiB \
HY_QWEN_MAX_CPU_MEMORY=48GiB \
HY_TEXT_LOCAL_FILES_ONLY=1 \
HY_OUTPUT_FORMAT=dict \
DISABLE_PROMPT_ENGINEERING=1 \
GRADIO_SERVER_NAME=127.0.0.1 \
GRADIO_SERVER_PORT=7860 \
venv/bin/python gradio_app.py
```

## Upstream README

Tencent's original README is preserved below for attribution and upstream documentation.

---

[中文阅读](README_zh_cn.md)


<p align="center">
  <img src="./assets/banner.png" alt="Banner" width="100%">
</p>

<div align="center">
  <a href="https://aistudio.tencent.com/motion" target="_blank">
    <img src="https://img.shields.io/badge/Official%20Site-333399.svg?logo=homepage" height="22px" alt="Official Site">
  </a>
  <a href="https://github.com/Tencent-Hunyuan/HY-Motion-1.0" target="_blank">
    <img src="https://img.shields.io/badge/GitHub-Repo-181717?logo=github&logoColor=white" height="22px" alt="Github Repo">
  </a>
  <a href="https://huggingface.co/spaces/tencent/HY-Motion-1.0" target="_blank">
    <img src="https://img.shields.io/badge/%F0%9F%A4%97%20Demo-276cb4.svg" height="22px" alt="HuggingFace Space">
  </a>
  <a href="https://huggingface.co/tencent/HY-Motion-1.0" target="_blank">
    <img src="https://img.shields.io/badge/%F0%9F%A4%97%20Models-d96902.svg" height="22px" alt="HuggingFace Models">
  </a>
  <a href="https://arxiv.org/pdf/2512.23464" target="_blank">
    <img src="https://img.shields.io/badge/Report-b5212f.svg?logo=arxiv" height="22px" alt="ArXiv Report">
  </a>
  <a href="https://x.com/TencentHunyuan" target="_blank">
    <img src="https://img.shields.io/badge/Hunyuan-black.svg?logo=x" height="22px" alt="X (Twitter)">
  </a>
</div>


# HY-Motion 1.0: Scaling Flow Matching Models for 3D Motion Generation


<p align="center">
  <img src="./assets/teaser.jpg" alt="Teaser" width="100%">
</p>


## 🔥 News
- **Jan 29, 2026**: 📊 We released the evaluation prompts and code for **SSAE** (Structured Semantic Alignment Evaluation), a VLM-based metric designed to assess the semantic alignment of generated videos. Check the `ssae` directory for usage details!
- **Dec 30, 2025**: 🤗 We released the inference code and pretrained models of [HY-Motion 1.0](https://huggingface.co/tencent/HY-Motion-1.0). Please give it a try via our [HuggingFace Space](https://huggingface.co/spaces/tencent/HY-Motion-1.0) and our [Official Site](https://hunyuan.tencent.com/motion)!


## **Introduction**

**HY-Motion 1.0** is a series of text-to-3D human motion generation models based on Diffusion Transformer (DiT) and Flow Matching. It allows developers to generate skeleton-based 3D character animations from simple text prompts, which can be directly integrated into various 3D animation pipelines. This model series is the first to scale DiT-based text-to-motion models to the billion-parameter level, achieving significant improvements in instruction-following capabilities and motion quality over existing open-source models.

### Key Features
- **State-of-the-Art Performance**: Achieves state-of-the-art performance in both instruction-following capability and generated motion quality.

- **Billion-Scale Models**: We are the first to successfully scale DiT-based models to the billion-parameter level for text-to-motion generation. This results in superior instruction understanding and following capabilities, outperforming comparable open-source models.

- **Advanced Three-Stage Training**: Our models are trained using a comprehensive three-stage process:

    - *Large-Scale Pre-training*: Trained on over 3,000 hours of diverse motion data to learn a broad motion prior.

    - *High-Quality Fine-tuning*: Fine-tuned on 400 hours of curated, high-quality 3D motion data to enhance motion detail and smoothness.

    - *Reinforcement Learning*: Utilizes Reinforcement Learning from human feedback and reward models to further refine instruction-following and motion naturalness.



<p align="center">
  <img src="./assets/pipeline.png" alt="System Overview" width="100%">
</p>

<p align="center">
  <img src="./assets/arch.png" alt="Architecture" width="100%">
</p>

<p align="center">
  <img src="./assets/sotacomp.jpg" alt="ComparisonSoTA" width="100%">
</p>




## 🎁 Model Zoo

**HY-Motion 1.0 Series**

| Model | Description | Date | Size | Huggingface | VRAM (min) |
|:-------|:-------------|:------:|:------:|:-------------:|:-------------:|
| **HY-Motion-1.0** | Standard Text2Motion Model | 2025-12-30 | 1.0B | [Download](https://huggingface.co/tencent/HY-Motion-1.0/tree/main/HY-Motion-1.0) | 26GB |
| **HY-Motion-1.0-Lite** | Lightweight Text2Motion Model | 2025-12-30 | 0.46B | [Download](https://huggingface.co/tencent/HY-Motion-1.0/tree/main/HY-Motion-1.0-Lite) | 24GB |

*Note*: To reduce GPU VRAM requirements, please use the following settings: `--num_seeds=1`, text prompt with less than 30 words, and motion length less than 5 seconds.  
*Note*: This table does not includes GPU VRAM requirements for LLM-based prompt engineering feature. If you have sufficient VRAM to run HY-Motion-1.0 model but gradio fails with a VRAM-related error, Run the Gradio application with prompt engineering disabled by setting the environment variable like this: `DISABLE_PROMPT_ENGINEERING=True python3 gradio_app.py`

## 🤗 Get Started with HY-Motion 1.0

HY-Motion 1.0 supports macOS, Windows, and Linux.


- [Code Usage (CLI)](#code-usage-cli)
- [Gradio App](#gradio-app)


#### 1. Installation

First, install PyTorch via the [official site](https://pytorch.org/). Then install the dependencies:

```bash
git clone https://github.com/Tencent-Hunyuan/HY-Motion-1.0.git
cd HY-Motion-1.0/
# Make sure git-lfs is installed
git lfs pull
pip install -r requirements.txt
```

#### 2. Download Model Weights
Please follow the instructions in [ckpts/README.md](ckpts/README.md) to download the necessary model weights.

### Code Usage (CLI)

We provide a script for local batch inference, suitable for processing large amounts of prompts.

```bash
# HY-Motion-1.0
python3 local_infer.py --model_path ckpts/tencent/HY-Motion-1.0

# HY-Motion-1.0-Lite
python3 local_infer.py --model_path ckpts/tencent/HY-Motion-1.0-Lite
```

**Common Parameters:**
- `--input_text_dir`: Directory containing `.txt` or `.json` prompt files.
- `--output_dir`: Directory to save results (default: `output/local_infer`).
- `--disable_duration_est`: Disable LLM-based duration estimation.
- `--disable_rewrite`: Disable LLM-based prompt rewriting.
- `--prompt_engineering_host` / `--prompt_engineering_model_path`: (Optional) Host address / local checkpoint for the Duration Prediction & Prompt Rewrite Module.
    - **Download**: You can download the Duration Prediction & Prompt Rewrite Module from [Here](https://huggingface.co/Text2MotionPrompter/Text2MotionPrompter).
    - **Note**: If you **do not** set these  parameter, you must also set `--disable_duration_est` and `--disable_rewrite`. Otherwise, the script will raise an error due to host unavailable.


### Gradio App

You can host a [Gradio](https://www.gradio.app/) web interface on your local machine for interactive visualization:

```bash
python3 gradio_app.py
```
After running the command, open your browser and visit `http://localhost:7860`


## Prompting Guide & Best Practices

1. Language & Length: Please use English. For optimal results, keep your prompt under 60 words. For other languages, please use the Text2MotionPrompter to rewrite the prompt. 

2. Content Focus: Focus on action descriptions or detailed movements of the limbs and torso.

3. Current Limitations (**NOT** Supported):

 - ❌ Non-humanoid Characters: Animations for animals or non-human creatures. 
 - ❌ Subjective/Visual Attributes: Descriptions of complex emotions, clothing, or physical appearance. 
 - ❌ Environment & Camera: Descriptions of objects, scenes, or camera angles. 
 - ❌ Multi-person Interactions: Motions involving two or more people. 
 - ❌ Special Modes: Seamless loop or in-place animations. 

4. Example Prompts:
 - A person performs a squat, then pushes a barbell overhead using the power from standing up.
 - A person climbs upward, moving up the slope.
 - A person stands up from the chair, then stretches their arms.
 - A person walks unsteadily, then slowly sits down.


## 🔗 BibTeX

If you found this repository helpful, please cite our reports:

```bibtex
@article{HyMotion2025,
  title={HY-Motion 1.0: Scaling Flow Matching Models for Text-To-Motion Generation},
  author={Tencent Hunyuan 3D Digital Human Team},
  journal={arXiv preprint arXiv:2512.23464},
  year={2025}
}
```

## 🤗 Community Integrations
We appreciate the community for creating integrations for HY-Motion! Here are some third-party implementations:

- [ComfyUI-HY-Motion1](https://github.com/jtydhr88/ComfyUI-HY-Motion1) by [@jtydhr88](https://github.com/jtydhr88)

## Acknowledgements

We would like to thank the contributors to the [FLUX](https://github.com/black-forest-labs/flux), [diffusers](https://github.com/huggingface/diffusers), [HuggingFace](https://huggingface.co), [SMPL](https://smpl.is.tue.mpg.de/)/[SMPLH](https://mano.is.tue.mpg.de/), [CLIP](https://github.com/openai/CLIP), [Qwen3](https://github.com/QwenLM/Qwen3), [PyTorch3D](https://github.com/facebookresearch/pytorch3d), [kornia](https://github.com/kornia/kornia), [transforms3d](https://github.com/matthew-brett/transforms3d), [FBX-SDK](https://www.autodesk.com/developer-network/platform-technologies/fbx-sdk-2020-0), [GVHMR](https://zju3dv.github.io/gvhmr/), and [HunyuanVideo](https://github.com/Tencent-Hunyuan/HunyuanVideo) repositories or tools, for their open research and exploration.
