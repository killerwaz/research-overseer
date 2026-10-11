import unittest
from transcript_utils import pick_caption_track, parse_json3, paragraphs, ts, upload_iso


def tracks(*urls):
    return [{"ext": "vtt", "url": "v"}] + [{"ext": "json3", "url": u} for u in urls]


class PickTrack(unittest.TestCase):
    def test_manual_beats_auto(self):
        meta = {"language": "en", "subtitles": {"en-US": tracks("M")}, "automatic_captions": {"en-orig": tracks("A")}}
        self.assertEqual(pick_caption_track(meta), ("captions-manual", "en-US", "M"))

    def test_auto_uses_original_not_translated(self):
        meta = {"language": "en", "subtitles": {}, "automatic_captions": {"fr": tracks("FR"), "en": tracks("EN"), "en-orig": tracks("ORIG")}}
        self.assertEqual(pick_caption_track(meta), ("captions-auto", "en-orig", "ORIG"))

    def test_ignores_live_chat_and_foreign_manual(self):
        meta = {"language": "en", "subtitles": {"live_chat": tracks("L"), "de": tracks("D")}, "automatic_captions": {"en-orig": tracks("A")}}
        self.assertEqual(pick_caption_track(meta)[0], "captions-auto")

    def test_none_when_no_captions(self):
        self.assertIsNone(pick_caption_track({"language": "en"}))


class Parse(unittest.TestCase):
    def test_json3(self):
        doc = {"events": [{"tStartMs": 0}, {"tStartMs": 1500, "segs": [{"utf8": "hello"}, {"utf8": " world\n"}]},
                          {"tStartMs": 2000, "segs": [{"utf8": "\n"}]}]}
        self.assertEqual(parse_json3(doc), [{"start": 1.5, "text": "hello world"}])

    def test_paragraphs_merge_by_time(self):
        segs = [{"start": t, "text": f"s{t}"} for t in (0, 10, 20, 31, 40, 70)]
        self.assertEqual(paragraphs(segs, every=30), [
            {"start": 0, "text": "s0 s10 s20 s31"}, {"start": 40, "text": "s40 s70"}])

    def test_ts_and_dates(self):
        self.assertEqual(ts(65), "1:05")
        self.assertEqual(ts(3725), "1:02:05")
        self.assertEqual(upload_iso("20261009"), "2026-10-09")
        self.assertEqual(upload_iso(None), "")


if __name__ == "__main__":
    unittest.main()
