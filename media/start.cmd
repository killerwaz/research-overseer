@echo off
rem Starts the Research Overseer media service (YouTube/podcast transcripts,
rem Parakeet speech-to-text, on-screen frame descriptions) on port 8765.
rem Needs: uv, ffmpeg, yt-dlp (%USERPROFILE%\bin), Deno (%USERPROFILE%\.deno\bin),
rem LM Studio running for on-screen descriptions. Token: MEDIA_TOKEN in ..\.env
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
uv run python server.py
