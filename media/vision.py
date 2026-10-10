"""On-screen content for the media service: sample frames, drop near-duplicates,
ask the local 9B (vision via its mmproj) what each informative frame shows.

Scene-change detection was measured and rejected (2026-10-10): a whiteboard
video that builds one drawing gave 1 frame, a screen recording 2, a fast-cut
explainer 54. A frame every 30 s, deduplicated, fits all three.
"""

import base64, json, pathlib, shutil, subprocess, tempfile, urllib.request

from PIL import Image

PROMPT = (
    "This is a frame from a video. If it shows information worth noting — a slide, chart, diagram, "
    "table, code, terminal, document, web page or other readable on-screen text — describe that "
    "information concretely in at most 60 words: transcribe titles, key numbers, labels and code identifiers. "
    "Copy every number exactly as shown, with the label it belongs to; never combine separate labels into one claim. "
    "If it only shows a person talking, b-roll, an intro card, a logo or nothing readable, reply exactly NONE."
)


def fingerprint(path):
    """16x16 grayscale thumbnail as a flat list — cheap near-duplicate test."""
    with Image.open(path) as im:
        return list(im.convert("L").resize((16, 16)).getdata())


def differs(a, b, threshold=12.0):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a) > threshold


def sample_frames(video, every=30, max_frames=24):
    """[(seconds, jpg_path)] — one frame per `every` s, near-duplicates dropped."""
    out_dir = pathlib.Path(tempfile.mkdtemp(prefix="frames_"))
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
                    "-vf", f"fps=1/{every},scale=1024:-2", "-q:v", "3", str(out_dir / "f_%04d.jpg")],
                   check=True, timeout=600)
    frames, last = [], None
    for i, p in enumerate(sorted(out_dir.glob("f_*.jpg"))):
        fp = fingerprint(p)
        if last is None or differs(fp, last):
            # fps=1/N emits its first frame at N/2 s, then every N s
            frames.append((round(every / 2 + i * every, 1), p))
            last = fp
    if len(frames) > max_frames:   # keep an even spread, not just the start
        step = len(frames) / max_frames
        frames = [frames[int(k * step)] for k in range(max_frames)]
    return frames


def describe(path, api_key, model="qwen/qwen3.5-9b", base="http://localhost:1234"):
    b64 = base64.b64encode(pathlib.Path(path).read_bytes()).decode()
    body = {"model": model, "temperature": 0.1, "max_tokens": 300, "reasoning_effort": "none",
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}}]}]}
    req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key})
    with urllib.request.urlopen(req, timeout=180) as r:
        msg = json.loads(r.read())["choices"][0]["message"]
    text = (msg.get("content") or "").strip()
    return None if not text or text.upper().startswith("NONE") else " ".join(text.split())


def slides(video, api_key, **kw):
    """[{start, text}] for informative frames, consecutive repeats merged."""
    out, frames = [], sample_frames(video, **kw)
    try:
        for start, p in frames:
            text = describe(p, api_key)
            if text and not (out and out[-1]["text"] == text):
                out.append({"start": start, "text": text})
    finally:
        if frames:
            shutil.rmtree(frames[0][1].parent, ignore_errors=True)
    return out
