"""Filesystem cache for rendered float32 spectrogram tiles.

Enabled when `IQENGINE_TILE_CACHE_DIR` is set. Cache keys combine the recording
path, FFT size, window function, freq-zoom key, zoom level, and time index —
everything that determines the raw-dB tile content, but not colormap / magnitude
(those are applied client-side).

File layout:
    {cache_dir}/{hash[0:2]}/{hash}.tile

File format (little-endian):
    0x00..0x07  magic 'IQETILE1'
    0x08..0x0B  rows   (uint32)
    0x0C..0x0F  cols   (uint32)
    0x10..      rows * cols * 4 bytes of float32 dB values

Not cached: PNG tiles (colormap-dependent, low hit-rate).
"""

from __future__ import annotations

import hashlib
import logging
import os
import struct
import time
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger("api")

_MAGIC = b"IQETILE1"
_HEADER_FMT = "<8sII"  # magic, rows, cols
_HEADER_LEN = struct.calcsize(_HEADER_FMT)

# Default LRU cap at ~8k tiles (~6 GB for 256x1024 float32 tiles). Override with
# IQENGINE_TILE_CACHE_MAX_FILES. When the count crosses the cap by a write, the
# oldest 10% by mtime are pruned.
_DEFAULT_MAX_FILES = 8192
_PRUNE_FRACTION = 0.1


def _cache_root() -> Optional[Path]:
    root = os.environ.get("IQENGINE_TILE_CACHE_DIR")
    if not root:
        return None
    path = Path(root)
    path.mkdir(parents=True, exist_ok=True)
    return path


def enabled() -> bool:
    return _cache_root() is not None


def _max_files() -> int:
    try:
        return max(64, int(os.environ.get("IQENGINE_TILE_CACHE_MAX_FILES", _DEFAULT_MAX_FILES)))
    except ValueError:
        return _DEFAULT_MAX_FILES


def _tile_key(
    filepath: str,
    fft_size: int,
    window: str,
    zoom_key: str,
    zoom: int,
    time_index: int,
) -> str:
    raw = f"{filepath}|fft{fft_size}|w:{window}|fz:{zoom_key}|z{zoom}|t{time_index}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _tile_path(key: str) -> Path:
    root = _cache_root()
    assert root is not None
    shard = root / key[:2]
    shard.mkdir(parents=True, exist_ok=True)
    return shard / f"{key}.tile"


def load_tile(
    filepath: str,
    fft_size: int,
    window: str,
    zoom_key: str,
    zoom: int,
    time_index: int,
) -> Optional[np.ndarray]:
    """Return cached dB tile as float32 (rows, cols), or None on miss."""
    if not enabled():
        return None
    key = _tile_key(filepath, fft_size, window, zoom_key, zoom, time_index)
    path = _tile_path(key)
    if not path.exists():
        return None
    try:
        with path.open("rb") as f:
            header = f.read(_HEADER_LEN)
            if len(header) != _HEADER_LEN:
                return None
            magic, rows, cols = struct.unpack(_HEADER_FMT, header)
            if magic != _MAGIC or rows <= 0 or cols <= 0:
                return None
            expected = rows * cols * 4
            payload = f.read(expected)
            if len(payload) != expected:
                return None
        arr = np.frombuffer(payload, dtype=np.float32).reshape(rows, cols)
        # Touch mtime so LRU treats a cache hit as a use.
        try:
            now = time.time()
            os.utime(path, (now, now))
        except OSError:
            pass
        return arr
    except Exception as exc:
        logger.warning("Tile cache read failed for %s: %s", key, exc)
        return None


def save_tile(
    filepath: str,
    fft_size: int,
    window: str,
    zoom_key: str,
    zoom: int,
    time_index: int,
    db: np.ndarray,
) -> None:
    """Store a float32 dB tile in the cache. Silent on failure."""
    if not enabled():
        return
    if db.ndim != 2 or db.dtype != np.float32 or db.shape[0] == 0 or db.shape[1] == 0:
        return
    key = _tile_key(filepath, fft_size, window, zoom_key, zoom, time_index)
    path = _tile_path(key)
    tmp = path.with_suffix(".tile.tmp")
    try:
        rows, cols = int(db.shape[0]), int(db.shape[1])
        with tmp.open("wb") as f:
            f.write(struct.pack(_HEADER_FMT, _MAGIC, rows, cols))
            f.write(db.tobytes(order="C"))
        tmp.replace(path)
    except Exception as exc:
        logger.warning("Tile cache write failed for %s: %s", key, exc)
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        return
    _maybe_prune()


_prune_pending = 0


def _maybe_prune() -> None:
    """LRU prune on every ~64 writes to amortize dir-walk cost."""
    global _prune_pending
    _prune_pending += 1
    if _prune_pending < 64:
        return
    _prune_pending = 0
    root = _cache_root()
    if root is None:
        return
    cap = _max_files()
    try:
        entries = []
        for shard in root.iterdir():
            if not shard.is_dir():
                continue
            for p in shard.iterdir():
                if p.suffix == ".tile":
                    try:
                        entries.append((p.stat().st_mtime, p))
                    except OSError:
                        pass
        if len(entries) <= cap:
            return
        entries.sort(key=lambda x: x[0])
        prune_count = max(1, int(len(entries) * _PRUNE_FRACTION))
        prune_count = max(prune_count, len(entries) - cap)
        for _, p in entries[:prune_count]:
            try:
                p.unlink()
            except OSError:
                pass
        logger.info("Tile cache pruned %d entries (was %d, cap %d)", prune_count, len(entries), cap)
    except Exception as exc:
        logger.warning("Tile cache prune failed: %s", exc)
