"""Camera sentence proposals preserve event repetitions; no network or model needed."""

import asyncio
import json
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

from app.api.sentence_builder import build_sentence, build_sentence_local


class SentenceBuilderTest(unittest.TestCase):
    def test_local_preserves_adjacent_repetitions_and_negation(self):
        words = ["tôi", "không", "muốn", "đi", "đi", "lại", "lại"]
        self.assertEqual(build_sentence_local(words), "Tôi không muốn đi đi lại lại.")
        self.assertEqual(words, ["tôi", "không", "muốn", "đi", "đi", "lại", "lại"])

    def test_local_keeps_distinct_negations_and_existing_label_cleanup(self):
        self.assertEqual(build_sentence_local(["chưa", "đi", "đừng", "đi"]), "Chưa đi đừng đi.")
        self.assertEqual(build_sentence_local([" uống / đồ uống ", "uống / đồ uống"]), "Uống uống.")
        with self.assertRaises(ValueError):
            build_sentence_local(["", " "])

    def invoke_mock_gemini(self, words, response_text):
        generate = AsyncMock(return_value=types.SimpleNamespace(text=response_text))
        client = types.SimpleNamespace(aio=types.SimpleNamespace(models=types.SimpleNamespace(generate_content=generate)))
        google = types.ModuleType("google")
        genai = types.ModuleType("google.genai")
        genai.Client = lambda **kwargs: client
        genai.types = types.SimpleNamespace(GenerateContentConfig=lambda **kwargs: kwargs)
        google.genai = genai
        with patch.dict(sys.modules, {"google": google, "google.genai": genai}), \
                patch("app.api.sentence_builder.gemini_configured", return_value=True), \
                patch.dict("os.environ", {"GEMINI_API_KEY": "test-placeholder"}):
            result = asyncio.run(build_sentence(words))
        return result, generate.await_args.kwargs

    def test_prompt_treats_repeated_tokens_as_distinct_events_and_preserves_negation(self):
        words = ["tôi", "không", "muốn", "đi", "đi", "lại", "lại"]
        result, request = self.invoke_mock_gemini(words, '"Tôi không muốn đi đi lại lại."')
        self.assertEqual(result, "Tôi không muốn đi đi lại lại.")
        prompt = request["contents"]
        self.assertIn(json.dumps(words, ensure_ascii=False), prompt)
        self.assertIn("Không thêm đại từ", prompt)
        self.assertIn("Giữ nguyên mọi từ phủ định", prompt)
        self.assertIn("Giữ nguyên các từ lặp", prompt)
        self.assertNotIn("chỉ giữ một lần", prompt)
        self.assertEqual(request["config"]["temperature"], 0)

    def test_empty_gemini_response_is_rejected(self):
        with self.assertRaises(RuntimeError):
            self.invoke_mock_gemini(["không"], '  ""  ')


if __name__ == "__main__":
    unittest.main()
