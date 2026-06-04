from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from openai import OpenAI


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "deepseek/deepseek-v4-flash"
MIN_DURATION_SECONDS = 0.5
MAX_DURATION_SECONDS = 20.0
DEFAULT_SYSTEM_PROMPT = """
# Role
You are an expert in 3D human motion generation prompts, animation timing, and concise action description.

# Task
Rewrite the user-provided action into a clear English motion-generation prompt and estimate a natural duration in seconds.

# Duration Rules
- Return duration_seconds as seconds, not frames.
- Use a realistic duration for a smooth 3D human animation.
- Simple gestures usually take 2.0-4.0 seconds.
- Standing, sitting, kneeling, lying down, or floor transitions usually take 4.0-7.0 seconds.
- Multi-step actions usually take 6.0-12.0 seconds.
- Use decimals when useful.

# Rewrite Rules
- Preserve the original action intent and chronological order.
- Keep important spatial modifiers such as left, right, upward, downward, forward, backward, and to one side.
- Improve vague wording into concrete body motion when it is directly implied by the request.
- Do not add props, scene context, emotions, identity details, or unrelated sub-actions.
- Write one concise caption suitable for HY-Motion text-to-motion generation.

# Output Format
Return only valid raw JSON with this exact structure:
{
  "duration_seconds": <Number>,
  "short_caption": "<String>"
}
""".strip()


class OpenRouterConfigError(ValueError):
    pass


class OpenRouterResponseError(ValueError):
    pass


@dataclass
class OpenRouterSettings:
    api_key: str
    model: str
    system_prompt: str


def default_system_prompt() -> str:
    return DEFAULT_SYSTEM_PROMPT


