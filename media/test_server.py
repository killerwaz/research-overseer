"""Mode logic of server.py with YouTube faked out — these tests make no network calls."""
import json, pathlib, tempfile, time, unittest
from unittest import mock

import server

META = {"id": "abcdefghijk", "webpage_url": "https://www.youtube.com/watch?v=abcdefghijk", "extractor_key": "Youtube",
        "title": "T", "channel": "C", "duration": 120, "upload_date": "20261010", "language": "en",
        "automatic_captions": {"en-orig": [{"ext": "json3", "url": "CAP"}]}}
JSON3 = {"events": [{"tStartMs": i * 10000, "segs": [{"utf8": f"line {i}"}]} for i in range(5)]}


class Modes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = [mock.patch.object(server, "CACHE", pathlib.Path(self.tmp.name)),
                  mock.patch.object(server, "PACE", 0),
                  mock.patch.object(server, "LM_KEY", "k")]
        for p in self.p:
            p.start()
        self.calls = []
        self.verdict = {"look": False, "kind": "interview", "reason": "step 1"}

    def tearDown(self):
        for p in self.p:
            p.stop()
        self.tmp.cleanup()

    def fake_ytdlp(self, meta=META):
        def f(args, timeout):
            self.calls.append("dump" if "--dump-json" in args else "download")
            return json.dumps(meta)
        return f

    def fake_fetch(self, url):
        self.calls.append("caption")
        return json.dumps(JSON3)

    def run_t(self, meta=META, **kw):
        with mock.patch.object(server, "ytdlp", self.fake_ytdlp(meta)), \
             mock.patch.object(server, "fetch_url", self.fake_fetch), \
             mock.patch.object(server, "parakeet", lambda url: (self.calls.append("parakeet") or
                               {"source": "parakeet", "caption_lang": "", "paragraphs": [{"start": 0, "text": "p"}]})), \
             mock.patch.object(server, "on_screen", lambda url, d: (self.calls.append("slides") or
                               ([{"start": 15, "text": "slide"}], ""))), \
             mock.patch.object(server.vision, "decide_look", self.fake_decide):
            return server.transcript("https://youtu.be/abcdefghijk", **kw)

    def fake_decide(self, doc, key, base=None):
        self.calls.append("decide")
        if isinstance(self.verdict, Exception):
            raise self.verdict
        return dict(self.verdict)

    def test_default_is_two_requests_captions_only(self):
        out = self.run_t()
        self.assertEqual(self.calls, ["dump", "caption", "decide"])   # decide is local, not YouTube
        self.assertEqual(out["source"], "captions-auto")
        self.assertEqual(out["slides"], [])

    def test_second_time_costs_nothing(self):
        self.run_t()
        self.calls.clear()
        out = self.run_t()
        self.assertEqual(self.calls, [])
        self.assertTrue(out["cached"])

    def test_no_captions_is_reported_not_transcribed(self):
        out = self.run_t(meta={**META, "automatic_captions": {}})
        self.assertTrue(out["no_captions"])
        self.assertEqual(self.calls, ["dump"])

    def test_transcribe_after_no_captions_reuses_metadata(self):
        self.run_t(meta={**META, "automatic_captions": {}})
        self.calls.clear()
        out = self.run_t(transcribe=True)
        self.assertEqual(self.calls, ["parakeet", "decide"])   # a transcript, then the screen check
        self.assertEqual(out["source"], "parakeet")

    def test_slides_only_when_asked_and_only_once(self):
        self.run_t()
        self.calls.clear()
        out = self.run_t(slides=True)
        self.assertEqual(self.calls, ["slides"])
        self.assertEqual(out["slides"][0]["text"], "slide")
        self.calls.clear()
        self.run_t(slides=True)
        self.assertEqual(self.calls, [])

    def test_auto_look_reads_the_screen_once(self):
        self.verdict = {"look": True, "kind": "software tutorial", "reason": "rule 2"}
        out = self.run_t()
        self.assertEqual(self.calls, ["dump", "caption", "decide", "slides"])
        self.assertEqual(out["screen_note"], "screen read: software tutorial")
        self.calls.clear()
        out = self.run_t()                       # verdict and frames are cached
        self.assertEqual(self.calls, [])
        self.assertEqual(out["screen_note"], "screen read: software tutorial")

    def test_auto_skip_is_cached_and_says_why(self):
        out = self.run_t()
        self.assertEqual(out["screen_note"], "screen not read: interview")
        self.assertEqual(out["slides"], [])
        self.calls.clear()
        self.run_t()
        self.assertNotIn("decide", self.calls)

    def test_asking_for_slides_skips_the_check(self):
        out = self.run_t(slides=True)
        self.assertNotIn("decide", self.calls)
        self.assertEqual(out["screen_note"], "screen read: you asked")

    def test_failed_check_means_no_look_and_is_retried_next_time(self):
        self.verdict = RuntimeError("LM Studio down")
        out = self.run_t()
        self.assertNotIn("slides", self.calls)
        self.assertEqual(out["screen_note"], "screen not read: the check failed")
        self.verdict = {"look": True, "kind": "demo", "reason": "r"}
        self.calls.clear()
        self.run_t()
        self.assertEqual(self.calls, ["decide", "slides"])

    def test_no_captions_never_asks(self):
        self.run_t(meta={**META, "automatic_captions": {}})
        self.assertNotIn("decide", self.calls)

    def test_auto_false_skips_the_check(self):
        out = self.run_t(auto=False)
        self.assertNotIn("decide", self.calls)
        self.assertEqual(out["screen_note"], "")

    def test_bot_check_raises_blocked(self):
        r = mock.Mock(returncode=1, stdout="", stderr="ERROR: Sign in to confirm you're not a bot")
        with mock.patch.object(server.subprocess, "run", return_value=r):
            with self.assertRaises(server.Blocked):
                server.ytdlp(["--dump-json", "x"], timeout=5)


class Pacing(unittest.TestCase):
    def test_requests_are_spaced(self):
        with mock.patch.object(server, "PACE", 0.2):
            server._yt_last = 0
            t = time.time()
            for _ in range(3):
                server.paced(lambda: None)
            self.assertGreaterEqual(time.time() - t, 2 * 0.2 * 0.7)


if __name__ == "__main__":
    unittest.main()


class LookParsing(unittest.TestCase):
    def test_text_after_the_json_is_ignored(self):
        v = server.vision.parse_look({"content": '{"look": true, "kind": "demo", "reason": "r"}\n\n{"look": false}'})
        self.assertEqual(v, {"look": True, "kind": "demo", "reason": "r"})

    def test_json_stranded_in_reasoning_is_recovered(self):
        v = server.vision.parse_look({"content": "", "reasoning_content": 'thinking...\n{"look": false, "kind": "vlog", "reason": "step 1"}'})
        self.assertFalse(v["look"])
