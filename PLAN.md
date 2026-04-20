# IQEngine Realtime SDR & Server-Side Processing — Plan & Status

This document tracks the implementation plan for extending IQEngine with:
1. Server-side spectrogram tiles (offload FFT to backend)
2. Live SDR capture via SoapySDR (HackRF, RTL-SDR, PlutoSDR)
3. Structured REST API for AI agent consumption (MCP-ready)
4. MCP stdio server wrapping the agent API (`api/mcp_server/`)

## Current Status: M1–M7 + M6 + MCP server + M9 (live demod) + M10 (perf/UX pass) complete

Commits on `main`:
- `617e2b0` — initial implementation of all three components (M1–M7)
- `165f052` — SoapySDR `enumerate()` segfault fix (use `asdict()`)
- `7531686` — SDR capture auto-register + agent router ordering fix
- `f68b77c` — M5 verification: monitor metadata callback, shutdown hook, SoapySDR 0.8.1 upgrade
- `1e87c5c` — M6: live waterfall WebSocket streaming with scrolling canvas
- `fc7a3ce`–`036ad6e` — M9.1–M9.3: gqrx-style `/sdr/live` page with spectrum + waterfall + live demod
- `b15e416` — Unify live+recording views, stream chunked demod audio, add nfm/am/ssb plugins
- `15d3634`–`03a743f` — Zoom Out Level wiring for server-side FFT, power-of-two steps
- `9093b55`–`5d991c9` — Magnitude slider clamping, default -150 dB
- `d62136d` — Decimation-based frequency zoom (server DSP + client UI)
- `7094804` — Freq cursors / ruler / plugin targets honour effective SR under freq zoom
- `8905dac` — Time cursors honour Zoom Out Level
- `375f2f2` — Incremental tile compositing + network-level aborts
- `c40e8ca` — Float32 spectrogram tiles + client-side colormap + threadpool FFT
- `40b8eb5` — Live-reload local datasource with a Refresh button
- `e9df3eb` — Time zoom-in slider + Show Annotations toggle
- `eb76b6f` — Smooth scroll: slide the composite instead of repainting
- `26fab3c` — Y-axis ruler: show unit, honour zoom, one unit per ruler

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
- `client/src/pages/sdr/LiveWaterfall.tsx` — canvas-based live waterfall via WebSocket
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
SOAPY_SDR_PLUGIN_PATH=lib/SoapySDR/modules0.8
```

### Start both servers

```bash
# In one tmux session:
cd /home/niklas/git/IQEngine/api && LD_LIBRARY_PATH=.venv/lib .venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 5000

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

### M5 (done) — Continuous Monitoring end-to-end verification

All items verified on n20 with HackRF One (2026-04-14):
- [x] Start monitor from `/sdr` page UI, segments appear in `sdr_captures/monitor_{id}/`
- [x] Retune mid-capture (915→433 MHz), next segment uses new freq
- [x] Auto-register each segment in metadata DB (wired up `register_metadata_callback` in `start_monitor()`)
- [x] Eviction of oldest segments works (set max_segments=5, confirmed indices 0–1 deleted)
- [x] Clean shutdown on API stop (shutdown event handler stops monitors, releases device lock)

Code fixes applied:
- `sdr_router.py`: pass `register_metadata_callback` to `MonitorRunner` via `asyncio.run_coroutine_threadsafe`
- `main.py`: add `_shutdown_sdr_monitors` shutdown event handler with `SoapySDR.unloadModules()` cleanup
- Upgraded SoapySDR from 0.7.2 to **0.8.1** (source-built) — fixes intermittent segfault on process exit caused by static `std::shared_future` cache in `Device::enumerate()` racing with Python interpreter shutdown. HackRF module also rebuilt against 0.8 ABI.
- `sdr_device.py`: `enumerate()` calls are unfiltered (all SDR types supported)

### M6 (done) — Live Waterfall WebSocket

Verified on n20 with HackRF One (2026-04-14):
- [x] `WebSocket /api/sdr/monitor/live` endpoint in `sdr_router.py` — streams spectrogram PNG strips per segment
- [x] `WaterfallSubscriber` in `sdr_monitor.py` — monitor thread computes FFT + colormap + decimation, pushes PNG to async queues
- [x] `LiveWaterfall.tsx` canvas component — connects WS, receives alternating JSON metadata + binary PNG frames, renders scrolling waterfall (newest at top)
- [x] Integrated into `/sdr` page, replaces placeholder
- [x] Vite proxy `ws: true` for dev WebSocket forwarding
- [x] Requires `websockets` pip package for uvicorn WebSocket support

