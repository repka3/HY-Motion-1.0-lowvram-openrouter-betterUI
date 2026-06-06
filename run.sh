#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
LOG_DIR="${LOG_DIR:-.logs}"

export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
if [[ -z "${HY_MODEL_VARIANT+x}" ]]; then
  if [[ -n "${HY_MODEL_PATH:-}" ]]; then
    HY_MODEL_VARIANT="$(basename "$HY_MODEL_PATH")"
  else
    HY_MODEL_VARIANT="HY-Motion-1.0"
  fi
fi
export HY_MODEL_VARIANT
export HY_MODEL_PATH="${HY_MODEL_PATH:-ckpts/tencent/$HY_MODEL_VARIANT}"
export HY_QWEN_PATH="${HY_QWEN_PATH:-ckpts/Qwen3-8B}"
export HY_CLIP_PATH="${HY_CLIP_PATH:-ckpts/clip-vit-large-patch14}"
export HY_QWEN_DEVICE_MAP="${HY_QWEN_DEVICE_MAP:-auto}"
export HY_QWEN_MAX_GPU_MEMORY="${HY_QWEN_MAX_GPU_MEMORY:-5GiB}"
export HY_QWEN_MAX_CPU_MEMORY="${HY_QWEN_MAX_CPU_MEMORY:-48GiB}"
export HY_TEXT_LOCAL_FILES_ONLY="${HY_TEXT_LOCAL_FILES_ONLY:-1}"

INSTALL=0
CHECK_ONLY=0
NO_CLEAN=0
SKIP_MODEL_DOWNLOAD=0
BACKEND_PID=""
FRONTEND_PID=""

usage() {
  cat <<EOF
Usage: ./run.sh [options]

Options:
  --check       Validate environment only; do not start servers.
  --install     Install missing Python/Node dependencies when possible.
  --skip-model-download
                With --install, install packages but do not download checkpoints.
  --no-clean    Do not stop existing project-local backend/frontend processes.
  -h, --help    Show this help.

Environment:
  BACKEND_PORT=$BACKEND_PORT
  FRONTEND_PORT=$FRONTEND_PORT
  HY_MODEL_PATH=$HY_MODEL_PATH
  HY_QWEN_PATH=$HY_QWEN_PATH
  HY_CLIP_PATH=$HY_CLIP_PATH
  HY_MODEL_VARIANT=$HY_MODEL_VARIANT
  HY_DOWNLOAD_PROMPTER=${HY_DOWNLOAD_PROMPTER:-0}
EOF
}

log() {
  printf '[run] %s\n' "$*"
}

warn() {
  printf '[run][warn] %s\n' "$*" >&2
}

die() {
  printf '[run][error] %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

require_file() {
  [[ -s "$1" ]] || die "Missing required file: $1"
}

require_dir() {
  [[ -d "$1" ]] || die "Missing required directory: $1"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check)
        CHECK_ONLY=1
        ;;
      --install)
        INSTALL=1
        ;;
      --skip-model-download)
        SKIP_MODEL_DOWNLOAD=1
        ;;
      --no-clean)
        NO_CLEAN=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown option: $1"
        ;;
    esac
    shift
  done
}

ensure_venv() {
  if [[ ! -x "venv/bin/python" ]]; then
    if [[ "$INSTALL" -eq 1 ]]; then
      need_cmd python3
      log "Creating venv..."
      python3 -m venv venv
    else
      die "Missing venv/bin/python. Run ./run.sh --install or create the venv manually."
    fi
  fi

  # shellcheck disable=SC1091
  source venv/bin/activate
}

install_python_deps() {
  log "Installing Python dependencies from requirements.txt..."
  venv/bin/python -m pip install --upgrade pip
  venv/bin/python -m pip install -r requirements.txt
}

check_python_deps() {
  local missing
  missing="$(
    venv/bin/python - <<'PY'
import importlib.util

modules = {
    "torch": "torch",
    "torchdiffeq": "torchdiffeq",
    "accelerate": "accelerate",
    "diffusers": "diffusers",
    "transformers": "transformers",
    "einops": "einops",
    "safetensors": "safetensors",
    "numpy": "numpy",
    "scipy": "scipy",
    "transforms3d": "transforms3d",
    "yaml": "PyYAML",
    "omegaconf": "omegaconf",
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "websockets": "websockets",
}

missing = [package for module, package in modules.items() if importlib.util.find_spec(module) is None]
print("\n".join(missing))
PY
  )"

  if [[ -n "$missing" ]]; then
    if [[ "$INSTALL" -eq 1 ]]; then
      install_python_deps
      check_python_deps
      return
    fi
    die "Missing Python packages: ${missing//$'\n'/, }. Run ./run.sh --install."
  fi

  venv/bin/python - <<'PY'
