"""Research Overseer media service — runs natively on Windows next to LM Studio.

n8n (in Docker) calls it at http://host.docker.internal:8765, bearer token
MEDIA_TOKEN from the repo .env. Native, not a container, because yt-dlp needs
this machine's home IP (YouTube blocks datacenter ranges outright) and Deno,
and Parakeet runs fine on the host CPU.

  POST /transcript {"url": ..., "slides": bool, "transcribe": bool}
  GET  /health

Modes (Wasim's choice, 2026-10-11):
  default     captions only — 2 YouTube requests (video page + one caption
              file). No captions -> {"no_captions": true}; the bot then asks
              him to reply "transcribe". Nothing is downloaded.
  transcribe  audio -> Parakeet on CPU (+1 request, ~0.05x real time)
  slides      720p video -> a frame every 30 s -> the 9B's vision (+1 request)

Protecting the IP without a cap: every YouTube request goes through one lock
with a paced gap (MEDIA_PACE_SECONDS, default 15, +/-30% jitter) — a steady
trickle, never a burst — and a cached video is never requested again.
A bot check is reported ({"blocked": true}) so the bot can tell him; there is
no automatic pause (his call).

Runs as the "media" container in docker/docker-compose.yml (restart:
unless-stopped, so it starts with Docker). A container's outbound requests leave
through this PC's home connection, so YouTube sees the same home IP.
Natively, for debugging: uv run python server.py (reads ../.env).
"""

import json, os, pathlib, random, re, shutil, subprocess, sys, tempfile, threading, time, urllib.request, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from transcript_utils import pick_caption_track, parse_json3, paragraphs, upload_iso
import vision

ROOT = pathlib.Path(__file__).resolve().parent
HOME = pathlib.Path.home()
os.environ["PATH"] = os.pathsep.join([str(HOME / ".deno" / "bin"), str(HOME / "bin"), os.environ.get("PATH", "")])
YTDLP = shutil.which("yt-dlp") or str(HOME / "bin" / "yt-dlp.exe")


def load_env():
    """Container: environment variables. Native: the repo .env fills the gaps."""
    env = {}
    dotenv = ROOT.parent / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    env.update({k: v for k, v in os.environ.items() if v})
    return env


ENV = load_env()
TOKEN = ENV.get("MEDIA_TOKEN", "")
PORT = int(ENV.get("MEDIA_PORT", "8765"))
MAX_SECONDS = int(ENV.get("MEDIA_MAX_SECONDS", str(3 * 3600)))
PACE = float(ENV.get("MEDIA_PACE_SECONDS", "15"))
SLIDES_MAX_SECONDS = int(ENV.get("MEDIA_SLIDES_MAX_SECONDS", str(45 * 60)))
LM_KEY = ENV.get("LMSTUDIO_API_KEY", "")
LM_BASE = ENV.get("LMSTUDIO_BASE", "http://localhost:1234")
CACHE = pathlib.Path(ENV.get("MEDIA_CACHE", str(ROOT / "cache")))
CACHE.mkdir(parents=True, exist_ok=True)
# Optional sign-in: a cookies.txt exported from a THROWAWAY Google account
# (never the main one — YouTube can ban the account it sees). Signed-in
# requests get far more headroom before a bot check. In the container it lives
# at /data/cookies.txt on the media_data volume; yt-dlp keeps it refreshed.
COOKIES = pathlib.Path(ENV.get("MEDIA_COOKIES", str(CACHE.parent / "cookies.txt")))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
BOT_CHECK = re.compile(r"confirm you.?re not a bot|sign in to confirm", re.I)
YT_ID = re.compile(r"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|embed/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})")

_asr = None
_asr_lock = threading.Lock()     # one transcription at a time: it uses every CPU core
_yt_lock = threading.Lock()      # one YouTube request at a time, paced
_yt_last = 0.0


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Blocked(Exception):
    pass


class NoCaptions(Exception):
    pass


def paced(fn):
    """Run one request to YouTube: wait for the lock, then for the gap."""
    global _yt_last
    with _yt_lock:
        gap = PACE * random.uniform(0.7, 1.3)
        wait = _yt_last + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        try:
            return fn()
        finally:
            _yt_last = time.time()


def ytdlp(args, timeout):
    def run():
        auth = ["--cookies", str(COOKIES)] if COOKIES.exists() else []
        return subprocess.run([YTDLP, "--no-warnings", "--no-playlist", *auth, *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=timeout)
    r = paced(run)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "yt-dlp failed").strip().splitlines()[-1][:300]
        if BOT_CHECK.search(r.stderr or ""):
            log("YouTube bot check")
            raise Blocked(err)
        raise RuntimeError(err)
    return r.stdout


def fetch_url(url):
    def run():
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8")
    return paced(run)


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
        raise NoCaptions("no captions")
    kind, lang, url = pick
    segs = parse_json3(json.loads(fetch_url(url)))
    if len(segs) < 3:
        raise NoCaptions(f"{kind} {lang} empty")
    return {"source": kind, "caption_lang": lang, "paragraphs": paragraphs(segs)}


