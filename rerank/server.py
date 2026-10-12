"""Passage reranker for WF-31 (Fix 1d, on trial since 2026-10-12).

Qwen3-Reranker-0.6B scores how well each passage answers the question: the
probability the model answers "yes" to "does this document meet the query?".
CPU only (the 12 GB GPU belongs to the 9B). The search finds candidates; this
reorders them.

POST /rerank  {"query": "...", "documents": ["...", ...]}  -> {"scores": [0..1, ...]}
GET  /health
Bearer MEDIA_TOKEN (same as the media service). Native: reads ../.env.
Run: UV_PROJECT_ENVIRONMENT=<outside OneDrive> uv run python server.py
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).resolve().parent


def load_env():
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
MODEL_ID = ENV.get("RERANK_MODEL", "Qwen/Qwen3-Reranker-0.6B")
HOST = ENV.get("RERANK_HOST", "0.0.0.0")
PORT = int(ENV.get("RERANK_PORT", "8766"))
MAX_LEN = int(ENV.get("RERANK_MAX_LEN", "512"))   # tokens per question+passage; the tail is cut
INSTRUCT = "Given a question, judge whether this passage from a news article, report or video transcript answers it"

# Prompt format from the model card.
PREFIX = ("<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the "
          "Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n<|im_start|>user\n")
SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"

torch.set_num_threads(max(1, (os.cpu_count() or 4) - 2))
tok = AutoTokenizer.from_pretrained(MODEL_ID, padding_side="left")
model = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float32).eval()
if ENV.get("RERANK_INT8", "1") == "1":   # ~2x faster on CPU; scores checked against fp32 in the eval
    model = torch.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
YES, NO = tok.convert_tokens_to_ids("yes"), tok.convert_tokens_to_ids("no")
PRE_IDS = tok.encode(PREFIX, add_special_tokens=False)
SUF_IDS = tok.encode(SUFFIX, add_special_tokens=False)
LOCK = threading.Lock()


def score(query, documents):
    pairs = [f"<Instruct>: {INSTRUCT}\n<Query>: {query}\n<Document>: {d}" for d in documents]
    enc = tok(pairs, padding=False, truncation=True, return_attention_mask=False,
              max_length=MAX_LEN - len(PRE_IDS) - len(SUF_IDS))
    ids = [PRE_IDS + x + SUF_IDS for x in enc["input_ids"]]
    batch = tok.pad({"input_ids": ids}, padding=True, return_tensors="pt")
    with LOCK, torch.no_grad():
        logits = model(**batch).logits[:, -1, :]
    pair = torch.stack([logits[:, NO], logits[:, YES]], dim=1)
    return torch.nn.functional.log_softmax(pair, dim=1)[:, 1].exp().tolist()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": MODEL_ID})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not TOKEN or self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
            return self._send(401, {"error": "unauthorized"})
        if self.path != "/rerank":
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        query = str(body.get("query") or "").strip()
        docs = [str(d or "") for d in (body.get("documents") or [])][:40]
        if not query or not docs:
            return self._send(200, {"scores": [0.0] * len(docs)})
        t = time.time()
        try:
            s = score(query, docs)
        except Exception as e:
            return self._send(500, {"error": str(e)[:300]})
        print(f"rerank {len(docs)} docs {time.time()-t:.1f}s", flush=True)
        self._send(200, {"scores": s, "seconds": round(time.time() - t, 2)})


if __name__ == "__main__":
    print(f"rerank on {HOST}:{PORT} ({MODEL_ID})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