import os
import torch

if not torch.cuda.is_available():
    allow_cpu = os.environ.get("ALLOW_CPU", "").strip().lower() in {"1", "true", "yes", "on"}
    if allow_cpu:
        print("python_ok torch CUDA unavailable; ALLOW_CPU=1 is set")
        raise SystemExit(0)
    raise SystemExit("CUDA is not available. Set ALLOW_CPU=1 only if you intentionally want an impractical CPU run.")

print(f"python_ok torch={torch.__version__} cuda={torch.version.cuda} device={torch.cuda.get_device_name(0)}")
PY
}

check_node_deps() {
  need_cmd node
  need_cmd npm

  if [[ ! -d "web/node_modules" ]]; then
    if [[ "$INSTALL" -eq 1 ]]; then
      log "Installing frontend dependencies with npm ci..."
      npm --prefix web ci
    else
      die "Missing web/node_modules. Run ./run.sh --install or npm --prefix web ci."
    fi
  fi

  [[ -x "web/node_modules/.bin/vite" ]] || die "Missing Vite binary. Run npm --prefix web ci."
}

download_models_if_requested() {
  if [[ "$INSTALL" -ne 1 || "$SKIP_MODEL_DOWNLOAD" -eq 1 ]]; then
    return
  fi

  local model_variant motion_dir qwen_dir clip_dir
  model_variant="$HY_MODEL_VARIANT"
  motion_dir="$(dirname "$HY_MODEL_PATH")"
  qwen_dir="$HY_QWEN_PATH"
  clip_dir="$HY_CLIP_PATH"

  local args=(
    --model-variant "$model_variant"
    --motion-dir "$motion_dir"
    --qwen-dir "$qwen_dir"
  )

  if [[ "$clip_dir" == /* || "$clip_dir" == ./* || "$clip_dir" == ../* || "$clip_dir" == ckpts/* ]]; then
    args+=(--clip-dir "$clip_dir")
  else
    warn "HY_CLIP_PATH looks like a Hugging Face repo id, not a local path: $clip_dir"
    warn "Skipping local CLIP download; model validation will use the Hugging Face cache."
    args+=(--skip-clip)
  fi

  if [[ "${HY_DOWNLOAD_PROMPTER:-0}" == "1" ]]; then
    args+=(--with-prompter)
  fi

  log "Downloading/checking model assets..."
  venv/bin/python tools/download_models.py "${args[@]}"
}

hf_cache_dir_for_model_id() {
  local model_id="$1"
  local safe_id="${model_id//\//--}"
  local hf_home="${HF_HOME:-$HOME/.cache/huggingface}"
  printf '%s/hub/models--%s' "$hf_home" "$safe_id"
}

check_clip_available() {
  if [[ -d "$HY_CLIP_PATH" ]]; then
    require_file "$HY_CLIP_PATH/config.json"
    if ! find "$HY_CLIP_PATH" -maxdepth 1 -type f \( -name '*.safetensors' -o -name 'pytorch_model*.bin' \) | grep -q .; then
      die "CLIP directory exists but no model weights were found: $HY_CLIP_PATH"
    fi
    return
  fi

  local cache_dir
  cache_dir="$(hf_cache_dir_for_model_id "$HY_CLIP_PATH")"
  if [[ -d "$cache_dir/snapshots" ]] && find "$cache_dir/snapshots" -mindepth 1 -maxdepth 1 -type d | grep -q .; then
    return
  fi

  die "CLIP model is not locally available for HY_CLIP_PATH=$HY_CLIP_PATH. Download it or set HY_CLIP_PATH to a local folder."
}

check_models() {
  require_file "$HY_MODEL_PATH/config.yml"
  require_file "$HY_MODEL_PATH/latest.ckpt"

  require_file "$HY_QWEN_PATH/config.json"
  require_file "$HY_QWEN_PATH/tokenizer.json"
  require_file "$HY_QWEN_PATH/model.safetensors.index.json"
  if ! find "$HY_QWEN_PATH" -maxdepth 1 -type f -name 'model-*.safetensors' | grep -q .; then
    die "No Qwen safetensor shards found in $HY_QWEN_PATH"
  fi

  check_clip_available

  local asset_dir="web/public/assets/dump_wooden"
  for file in v_template.bin faces.bin skinWeights.bin skinIndice.bin j_template.bin uvs.bin kintree.bin joint_names.json Boy_lambert4_BaseColor.webp; do
    require_file "$asset_dir/$file"
  done
}

project_server_pids() {
  ps -eo pid=,cmd= | awk -v root="$ROOT_DIR" '
    index($0, root) && ($0 ~ /uvicorn hymotion\.api\.main:app|hymotion\.api\.main|npm run dev|node .*vite|vite --host/) {
      print $1
    }
  '
}

listener_pids_for_port() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

cmd_for_pid() {
  ps -p "$1" -o cmd= 2>/dev/null || true
}

stop_project_servers() {
  [[ "$NO_CLEAN" -eq 1 ]] && return

  local pids=()
  local pid cmd

  while read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(project_server_pids)

  for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
    while read -r pid; do
      [[ -z "$pid" ]] && continue
      cmd="$(cmd_for_pid "$pid")"
      if [[ "$cmd" == *"$ROOT_DIR"* || "$cmd" == *"hymotion.api.main"* || "$cmd" == *"vite"* ]]; then
        pids+=("$pid")
      else
        die "Port $port is already in use by non-project process PID $pid: $cmd"
      fi
    done < <(listener_pids_for_port "$port")
  done

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return
  fi

  mapfile -t pids < <(printf '%s\n' "${pids[@]}" | sort -n -u)
  log "Stopping existing project server process(es): ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true
  sleep 2

  local stubborn=()
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      stubborn+=("$pid")
    fi
  done

  if [[ "${#stubborn[@]}" -gt 0 ]]; then
    warn "Force-stopping stubborn process(es): ${stubborn[*]}"
    kill -9 "${stubborn[@]}" 2>/dev/null || true
    sleep 1
  fi
}

check_ports_clear() {
  local backend_pids frontend_pids
  backend_pids="$(listener_pids_for_port "$BACKEND_PORT" | tr '\n' ' ')"
  frontend_pids="$(listener_pids_for_port "$FRONTEND_PORT" | tr '\n' ' ')"
  [[ -z "$backend_pids" ]] || die "Backend port $BACKEND_PORT is still in use by PID(s): $backend_pids"
  [[ -z "$frontend_pids" ]] || die "Frontend port $FRONTEND_PORT is still in use by PID(s): $frontend_pids"
}

warn_gpu_compute_processes() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    return
  fi

  local rows
  rows="$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true)"
  if [[ -n "$rows" ]]; then
    warn "GPU compute process(es) already active; generation may OOM if they are unrelated:"
    printf '%s\n' "$rows" >&2
  fi
}

wait_for_url() {
  local url="$1"
  local name="$2"
  local tries="${3:-90}"
  local i

  for ((i = 1; i <= tries; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$name is ready: $url"
      return 0
    fi
    sleep 1
  done

  die "$name did not become ready: $url"
}

cleanup_children() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  exit "$exit_code"
}

start_servers() {
  mkdir -p "$LOG_DIR"
  local backend_log="$LOG_DIR/backend.log"
  local frontend_log="$LOG_DIR/frontend.log"

  log "Starting backend on http://$BACKEND_HOST:$BACKEND_PORT ..."
  venv/bin/python -m uvicorn hymotion.api.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT" >"$backend_log" 2>&1 &
  BACKEND_PID="$!"

  wait_for_url "http://$BACKEND_HOST:$BACKEND_PORT/api/health" "Backend"

  log "Starting frontend on http://$FRONTEND_HOST:$FRONTEND_PORT ..."
  (
    cd web
    exec node_modules/.bin/vite --host "$FRONTEND_HOST" --port "$FRONTEND_PORT" --strictPort
  ) >"$frontend_log" 2>&1 &
  FRONTEND_PID="$!"

  wait_for_url "http://$FRONTEND_HOST:$FRONTEND_PORT/" "Frontend"

  log "Frontend PID: $FRONTEND_PID"
  log "Backend PID:  $BACKEND_PID"
  log "Logs: $frontend_log and $backend_log"
  log "Open: http://$FRONTEND_HOST:$FRONTEND_PORT/"

  trap cleanup_children EXIT INT TERM
  wait -n "$BACKEND_PID" "$FRONTEND_PID"
}

main() {
  parse_args "$@"

  need_cmd awk
  need_cmd grep
  need_cmd lsof
  need_cmd curl

  ensure_venv
  check_python_deps
  check_node_deps
  download_models_if_requested
  check_models

  log "Environment checks passed."

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    exit 0
  fi

  stop_project_servers
  check_ports_clear
  warn_gpu_compute_processes
  start_servers
}

main "$@"
