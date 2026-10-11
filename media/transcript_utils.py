"""Pure helpers for the media service: caption-track choice, json3 parsing,
paragraphing, timestamps. No I/O, so tests/test_transcript_utils.py covers
exactly what the server runs."""

import re


def pick_caption_track(meta):
    """Best caption track for a yt-dlp info dict, or None.

    Order (measured 2026-10-10 against human captions on two videos: YouTube
    auto-captions missed 1.2-2.0% of words, Parakeet 0.7-3.3%):
      1. human captions in the video's language (or English)
      2. auto-captions in the ORIGINAL language ("<lang>-orig") — never the
         machine-translated tracks: requesting those too ("en.*") is what drew
         a 429 after six videos.
    Returns (kind, lang, url) with kind 'captions-manual' | 'captions-auto'.
    """
    lang = (meta.get("language") or "en").split("-")[0].lower()
    manual = meta.get("subtitles") or {}
    auto = meta.get("automatic_captions") or {}

    def json3(tracks):
        for t in tracks or []:
            if t.get("ext") == "json3" and t.get("url"):
                return t["url"]
        return None

    for key in sorted(manual, key=lambda k: (not k.lower().startswith(lang), k)):
        base = key.split("-")[0].lower()
        if key == "live_chat" or base not in (lang, "en"):
            continue
        url = json3(manual[key])
        if url:
            return ("captions-manual", key, url)
    for key in (lang + "-orig", "en-orig", lang):
        url = json3(auto.get(key))
        if url:
            return ("captions-auto", key, url)
    return None


def parse_json3(doc):
    """YouTube json3 caption document -> [{start, text}] (seconds, cleaned)."""
    out = []
    for ev in doc.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        text = "".join(s.get("utf8", "") for s in segs).replace("\n", " ")
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue
        out.append({"start": round(ev.get("tStartMs", 0) / 1000, 2), "text": text})
    return out


def paragraphs(segments, every=30.0):
    """Merge short segments into ~`every`-second paragraphs, each keeping the
    start time of its first segment. Fewer timestamps = fewer tokens, and 30s
    is fine-grained enough for a link that jumps to the right moment."""
    out, cur, start = [], [], None
    for s in segments:
        if start is None:
            start = s["start"]
        cur.append(s["text"].strip())
        if s["start"] - start >= every:
            out.append({"start": start, "text": " ".join(cur)})
            cur, start = [], None
    if cur:
        out.append({"start": start, "text": " ".join(cur)})
    return out


def ts(seconds):
    s = int(seconds or 0)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def upload_iso(upload_date):
    """yt-dlp 'YYYYMMDD' -> 'YYYY-MM-DD' (or '')."""
    d = str(upload_date or "")
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}" if re.fullmatch(r"\d{8}", d) else ""
