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
                  mock.patch.object(server, "PACE", 0)]
        for p in self.p:
            p.start()
        self.calls = []

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
                               ([{"start": 15, "text": "slide"}], ""))):
            return server.transcript("https://youtu.be/abcdefghijk", **kw)

    def test_default_is_two_requests_captions_only(self):
        out = self.run_t()
        self.assertEqual(self.calls, ["dump", "caption"])
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
        self.assertEqual(self.calls, ["parakeet"])
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