class OpenRouterPromptService:
    def __init__(self, config_path: Path | str | None = None) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        self.config_path = Path(config_path) if config_path is not None else repo_root / "openrouter_config.local.json"

    def public_settings(self) -> Dict[str, Any]:
        settings = self._read_config()
        return {
            "hasApiKey": bool(str(settings.get("apiKey", "")).strip()),
            "model": str(settings.get("model", DEFAULT_MODEL)).strip(),
            "systemPrompt": str(settings.get("systemPrompt") or default_system_prompt()),
            "defaultSystemPrompt": default_system_prompt(),
        }

    def update_settings(
        self,
        *,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        clear_api_key: bool = False,
    ) -> Dict[str, Any]:
        settings = self._read_config()
        if clear_api_key:
            settings.pop("apiKey", None)
        elif api_key is not None and api_key.strip():
            settings["apiKey"] = api_key.strip()

        if model is not None:
            settings["model"] = model.strip()
        if system_prompt is not None:
            settings["systemPrompt"] = system_prompt.strip() or default_system_prompt()

        self._write_config(settings)
        return self.public_settings()

    def enhance_prompt(self, prompt: str) -> Dict[str, Any]:
        settings = self._private_settings()
        raw = self._call_with_retry(settings, prompt.strip())
        duration_seconds = self._parse_duration_seconds(raw)
        short_caption = str(raw["short_caption"]).strip()
        if not short_caption:
            raise OpenRouterResponseError("OpenRouter returned an empty rewritten prompt")
        return {
            "prompt": short_caption,
            "durationSeconds": duration_seconds,
            "model": settings.model,
        }

    def _private_settings(self) -> OpenRouterSettings:
        settings = self._read_config()
        api_key = str(settings.get("apiKey", "")).strip()
        model = str(settings.get("model", DEFAULT_MODEL)).strip()
        system_prompt = str(settings.get("systemPrompt") or default_system_prompt()).strip()
        if not api_key:
            raise OpenRouterConfigError("OpenRouter API key is not configured")
        if not model:
            raise OpenRouterConfigError("OpenRouter model is not configured")
        if not system_prompt:
            raise OpenRouterConfigError("OpenRouter system prompt is not configured")
        return OpenRouterSettings(api_key=api_key, model=model, system_prompt=system_prompt)

    def _call_with_retry(self, settings: OpenRouterSettings, prompt: str, max_retries: int = 3) -> Dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(max_retries):
            try:
                return self._call_openrouter(settings, prompt)
            except OpenRouterResponseError as exc:
                last_error = exc
                if attempt < max_retries - 1:
                    time.sleep(min(1.0, 0.25 * (2**attempt)) * (0.75 + random.random() * 0.5))
                    continue
                break
        raise OpenRouterResponseError("OpenRouter did not return valid prompt JSON") from last_error

    def _call_openrouter(self, settings: OpenRouterSettings, prompt: str) -> Dict[str, Any]:
        client = OpenAI(
            api_key=settings.api_key,
            base_url=OPENROUTER_BASE_URL,
            timeout=60,
            max_retries=1,
            default_headers={
                "HTTP-Referer": "http://127.0.0.1:5173/",
                "X-OpenRouter-Title": "HY-Motion Studio",
            },
        )
        response = client.chat.completions.create(
            model=settings.model,
            messages=[
                {"role": "system", "content": settings.system_prompt},
                {
                    "role": "user",
                    "content": (
                        "[Input Action]\n"
                        f"{prompt}\n\n"
                        "Return only a raw JSON object with duration_seconds and short_caption."
                    ),
                },
            ],
        )
        content = response.choices[0].message.content if response.choices else None
        if not isinstance(content, str) or not content.strip():
            raise OpenRouterResponseError("OpenRouter returned no message content")
        return self._parse_json_content(content)

    @staticmethod
    def _parse_json_content(content: str) -> Dict[str, Any]:
        cleaned = content.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)
        if not cleaned.lstrip().startswith("{") and "{" in cleaned and "}" in cleaned:
            cleaned = cleaned[cleaned.find("{") : cleaned.rfind("}") + 1]
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            raise OpenRouterResponseError(f"OpenRouter returned invalid JSON: {exc}") from exc
        if not isinstance(parsed, dict):
            raise OpenRouterResponseError("OpenRouter JSON response must be an object")
        if "duration_seconds" not in parsed or "short_caption" not in parsed:
            raise OpenRouterResponseError("OpenRouter JSON response must include duration_seconds and short_caption")
        return parsed

    @staticmethod
    def _parse_duration_seconds(payload: Dict[str, Any]) -> float:
        try:
            duration = round(float(payload["duration_seconds"]), 2)
        except (TypeError, ValueError) as exc:
            raise OpenRouterResponseError("OpenRouter duration_seconds must be numeric") from exc
        if duration <= 0:
            raise OpenRouterResponseError("OpenRouter duration_seconds must be positive")
        return OpenRouterPromptService._clamp_seconds(duration)

    @staticmethod
    def _clamp_seconds(value: float) -> float:
        return max(MIN_DURATION_SECONDS, min(MAX_DURATION_SECONDS, value))

    def _read_config(self) -> Dict[str, Any]:
        if not self.config_path.exists():
            return {
                "model": DEFAULT_MODEL,
                "systemPrompt": default_system_prompt(),
            }
        try:
            with self.config_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as exc:
            raise OpenRouterConfigError(f"OpenRouter config is invalid JSON: {self.config_path}") from exc
        if not isinstance(data, dict):
            raise OpenRouterConfigError("OpenRouter config must be a JSON object")
        data.setdefault("model", DEFAULT_MODEL)
        data.setdefault("systemPrompt", default_system_prompt())
        return data

    def _write_config(self, settings: Dict[str, Any]) -> None:
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        public_order = {
            "apiKey": str(settings.get("apiKey", "")).strip(),
            "model": str(settings.get("model", DEFAULT_MODEL)).strip(),
            "systemPrompt": str(settings.get("systemPrompt") or default_system_prompt()).strip(),
        }
        if not public_order["apiKey"]:
            public_order.pop("apiKey")
        with self.config_path.open("w", encoding="utf-8") as f:
            json.dump(public_order, f, indent=2, ensure_ascii=False)
