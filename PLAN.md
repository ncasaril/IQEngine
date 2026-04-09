# IQEngine Realtime SDR & Server-Side Processing — Plan & Status

This document tracks the implementation plan for extending IQEngine with:
1. Server-side spectrogram tiles (offload FFT to backend)
2. Live SDR capture via SoapySDR (HackRF, RTL-SDR, PlutoSDR)
3. Structured REST API for AI agent consumption (MCP-ready)

## Current Status: Milestones 1–7 shipped & verified end-to-end with a real HackRF One

Commits on `main`:
- `617e2b0` — initial implementation of all three components (M1–M7)
- `165f052` — SoapySDR `enumerate()` segfault fix (use `asdict()`)
- `7531686` — SDR capture auto-register + agent router ordering fix

---

## Verified working (as of 2026-04-10 on n20 with HackRF One)

- `GET /api/sdr/devices` lists HackRF One via SoapySDR Python bindings (built from source against pyenv Python 3.11)
- `POST /api/sdr/capture` → writes SigMF to `$IQENGINE_BACKEND_LOCAL_FILEPATH/sdr_captures/` and auto-registers in the metadata DB
- `/sdr` page: can trigger capture, see live status polling, and device info
- Captured recording opens in recording-view and renders in both client-side and server-side FFT modes
- Server-side FFT matches client-side (dB formula: `10*log10(|X/N|)`, matches the client's per-row JS calculation)
- `/api/agent/recordings/.../analysis` detects all 4 synthetic tones in the test recording at the expected frequency offsets
- `/api/agent/recordings/.../spectrogram` returns base64 PNG with axis metadata
- Agent route ordering: specific sub-routes (`/spectrogram`, `/analysis`, `/annotations`) must come before the greedy `/recordings/{a}/{c}/{filepath:path}` — fixed in commit 7531686

---

## Architecture Summary

```
┌─────────────────────┐     HTTP + tiles   ┌──────────────────────┐
│  React SPA (Vite)   │ ◄───────────────► │  FastAPI (api/)       │
│  - Client-side FFT  │  PNG tile stream   │  - iq_router          │
│  - Server-tile path │                    │  - spectrogram_router │
│  - /sdr page        │                    │  - sdr_router (flag)  │
│  port 3000          │                    │  - agent_router       │
└─────────────────────┘                    │  - datasources        │
                                           │  port 5000            │
                                           └──────────┬───────────┘
                                                      │
                                    ┌─────────────────┼─────────────────┐
                                    ▼                 ▼                 ▼
                             ┌────────────┐  ┌──────────────┐  ┌─────────────┐
                             │ Storage    │  │ SoapySDR     │  │ MongoDB     │
                             │ (local/S3/ │  │ (HackRF/     │  │ (in-memory  │
                             │  Azure)    │  │  RTL-SDR/    │  │  for dev)   │
                             └────────────┘  │  PlutoSDR)   │  └─────────────┘
                                             └──────────────┘
```

---

## Files changed / added

### Backend
- `api/main.py` — registers new routers, SDR router behind `IQENGINE_SDR_ENABLED=1` feature flag
- `api/helpers/spectrogram_engine.py` — vectorized FFT, colormap LUT, PNG encoder
- `api/app/spectrogram_router.py` — `/spectrogram/info` and `/spectrogram/tile/{zoom}/{time_index}`
- `api/app/sdr_device.py` — abstract `SDRDeviceBase` + `MockSDRDevice` + `SoapySDRDevice`
- `api/app/sdr_monitor.py` — `MonitorRunner` thread with rolling segments, retune queue, eviction
- `api/app/sdr_router.py` — 8 endpoints, auto-registers captures in metadata DB
- `api/app/agent_models.py` — Pydantic models with `Field(description=...)`
- `api/app/agent_analysis.py` — signal detection (threshold above noise floor + connected regions)
- `api/app/agent_router.py` — 14 agent endpoints under `/api/agent/`

### Frontend
- `client/src/api/iqdata/TileClient.ts` — fetches PNG tiles → `ImageBitmap`
- `client/src/pages/recording-view/hooks/use-server-spectrogram.tsx` — visible-tile calculation + compositing onto `OffscreenCanvas`
- `client/src/pages/recording-view/hooks/use-spectrogram-context.tsx` — added `serverSideFFT` toggle
- `client/src/pages/recording-view/components/settings-pane.tsx` — UI toggle for Server-Side FFT
- `client/src/pages/recording-view/recording-view.tsx` — conditional client/server image rendering
- `client/src/pages/sdr/sdr-page.tsx` — full SDR control page with capture + monitoring forms
- `client/src/hooks/use-router.tsx` — added `/sdr` route

---

## How to run locally (on n20)

### First-time setup

```bash
# API (Python 3.11 via pyenv because repo uses PEP 604/695 syntax)
cd /home/niklas/git/IQEngine/api
~/.pyenv/versions/3.11.14/bin/python -m venv .venv
.venv/bin/pip install -r requirements.txt

# SoapySDR Python 3.11 bindings (apt's python3-soapysdr is Python 3.8)
# Already built in /tmp/soapybuild, copied to .venv/lib/python3.11/site-packages/
# Source: https://github.com/pothosware/SoapySDR/archive/refs/tags/soapy-sdr-0.7.2.tar.gz
# Key cmake flags: -DENABLE_LIBRARY=ON -DBUILD_PYTHON3=ON -DPYTHON3_EXECUTABLE=...
#                  -DPYTHON3_INCLUDE_DIR=... -DPYTHON3_LIBRARY=...
# See docs/sdr-setup-n20.md (to be written) if bindings need rebuilding

# Frontend
cd /home/niklas/git/IQEngine/client
source ~/.nvm/nvm.sh && nvm use 22
npm install
```

### `.env` file at `api/.env`

```
IN_MEMORY_DB=1
IQENGINE_BACKEND_LOCAL_FILEPATH="/tmp/iqengine_testdata"
IQENGINE_CONNECTION_INFO={"settings": [{"name": "Local Test Data", "containerName": "local", "accountName": "local", "description": "Local test recordings"}]}
IQENGINE_FEATURE_FLAGS={"displayIQEngineGitHub": true}
IQENGINE_SDR_ENABLED=1
SOAPY_SDR_PLUGIN_PATH=/usr/lib/x86_64-linux-gnu/SoapySDR/modules0.7
```

### Start both servers

```bash
# In one tmux session:
cd /home/niklas/git/IQEngine/api && .venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 5000

# In another:
cd /home/niklas/git/IQEngine/client && npm start -- --host
```

### Browse to

- http://n20:3000/sdr — SDR control, live capture from HackRF
- http://n20:3000/recordings/api/local/local — recording browser
- http://n20:3000/view/api/local/local/multi_signal_915MHz — synthetic multi-signal test recording
- http://n20:5000/api_docs — FastAPI Swagger UI

### Useful API calls

```bash
curl http://n20:5000/api/sdr/devices | jq
curl -X POST http://n20:5000/api/sdr/capture -H 'Content-Type: application/json' \
  -d '{"center_freq":915e6,"sample_rate":2e6,"gain":40,"duration_s":1.0}'
curl 'http://n20:5000/api/agent/capabilities' | jq
curl 'http://n20:5000/api/agent/recordings' | jq
curl 'http://n20:5000/api/agent/recordings/local/local/multi_signal_915MHz/analysis?fft_size=1024&threshold_db=5' | jq
```

---

## Remaining milestones

### M5 (in progress) — Continuous Monitoring end-to-end verification

Code is done (`sdr_monitor.py`, `/api/sdr/monitor/*` endpoints) but we only smoke-tested it.
Need to:
- [ ] Start monitor from `/sdr` page UI, confirm segments appear in `sdr_captures/monitor_{id}/`
- [ ] Retune mid-capture, confirm next segment uses new freq
- [ ] Auto-register each segment in metadata DB (currently only on-demand captures do this)
- [ ] Verify eviction of oldest segments works
- [ ] Clean shutdown on API stop (monitor thread must release device lock)

### M6 — Live Waterfall WebSocket

The `/sdr` page has a placeholder for live waterfall. Need to:
- [ ] Add `WebSocket /api/datasources/{a}/{c}/{p}/spectrogram/live` endpoint to `spectrogram_router.py`
- [ ] Monitor thread pushes PNG row strips to WS subscribers when a new segment lands
- [ ] New hook `use-live-spectrogram.tsx` on the client maintains a circular buffer
- [ ] Konva scrolling waterfall component

### M8 — GPU Acceleration & Tile Caching

- [ ] Optional `cupy` path in `spectrogram_engine.compute_spectrogram_db` with auto-fallback to numpy
- [ ] Filesystem tile cache at `$IQENGINE_TILE_CACHE_DIR/{path}/z{zoom}/t{index}.png` (lazy, LRU eviction)

### Nice-to-haves

- [ ] `docs/sdr-setup-n20.md` with full SoapySDR build-from-source instructions for the n20 pyenv 3.11 environment (so next time it's reproducible)
- [ ] Build the SoapySDR Python bindings wheel and vendor it in `api/vendor/` so any Python 3.11 environment can install it
- [ ] Write the n20 setup as `make setup-n20` in the Makefile
- [ ] Zoom-out support: `use-server-spectrogram.tsx` currently always uses max_zoom. Wire `fftStepSize` context value to the zoom parameter
- [ ] Server-side FFT + annotation overlay: currently annotations are drawn in a separate Konva layer on top of the image, which works for both client and server paths, but the annotation Y positions assume client FFT row indexing. Verify this still lines up correctly with server tiles
- [ ] Agent `/capture-and-analyze` should wait for capture completion and return spectrogram + analysis in one response (currently just returns job_id)
- [ ] `POST /api/datasources/local/local/sync` (no auth required in local mode) so newly dropped files are picked up without restarting the API
- [ ] Add a HackRF gain ladder (LNA + VGA + AMP) exposed in the capture form instead of a single `gain` parameter
- [ ] SDR_ENABLED feature flag should also hide the `/sdr` link in the client nav when disabled

---

## Known issues / quirks

- **Python 3.8 + repo code** — the repo uses PEP 604 `X | None` and `match` statements, which require Python 3.10+. Use pyenv 3.11 on n20.
- **SoapySDR bindings ABI** — apt's `python3-soapysdr` is compiled for the system Python (3.8 on Ubuntu 20.04). If you upgrade the venv Python version, you must rebuild the bindings against the new Python headers.
- **SoapySDR plugin search path** — our source-built SoapySDR looks in `/usr/local/lib/SoapySDR/modules0.7` by default. Set `SOAPY_SDR_PLUGIN_PATH=/usr/lib/x86_64-linux-gnu/SoapySDR/modules0.7` in `.env` to find the system HackRF module.
- **`SoapySDR.Device.enumerate()` iteration segfaults** on some bindings versions. Always use `r.asdict()` — never `{k: r[k] for k in r.keys()}`. See commit `165f052`.
- **DC spike** on HackRF captures is expected — it's a direct-conversion receiver. Future work: DC offset correction in `spectrogram_engine.py` (subtract mean before FFT) as an opt-in flag.
- **macOS port 5000** is used by Control Center (AirPlay Receiver). On a Mac dev box, use port 5001 and update `vite.config.ts` proxy target accordingly. On n20 (Ubuntu), port 5000 is free.
- **Vite port 3000** binds to `0.0.0.0` only when you pass `--host` (the `start` script already does this via `vite --host`).

---

## Reference

- SigMF spec: https://github.com/sigmf/SigMF
- SoapySDR: https://github.com/pothosware/SoapySDR/wiki
- HackRF SoapySDR module: https://github.com/pothosware/SoapyHackRF
- FastAPI dependency injection patterns used here: `app/iq_router.py` is the canonical example