Protocol: text frame (config on connect, strip metadata per segment) + binary frame (PNG).
Query params: `fft_size`, `cmap`, `max_rows` (strip height after decimation, default 128).

### MCP server (done 2026-04-17)

- [x] `api/mcp_server/` — stdio MCP server (FastMCP) wrapping `/api/agent/*`
- [x] Separate venv at `api/mcp_server/.venv` to avoid clobbering the API's pinned deps (mcp 1.27 requires pydantic>=2.11, starlette>=0.49; API is on pydantic 2.7 + starlette 0.37)
- [x] 15 tools: `list_recordings`, `get_recording`, `get_spectrogram`, `analyze_recording`, `get_annotations`, `capture`, `capture_and_analyze`, `tune_sdr`, `start_monitor`, `get_job_status`, `get_job_events`, `cancel_job`, `run_plugin`, `list_capabilities`, `list_sdr_devices`
- [x] Config via `IQENGINE_API_URL` (default `http://localhost:5000`) and `IQENGINE_MCP_TIMEOUT` (default 120s)
- [x] Launcher: `api/mcp_server/run.sh` — stdio transport
- [x] Registered with Claude Code at user scope: `claude mcp add -s user iqengine /home/niklas/git/IQEngine/api/mcp_server/run.sh`

### M8 — GPU Acceleration & Tile Caching

- [ ] Optional `cupy` path in `spectrogram_engine.compute_spectrogram_db` with auto-fallback to numpy
- [ ] Filesystem tile cache at `$IQENGINE_TILE_CACHE_DIR/{path}/z{zoom}/t{index}.f32` (lazy, LRU eviction). Keyed by `{zoom, tileIndex, window, freqZoomKey}` to match the client-side cache — colormap / mag no longer invalidate since clients colormap float32 tiles themselves.

### M9 — Live SDR (done 2026-04-17)

- [x] M9.1 `fc87b77` Add rolling IQ buffer, live spectrum WS, and snapshot endpoint
- [x] M9.2 `fc7a3ce` Add gqrx-style /sdr/live page with live spectrum, waterfall, and snapshots
- [x] M9.3 `a3ef9b8` Live demodulation + audio streaming
- [x] `036ad6e` — keep waterfall pixels crisp when resizing
- [x] `b15e416` — live view unified into the recording-view shell (shared tab strip, sidebar, bottom accordion)

### M10 — Server/Client Perf & UX (done 2026-04-20)

Net effect: tile fetches roughly parallel across cores on the server, cache survives colormap/magnitude/window changes, recolor is a pure client-side GPU pass, and wheel-scroll slides the existing composite instead of repainting it.

- [x] `asyncio.to_thread` around the FFT/colormap/PNG pipeline so tile requests parallelize across cores instead of serializing on the asyncio event loop
- [x] Float32 dB tiles + client-side colormap via `dbTileToImageData` — colormap / magMin / magMax slider drags produce zero network traffic
- [x] Incremental compositing: blit each tile as it arrives (rAF-throttled) instead of waiting on `Promise.all`
- [x] Network-level AbortSignal threaded into `fetch()` so scroll cancels close the socket
- [x] `canvas.transferToImageBitmap()` replaces `convertToBlob + createImageBitmap` (no PNG encode/decode per frame)
- [x] Smooth scroll: hook returns `imageOffsetY`; `<Image y={...}>` slides the composite when visible tile set is unchanged, repaint only on tile-boundary crossing
- [x] Zoom Out Level: power-of-two steps, each slider position produces a visibly different zoom level
- [x] Zoom Out Level wired to the server-side path (was hardcoded `max_zoom`)
- [x] Zoom In (1×-16×) slider for short signals, plays well with Zoom Out via `rowsPerPixel = (fftStepSize + 1) / max(1, timeZoomIn)`
- [x] Decimation-based frequency zoom — server mixes to zoom center, FIR LPF, decimates, re-FFTs at same `fft_size` for real additional resolution over the narrow band
- [x] Freq/time cursor labels, ruler-top, plugin `target_freq` / `if_bandwidth` all honour `effectiveSampleRateHz` / `effectiveCenterFreqHz` under freq zoom
- [x] Time-cursor math (render + drag + default seed) scales by `rowsPerPixel`
- [x] Y-axis ruler: one unit (µs / ms / s) per ruler, suffix on every label, scales with zoom
- [x] Hide Annotations toggle
- [x] Magnitude slider: floor -200 dB, default -150 dB, minValue clamped to avoid off-column overflow
- [x] Live-reload datasource (Refresh button + `POST /api/datasources/{account}/{container}/resync-local`, gated on `IN_MEMORY_DB=1`)

