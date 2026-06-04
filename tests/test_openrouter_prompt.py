from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

from hymotion.api.openrouter_prompt import (
    DEFAULT_MODEL,
    OpenRouterConfigError,
    OpenRouterPromptService,
    OpenRouterResponseError,
    OpenRouterSettings,
    default_system_prompt,
)


class FakeOpenRouterPromptService(OpenRouterPromptService):
    def __init__(self, config_path: Path, responses: List[Dict[str, Any]]) -> None:
        super().__init__(config_path=config_path)
        self.responses = responses
        self.calls: List[tuple[OpenRouterSettings, str]] = []

    def _call_openrouter(self, settings: OpenRouterSettings, prompt: str) -> Dict[str, Any]:
        self.calls.append((settings, prompt))
        return self.responses.pop(0)


class OpenRouterPromptTests(unittest.TestCase):
    def test_default_public_settings_mask_key_and_include_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            service = OpenRouterPromptService(config_path=Path(tmp) / "openrouter.json")
            settings = service.public_settings()

        self.assertFalse(settings["hasApiKey"])
        self.assertEqual(settings["model"], DEFAULT_MODEL)
        self.assertIn("duration_seconds", settings["systemPrompt"])
        self.assertIn("seconds, not frames", settings["systemPrompt"])
        self.assertEqual(settings["defaultSystemPrompt"], settings["systemPrompt"])
        self.assertNotIn("duration\": <Integer, frames", settings["systemPrompt"])

    def test_settings_persist_without_exposing_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "openrouter.json"
            service = OpenRouterPromptService(config_path=config_path)
            public = service.update_settings(api_key=" sk-or-v1-secret ", model="openai/gpt-4o", system_prompt="prompt")

            self.assertTrue(public["hasApiKey"])
            self.assertNotIn("apiKey", public)
            persisted = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["apiKey"], "sk-or-v1-secret")

            service.update_settings(api_key="", model="anthropic/claude-sonnet-4.5", system_prompt="prompt 2")
            persisted = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["apiKey"], "sk-or-v1-secret")
            self.assertEqual(persisted["model"], "anthropic/claude-sonnet-4.5")

            cleared = service.update_settings(clear_api_key=True)
            self.assertFalse(cleared["hasApiKey"])
            persisted = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertNotIn("apiKey", persisted)

    def test_enhance_prompt_uses_seconds_directly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "openrouter.json"
            service = FakeOpenRouterPromptService(
                config_path=config_path,
                responses=[{"duration_seconds": 5.5, "short_caption": "A person walks forward."}],
            )
            service.update_settings(api_key="sk-test", model="openai/gpt-4o", system_prompt=default_system_prompt())

            result = service.enhance_prompt("walk")

        self.assertEqual(result["prompt"], "A person walks forward.")
        self.assertEqual(result["durationSeconds"], 5.5)
        self.assertEqual(result["model"], "openai/gpt-4o")
        self.assertEqual(service.calls[0][1], "walk")

    def test_enhance_prompt_clamps_duration_to_generation_limits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            service = FakeOpenRouterPromptService(
                config_path=Path(tmp) / "openrouter.json",
                responses=[{"duration_seconds": 28, "short_caption": "A long dance sequence."}],
            )
            service.update_settings(api_key="sk-test")

            result = service.enhance_prompt("dance for a long time")

        self.assertEqual(result["durationSeconds"], 20.0)

    def test_enhance_prompt_requires_saved_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            service = OpenRouterPromptService(config_path=Path(tmp) / "openrouter.json")
            with self.assertRaises(OpenRouterConfigError):
                service.enhance_prompt("walk")

    def test_json_parser_accepts_fenced_output(self) -> None:
        parsed = OpenRouterPromptService._parse_json_content(
            '```json\n{"duration_seconds": "3.5", "short_caption": "A person turns left."}\n```'
        )
        self.assertEqual(parsed["duration_seconds"], "3.5")
        self.assertEqual(parsed["short_caption"], "A person turns left.")

    def test_json_parser_rejects_missing_fields(self) -> None:
        with self.assertRaises(OpenRouterResponseError):
            OpenRouterPromptService._parse_json_content('{"duration": 90, "short_caption": "legacy"}')


if __name__ == "__main__":
    unittest.main()
