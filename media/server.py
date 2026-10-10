"""Research Overseer media service — runs natively on Windows next to LM Studio.

n8n (in Docker) calls it at http://host.docker.internal:8765, bearer token
MEDIA_TOKEN from the repo .env. Native, not a container, because yt-dlp needs
this machine's home IP (YouTube blocks caption fetches from datacenter ranges)
and Deno, and Parakeet runs fine on the host CPU.

  POST /transcript {"url": ...}  -> metadata + timestamped paragraphs
  GET  /health

Route per link, cheapest first:
  human captions -> auto-captions (original language only) -> Parakeet on audio.
A caption fetch that fails (429 included) falls through to Parakeet, so a rate
limit costs ~1 minute instead of the request.

Run: uv run python server.py   (from media/)
"""

import json, os, pathlib, re, shutil, subprocess, sys, tempfile, threading, time, urllib.request, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from transcript_utils import pick_caption_track, parse_json3, paragraphs, upload_iso
import vision

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / "cache"
CACHE.mkdir(exist_ok=True)
HOME = pathlib.Path.home()
os.environ["PATH"] = os.pathsep.join([str(HOME / ".deno" / "bin"), str(HOME / "bin"), os.environ.get("PATH", "")])
YTDLP = shutil.which("yt-dlp") or str(HOME / "bin" / "yt-dlp.exe")