### Plugins / demod (done 2026-04-20)

- [x] NFM, AM, USB, LSB receivers alongside the existing WFM `fm_receiver`. All output 48 kHz mono PCM WAV
- [x] Gain slider on every demod plugin (auto-normalize → gain → clip → quantize)
- [x] In-browser WAV playback in the plugin output modal
- [x] Chunked streaming demod: first audio starts after one chunk's round-trip (~2 s) rather than the whole recording's demod time; Web Audio API schedules the chunks sample-accurately
- [x] Full-file fallback: running a plugin without time cursors demods the whole `.sigmf-data` file
- [x] Freq-cursor → plugin `target_freq` / `if_bandwidth` / `audio_bandwidth` autopopulate

### Nice-to-haves / next round

Infra / deploy:
- [ ] `docs/sdr-setup-n20.md` with full SoapySDR build-from-source instructions for the n20 pyenv 3.11 environment (so next time it's reproducible)
- [ ] Build the SoapySDR Python bindings wheel and vendor it in `api/vendor/` so any Python 3.11 environment can install it
- [ ] Write the n20 setup as `make setup-n20` in the Makefile

Perf / architecture (next scrolling layer):
- [ ] **Oversized tile ring buffer.** Today the fast-path slide works within the currently-painted tile set, but crossing a tile boundary still triggers a repaint (visible even if brief). Paint an off-screen buffer ≥ 2× viewport so neighbouring tiles are pre-composed, invalidate only when the scroll window moves outside the buffered region. Then tile-boundary crossings are invisible and repaint moves to the "you wandered a long way" threshold.
- [ ] **Server-side `request.is_disconnected()` polling** in the tile handler so abandoned numpy work can abort mid-computation. Today a cancelled request still burns CPU to completion because the numpy call doesn't yield. Right shape: yield control every ~250 ms inside `compute_tile_db` and bail if the client is gone.
- [ ] **Per-tile ImageBitmap cache** in `use-server-spectrogram`. Currently the hook recolors from raw dB on every full repaint; for drag-scrolling across many tiles this adds ~5 ms per tile per commit. Cache the post-colormap `ImageBitmap` keyed by `{tileKey, colmap, magMin, magMax}`, invalidate on slider change, so the repaint path is just N × drawImage.
- [ ] **M8 GPU FFT** (see above). With `asyncio.to_thread` + OpenBLAS threading already in place, CPU throughput is decent; cupy gives another ~10-100× on large `fft_size`. Keep the numpy fallback.

Missing features:
- [ ] **AM/FM demod tab (pulse / TDMA-packet inspector).** New tab to the right of "Time" in the recording-view tab strip, dedicated to looking at a cursor selection as time-domain demodulated audio-rate traces. Split view, two stacked traces against the same X (time):
  - **Top: AM / envelope** — `|x|` of the freq-shifted + LPF'd IQ so bursts and packet envelopes read cleanly.
  - **Bottom: FM / quadrature** — `diff(unwrap(angle(x)))` so instantaneous frequency deviations (chirps, FSK symbols, TDMA guard bands) are visible.
  Share the existing time-cursor selection for the X window; reuse the Frequency Shift cursor for the down-mix center so the user can tune to the signal of interest on the spectrogram and the demod views update. Use the same decimation + LPF helpers as the `nfm_receiver` plugin, decimated to a few kHz so the trace fits the viewport, rendered with `scattergl` like the existing Time tab. This is the "zoom into one pulse" view that today needs a plugin round-trip.
- [ ] **Client-side freq zoom.** The server path has decimation-based zoom (`apply_freq_zoom` + `compute_tile_db`). For small recordings the client-side FFT path (`use-spectrogram.tsx` + `use-get-image.tsx`) is used instead and freq zoom silently does nothing. Mirror the DSP on the client (shift + LPF + decimate) so zoom works for sub-10 M-sample files too.
- [ ] **Horizontal scroll + freq-axis pan.** Today freq zoom re-centers on the freq-cursor box, but there's no way to pan left/right from there. Add a horizontal scrollbar + drag-to-pan inside the zoomed band.
- [ ] **SSB audio quality.** Current `usb_receiver` / `lsb_receiver` do LPF + real-part SSB demod. Works for clean signals, noisy for marginal ones. Upgrade to a Weaver demodulator or a proper analytic-filter SSB.
- [ ] **Live page ↔ recording-view full shell unification.** Cross-nav (tabs) is done but the live page has its own sidebar layout. Extract an `<RfViewShell>` component and mount both pages inside it so they share stylings + bottom accordion.
- [ ] **Live SDR min/max dB colormap sliders persistence** + per-device presets so flipping between 900 MHz HackRF and 49.5 MHz FSW doesn't need re-tuning each time.
- [ ] HackRF gain ladder (LNA + VGA + AMP) exposed in both the capture form and `/sdr/live` instead of a single `gain` parameter
- [ ] `SDR_ENABLED` feature flag should also hide the Live tab / `/sdr` links when disabled

Polish:
- [ ] Server-side FFT + annotation overlay: annotation Y positions were updated to use `rowsPerPixel` in this round, but the `onDragEnd` sample math was also updated and deserves a visual regression sanity check on a recording with many annotations
- [ ] Agent `/capture-and-analyze` should wait for capture completion and return spectrogram + analysis in one response (currently just returns `job_id`)
- [ ] Untracked screenshots from dev sessions (`*.png` in repo root, `.playwright-mcp/`) should go into `.gitignore` so they don't clutter `git status`. Safe to delete the current set; they were only used to walk through Playwright tests.

---

## Known issues / quirks

- **Python 3.8 + repo code** — the repo uses PEP 604 `X | None` and `match` statements, which require Python 3.10+. Use pyenv 3.11 on n20.
- **SoapySDR 0.8.1 (source-built)** — both `libSoapySDR.so.0.8` and `_SoapySDR.so` Python bindings are built from source (in `/tmp/soapybuild/SoapySDR-soapy-sdr-0.8.1/`) against pyenv Python 3.11. The shared library lives at `api/.venv/lib/libSoapySDR.so.0.8` and requires `LD_LIBRARY_PATH=.venv/lib` when starting the API. The HackRF module is rebuilt against 0.8 ABI and lives at `api/lib/SoapySDR/modules0.8/`.
- **SoapySDR plugin search path** — set `SOAPY_SDR_PLUGIN_PATH=lib/SoapySDR/modules0.8` in `.env`. To add more SDR backends (RTL-SDR, PlutoSDR, etc.), rebuild the corresponding SoapySDR module against the 0.8 headers at `/tmp/soapy081_install/` and place the `.so` in `api/lib/SoapySDR/modules0.8/`.
- **SoapySDR enumerate() segfault (fixed)** — SoapySDR 0.7.2 had an intermittent segfault caused by static `std::shared_future` objects in the enumerate cache racing with Python interpreter shutdown. Root cause: `lib/Factory.cpp` uses `std::async(std::launch::async, ...)` with a static 1-second cache; static destructor order is undefined and can race with Python's `atexit` handlers. Fixed by upgrading to 0.8.1 which rewrote the cleanup path. Belt-and-suspenders: the shutdown handler also calls `SoapySDR.unloadModules()`.
- **`SoapySDR.Device.enumerate()` iteration** — always use `r.asdict()` on enumerate results, never `dict(r)` or manual key iteration (see commit `165f052`).
- **DC spike** on HackRF captures is expected — it's a direct-conversion receiver. Future work: DC offset correction in `spectrogram_engine.py` (subtract mean before FFT) as an opt-in flag.
- **macOS port 5000** is used by Control Center (AirPlay Receiver). On a Mac dev box, use port 5001 and update `vite.config.ts` proxy target accordingly. On n20 (Ubuntu), port 5000 is free.
- **Vite port 3000** binds to `0.0.0.0` only when you pass `--host` (the `start` script already does this via `vite --host`).

---

## Reference

- SigMF spec: https://github.com/sigmf/SigMF
- SoapySDR: https://github.com/pothosware/SoapySDR/wiki
- HackRF SoapySDR module: https://github.com/pothosware/SoapyHackRF
- FastAPI dependency injection patterns used here: `app/iq_router.py` is the canonical example
