# Research Overseer media service. Built and started by docker/docker-compose.yml.
FROM python:3.12-slim

# ffmpeg: audio extraction + frame sampling. unzip: the Deno installer needs it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Deno: yt-dlp runs YouTube's player JavaScript with it (required since 2025.11).
ENV DENO_INSTALL=/opt/deno
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y \
 && ln -s /opt/deno/bin/deno /usr/local/bin/deno

# yt-dlp[default] includes yt-dlp-ejs, the scripts it feeds to Deno. Rebuild the
# image to update yt-dlp when YouTube changes something:
#   docker compose -f docker/docker-compose.yml build --no-cache media
RUN pip install --no-cache-dir "yt-dlp[default]" "onnx-asr[cpu,hub]>=0.12" "pillow>=12"

WORKDIR /app
COPY server.py vision.py transcript_utils.py ./

# Parakeet (~650 MB) downloads on first use into HF_HOME, which lives on the
# media_data volume with the transcript cache, so it survives rebuilds.
ENV HF_HOME=/data/hf \
    MEDIA_CACHE=/data/cache \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8

EXPOSE 8765
CMD ["python", "server.py"]