def parakeet(url):
    with tempfile.TemporaryDirectory() as d:
        # "ba/b": some videos 403 on audio-only formats; fall back to the muxed one
        ytdlp(["-f", "ba/b", "-x", "--audio-format", "wav", "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",
               "-o", str(pathlib.Path(d) / "a.%(ext)s"), url], timeout=900)
        wav = next(pathlib.Path(d).glob("a.wav"))
        with wave.open(str(wav)) as w:
            dur = w.getnframes() / w.getframerate()
        with _asr_lock:
            t = time.time()
            segs = [{"start": round(s.start, 2), "text": s.text.strip()} for s in asr_model().recognize(str(wav)) if s.text.strip()]
            log(f"parakeet {dur/60:.1f} min of audio in {time.time()-t:.0f}s")
    return {"source": "parakeet", "caption_lang": "", "paragraphs": paragraphs(segs)}


def on_screen(url, duration):
    if not LM_KEY:
        return [], "no LM Studio key"
    if (duration or 0) > SLIDES_MAX_SECONDS:
        return [], "skipped: longer than %d min" % (SLIDES_MAX_SECONDS // 60)
    with tempfile.TemporaryDirectory() as d:
        ytdlp(["-f", "bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]/b",
               "-o", str(pathlib.Path(d) / "v.%(ext)s"), url], timeout=900)
        video = next(pathlib.Path(d).glob("v.*"))
        t = time.time()
        out = vision.slides(video, LM_KEY, base=LM_BASE)
        log(f"on-screen: {len(out)} informative frames in {time.time()-t:.0f}s")
        return out, ""


def cache_path(extractor, vid):
    return CACHE / f"{extractor}-{vid}.json"


def save(doc):
    cache_path(doc["extractor"], doc["id"]).write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")


def transcript(url, slides=False, transcribe=False):
    doc = None
    m = YT_ID.search(url)
    if m and cache_path("Youtube", m.group(1)).exists():
        doc = json.loads(cache_path("Youtube", m.group(1)).read_text(encoding="utf-8"))
        doc["cached"] = True

    if doc is None:
        meta = json.loads(ytdlp(["--skip-download", "--dump-json", url], timeout=120))
        dur = meta.get("duration") or 0
        if dur and dur > MAX_SECONDS:
            raise ValueError(f"too long: {dur/60:.0f} min (limit {MAX_SECONDS/60:.0f})")
        doc = {
            "id": meta.get("id") or "x", "url": meta.get("webpage_url") or url, "extractor": meta.get("extractor_key", "web"),
            "title": meta.get("title", ""), "channel": meta.get("channel") or meta.get("uploader") or "",
            "duration": dur, "published_at": upload_iso(meta.get("upload_date")), "language": meta.get("language") or "",
            "description": (meta.get("description") or "")[:1500],
            "chapters": [{"start": c.get("start_time", 0), "title": c.get("title", "")} for c in (meta.get("chapters") or [])],
            "source": "", "paragraphs": [], "slides": None,
        }
        if not transcribe:
            try:
                doc.update(captions(meta))
            except NoCaptions as e:
                doc["caption_note"] = str(e)
        save(doc)   # metadata is worth keeping even without a transcript: no re-ask

    changed = False
    if transcribe and doc.get("source") != "parakeet":
        doc.update(parakeet(doc["url"]))
        changed = True
    if slides and not doc.get("slides"):
        doc["slides"], doc["slides_note"] = on_screen(doc["url"], doc.get("duration"))
        changed = True
    if changed:
        save(doc)

    if not doc.get("paragraphs"):
        return {**{k: doc[k] for k in ("id", "url", "title", "channel", "duration")}, "no_captions": True,
                "note": doc.get("caption_note", "no captions")}
    out = dict(doc)
    out["slides"] = out.get("slides") or []
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
                                    "deno": bool(shutil.which("deno")), "asr_loaded": _asr is not None, "pace_s": PACE,
                                    "signed_in": COOKIES.exists()})
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
        slides, transcribe = bool(body.get("slides")), bool(body.get("transcribe"))
        t = time.time()
        try:
            out = transcript(url, slides=slides, transcribe=transcribe)
            log(f"{out['id']} {'no captions' if out.get('no_captions') else out['source']}"
                f"{' +slides' if slides else ''}{' (cached)' if out.get('cached') else ''} {time.time()-t:.1f}s")
            self._send(200, out)
        except Blocked as e:
            self._send(502, {"error": "YouTube bot check: " + str(e), "blocked": True})
        except Exception as e:
            log("FAILED", url, e)
            self._send(502, {"error": str(e)[:400]})


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("MEDIA_TOKEN missing from .env")
    # 0.0.0.0 so the n8n container reaches it via host.docker.internal; the
    # bearer token gates it, and like n8n this must never be port-forwarded.
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"media service on :{PORT}  pace {PACE:g}s  yt-dlp={YTDLP}")
    srv.serve_forever()
