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


def slides(video, api_key, base="http://localhost:1234", **kw):
    """[{start, text}] for informative frames, consecutive repeats merged."""
    out, frames = [], sample_frames(video, **kw)
    try:
        for start, p in frames:
            text = describe(p, api_key, base=base)
            if text and not (out and out[-1]["text"] == text):
                out.append({"start": start, "text": text})
    finally:
        if frames:
            shutil.rmtree(frames[0][1].parent, ignore_errors=True)
    return out


# ---- should the screen be read at all? (2026-10-11) ----
# Asked once per video, after the transcript exists, when the user did not type
# a slides word. Prompt v3 scored 10/10 on Wasim's labelled set (7 look: the
# tutorials, demos and technical explainers; 3 skip: two interviews and a vlog).
# The video TYPE is decided first: v2, without that step, read a vlog's "let me
# show you the game room" as a reason to look.
LOOK_PROMPT = """You decide whether a video summariser should also look at a video's frames, or whether its transcript is enough.
Step 1 - what kind of video is it?
  If it is a conversation, interview, podcast, panel, vlog or opinion piece -> look=false,
  UNLESS most of it is a screen demo or slides (then continue to step 2).
  Everyday phrases like "let me show you" in a vlog do NOT count as a screen demo.
Step 2 - otherwise, look=true if ANY of these is true:
  1. The speaker refers to something visible ("as you can see", "this chart", "click", "on screen", any language).
  2. It is a software demo, tutorial or screen recording.
  3. It explains how a technical system works (architecture, mechanism, how a model or product works).
  If none applies -> look=false.
The transcript can be in any language. 'kind' is the video type from step 1 in 2-4 plain English words
(e.g. "software tutorial", "technical explainer", "interview", "vlog"). In 'reason', name the rule that decided it."""

LOOK_SCHEMA = {"type": "json_schema", "json_schema": {"name": "look_decision", "strict": True, "schema": {
    "type": "object", "additionalProperties": False, "required": ["look", "kind", "reason"],
    "properties": {"look": {"type": "boolean"}, "kind": {"type": "string"}, "reason": {"type": "string"}}}}}


def look_input(doc, max_chars=24000):
    lines = ["[%d:%02d] %s" % (int(p["start"]) // 60, int(p["start"]) % 60, p["text"]) for p in doc.get("paragraphs") or []]
    return (f"TITLE: {doc.get('title', '')}\nCHANNEL: {doc.get('channel', '')}\n"
            f"DURATION: {round((doc.get('duration') or 0) / 60)} min\nDESCRIPTION: {(doc.get('description') or '')[:800]}\n\n"
            "TRANSCRIPT:\n" + "\n".join(lines)[:max_chars])


def parse_look(msg):
    """The JSON answer from content, or from reasoning_content when thinking overran the budget."""
    # The first complete object wins: the 9B sometimes writes text after it.
    text = (msg.get("content") or "").strip()
    if "{" in text:
        o = json.JSONDecoder().raw_decode(text[text.index("{"):])[0]
    else:
        tail = msg.get("reasoning_content") or ""
        o = json.JSONDecoder().raw_decode(tail[tail.rindex("{"):])[0]
    return {"look": bool(o["look"]), "kind": " ".join(str(o.get("kind", "")).split())[:40],
            "reason": " ".join(str(o.get("reason", "")).split())[:300]}


def decide_look(doc, api_key, model="qwen/qwen3.5-9b", base="http://localhost:1234"):
    """{"look": bool, "kind": str, "reason": str}. Thinking on: the type judgement is the point."""
    body = {"model": model, "temperature": 0.2, "max_tokens": 6000, "reasoning_effort": "medium",
            "response_format": LOOK_SCHEMA,
            "messages": [{"role": "system", "content": LOOK_PROMPT}, {"role": "user", "content": look_input(doc)}]}
    req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key})
    with urllib.request.urlopen(req, timeout=300) as r:
        return parse_look(json.loads(r.read())["choices"][0]["message"])