def load_env():
    env = {}
    for line in (ROOT.parent / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


ENV = load_env()
TOKEN = ENV.get("MEDIA_TOKEN", "")
PORT = int(ENV.get("MEDIA_PORT", "8765"))
MAX_SECONDS = int(ENV.get("MEDIA_MAX_SECONDS", str(3 * 3600)))
# On-screen content (slides, charts, code) costs ~3-4 s per sampled frame on
# the 9B; capped at 24 frames, so <= ~90 s. Skipped for long videos.
SLIDES = ENV.get("MEDIA_SLIDES", "1") == "1"
SLIDES_MAX_SECONDS = int(ENV.get("MEDIA_SLIDES_MAX_SECONDS", str(45 * 60)))
LM_KEY = ENV.get("LMSTUDIO_API_KEY", "")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"

# YouTube bot-check backoff (2026-10-10: ~50 requests in two hours from this
# home IP earned "Sign in to confirm you're not a bot" on every call, metadata
# included, so the Parakeet fallback could not help either). Once seen, stop
# asking for BLOCK_HOURS: retrying only extends a soft block.
BLOCK_HOURS = float(ENV.get("MEDIA_BLOCK_HOURS", "6"))
BLOCK_FILE = CACHE / "_youtube_blocked_until"
BOT_CHECK = re.compile(r"confirm you.?re not a bot|sign in to confirm", re.I)
YT_ID = re.compile(r"(?:youtube.com/(?:watch?(?:[^#]*&)?v=|shorts/|embed/|live/)|youtu.be/)([A-Za-z0-9_-]{11})")


def blocked_until():
    try:
        return float(BLOCK_FILE.read_text())
    except Exception:
        return 0.0


class Blocked(Exception):
    pass


_asr = None
_asr_lock = threading.Lock()   # one transcription at a time: it uses every CPU core


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def ytdlp(args, timeout):
    if time.time() < blocked_until():
        raise Blocked("YouTube is blocking this machine (bot check); retrying after " +
                      time.strftime("%H:%M", time.localtime(blocked_until())))
    r = subprocess.run([YTDLP, "--no-warnings", "--no-playlist", *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    if r.returncode != 0 and BOT_CHECK.search(r.stderr or ""):
        BLOCK_FILE.write_text(str(time.time() + BLOCK_HOURS * 3600))
        log(f"YouTube bot check hit: backing off {BLOCK_HOURS:g} h")
        raise Blocked("YouTube is blocking this machine (bot check); backing off %g h" % BLOCK_HOURS)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "yt-dlp failed").strip().splitlines()[-1][:300])
    return r.stdout


def asr_model():
    global _asr
    if _asr is None:
        import onnx_asr
        vad = onnx_asr.load_vad("silero")
        _asr = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", quantization="int8").with_vad(vad)
    return _asr


def captions(meta):
    pick = pick_caption_track(meta)
    if not pick:
        return None, "no captions"
    kind, lang, url = pick
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            segs = parse_json3(json.loads(r.read().decode("utf-8")))
        if len(segs) < 3:
            return None, f"{kind} {lang}: empty"
        return {"source": kind, "caption_lang": lang, "segments": segs}, None
    except Exception as e:   # 429, 403, network — Parakeet takes over
        return None, f"{kind} {lang}: {e}"


def parakeet(url):
    with tempfile.TemporaryDirectory() as d:
        out = pathlib.Path(d) / "a.%(ext)s"
        # "ba/b": some videos 403 on audio-only formats; fall back to the muxed one
        ytdlp(["-f", "ba/b", "-x", "--audio-format", "wav", "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",
               "-o", str(out), url], timeout=600)
        wav = next(pathlib.Path(d).glob("a.wav"))
        with wave.open(str(wav)) as w:
            dur = w.getnframes() / w.getframerate()
        with _asr_lock:
            t = time.time()
            segs = [{"start": round(s.start, 2), "text": s.text.strip()} for s in asr_model().recognize(str(wav)) if s.text.strip()]
            log(f"parakeet {dur/60:.1f}min audio in {time.time()-t:.0f}s")
    return {"source": "parakeet", "caption_lang": "", "segments": segs}


def on_screen(url, meta):
    """[{start, text}] for videos; [] for audio, long videos, or on any failure."""
    if not SLIDES or not LM_KEY or (meta.get("vcodec") in (None, "none") and not meta.get("height")):
        return [], "skipped"
    if (meta.get("duration") or 0) > SLIDES_MAX_SECONDS:
        return [], "skipped: longer than %d min" % (SLIDES_MAX_SECONDS // 60)
    try:
        with tempfile.TemporaryDirectory() as d:
            ytdlp(["-f", "bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]/b", "-o", str(pathlib.Path(d) / "v.%(ext)s"), url], timeout=600)
            video = next(pathlib.Path(d).glob("v.*"))
            t = time.time()
            out = vision.slides(video, LM_KEY)
            log(f"on-screen: {len(out)} informative frames in {time.time()-t:.0f}s")
            return out, ""
    except Exception as e:
        log("on-screen FAILED", e)
        return [], f"failed: {e}"[:200]


def transcript(url, force_asr=False):
    # A cached video costs no YouTube request at all.
    m = YT_ID.search(url)
    if m and not force_asr:
        hit = CACHE / f"Youtube-{m.group(1)}.json"
        if hit.exists():
            cached = json.loads(hit.read_text(encoding="utf-8"))
            if "slides" in cached:
                return cached
    meta = json.loads(ytdlp(["--skip-download", "--dump-json", url], timeout=120))
    vid = meta.get("id") or "x"
    key = CACHE / f"{meta.get('extractor_key', 'web')}-{vid}.json"
    if key.exists() and not force_asr:
        cached = json.loads(key.read_text(encoding="utf-8"))
        if "slides" in cached:
            return cached
        cached["slides"], cached["slides_note"] = on_screen(cached["url"], meta)
        key.write_text(json.dumps(cached, ensure_ascii=False), encoding="utf-8")
        return cached
    dur = meta.get("duration") or 0
    if dur and dur > MAX_SECONDS:
        raise ValueError(f"too long: {dur/60:.0f} min (limit {MAX_SECONDS/60:.0f})")
    got, why = (None, "forced") if force_asr else captions(meta)
    if not got:
        log(f"{vid}: {why} -> parakeet")
        got = parakeet(meta.get("webpage_url") or url)
        got["caption_note"] = why
    out = {
        "id": vid, "url": meta.get("webpage_url") or url, "extractor": meta.get("extractor_key", ""),
        "title": meta.get("title", ""), "channel": meta.get("channel") or meta.get("uploader") or "",
        "duration": dur, "published_at": upload_iso(meta.get("upload_date")), "language": meta.get("language") or "",
        "description": (meta.get("description") or "")[:1500],
        "chapters": [{"start": c.get("start_time", 0), "title": c.get("title", "")} for c in (meta.get("chapters") or [])],
        **got,
        "paragraphs": paragraphs(got["segments"]),
    }
    out["slides"], out["slides_note"] = on_screen(out["url"], meta)
    del out["segments"]
    if not force_asr:
        key.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "ytdlp": bool(shutil.which("yt-dlp") or pathlib.Path(YTDLP).exists()),
                                    "deno": bool(shutil.which("deno")), "asr_loaded": _asr is not None})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not TOKEN or self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
            return self._send(401, {"error": "unauthorized"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        if self.path != "/transcript":
            return self._send(404, {"error": "not found"})
        url = str(body.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            return self._send(400, {"error": "url required"})
        t = time.time()
        try:
            out = transcript(url, force_asr=bool(body.get("force_asr")))
            log(f"transcript {out['id']} {out['source']} {len(out['paragraphs'])} paras {time.time()-t:.1f}s")
            self._send(200, out)
        except Exception as e:
            log("transcript FAILED", url, e)
            self._send(502, {"error": str(e)[:400]})


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("MEDIA_TOKEN missing from .env")
    # 0.0.0.0 so the n8n container reaches it via host.docker.internal; the
    # bearer token gates it, and like n8n this must never be port-forwarded.
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"media service on :{PORT}  yt-dlp={YTDLP}")
    srv.serve_forever()
