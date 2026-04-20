import io
import math
from functools import lru_cache
from typing import Optional, Tuple

import numpy as np
from PIL import Image
from scipy import signal as scipy_signal

from helpers.samples import get_bytes_per_iq_sample, get_samples

# Colormap LUTs — 256x3 uint8 arrays generated from matplotlib colormaps.
# We store them here to avoid importing matplotlib at runtime (heavy + slow).
_COLORMAP_CACHE = {}


def _generate_colormap_lut(name: str) -> np.ndarray:
    """Generate a 256x3 uint8 lookup table for a named colormap."""
    if name in _COLORMAP_CACHE:
        return _COLORMAP_CACHE[name]
    try:
        import matplotlib.cm as cm

        cmap = cm.get_cmap(name)
    except Exception:
        import matplotlib.cm as cm

        cmap = cm.get_cmap("viridis")
    lut = np.zeros((256, 3), dtype=np.uint8)
    for i in range(256):
        rgba = cmap(i / 255.0)
        lut[i] = [int(rgba[0] * 255), int(rgba[1] * 255), int(rgba[2] * 255)]
    _COLORMAP_CACHE[name] = lut
    return lut


def _get_window(name: str, size: int) -> np.ndarray:
    """Return a window function array."""
    if name == "hamming":
        return np.hamming(size).astype(np.float32)
    elif name == "hanning" or name == "hann":
        return np.hanning(size).astype(np.float32)
    elif name == "bartlett":
        return np.bartlett(size).astype(np.float32)
    elif name == "blackman":
        return np.blackman(size).astype(np.float32)
    else:  # rectangle / none
        return np.ones(size, dtype=np.float32)


def compute_spectrogram_db(samples: np.ndarray, fft_size: int, window: str = "hanning") -> np.ndarray:
    """Compute spectrogram as dB magnitude matrix using vectorized FFT.

    Args:
        samples: Complex64 numpy array of IQ samples
        fft_size: FFT size (must be power of 2)
        window: Window function name

    Returns:
        2D numpy float32 array of shape (num_rows, fft_size) in dB scale
    """
    num_samples = len(samples)
    num_rows = num_samples // fft_size
    if num_rows == 0:
        return np.zeros((0, fft_size), dtype=np.float32)

    # Truncate to exact multiple of fft_size and reshape
    truncated = samples[: num_rows * fft_size].reshape(num_rows, fft_size)

    # Apply window function (broadcast across rows)
    win = _get_window(window, fft_size)
    windowed = truncated * win

    # Vectorized FFT along axis=1, then fftshift
    result = np.fft.fftshift(np.fft.fft(windowed, axis=1), axes=1)

    # Normalize by FFT size (matches client-side: out = out.map(x => x / fftSize))
    result = result / fft_size

    # Amplitude → dB: 10*log10(|X|) — matches client-side which does sqrt(re²+im²) then 10*log10
    # (NOT power spectrum 10*log10(|X|²) which would be 20*log10(|X|))
    magnitudes_db = 10.0 * np.log10(np.abs(result) + 1e-12)

    return magnitudes_db.astype(np.float32)


def apply_colormap(magnitudes_db: np.ndarray, cmap: str = "viridis", mag_min: Optional[float] = None, mag_max: Optional[float] = None) -> np.ndarray:
    """Apply colormap to dB magnitude array, returning RGB uint8 image.

    Args:
        magnitudes_db: 2D float32 array (num_rows x fft_size) in dB
        cmap: Colormap name (matplotlib-compatible)
        mag_min: Minimum dB value for scaling (auto if None)
        mag_max: Maximum dB value for scaling (auto if None)

    Returns:
        3D uint8 array of shape (num_rows, fft_size, 3) — RGB image
    """
    if magnitudes_db.size == 0:
        return np.zeros((0, 0, 3), dtype=np.uint8)

    lut = _generate_colormap_lut(cmap)

    if mag_min is None:
        mag_min = float(np.percentile(magnitudes_db, 5))
    if mag_max is None:
        mag_max = float(np.percentile(magnitudes_db, 95))

    if mag_max <= mag_min:
        mag_max = mag_min + 1.0

    # Scale to 0-255
    scaled = (magnitudes_db - mag_min) * (255.0 / (mag_max - mag_min))
    indices = np.clip(scaled, 0, 255).astype(np.uint8)

    # Apply LUT
    rgb = lut[indices]
    return rgb


def rgb_to_png(rgb: np.ndarray) -> bytes:
    """Convert RGB uint8 array to PNG bytes."""
    img = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def zoom_decimation_factor(orig_sample_rate_hz: float, zoom_bandwidth_hz: Optional[float]) -> int:
    """Integer decimation factor D for the requested zoom bandwidth (>= 1, power of 2 ceiling)."""
    if not zoom_bandwidth_hz or zoom_bandwidth_hz <= 0:
        return 1
    if zoom_bandwidth_hz >= orig_sample_rate_hz:
        return 1
    # Snap to next power of two so the tile pyramid stays in the same family
    ratio = orig_sample_rate_hz / zoom_bandwidth_hz
    return max(1, 2 ** int(math.ceil(math.log2(ratio))))


def apply_freq_zoom(
    samples: np.ndarray,
    orig_sample_rate_hz: float,
    file_center_hz: float,
    zoom_center_hz: float,
    decimation: int,
) -> np.ndarray:
    """Shift to baseband at zoom_center, low-pass, and decimate by `decimation`.

    Returns complex64 samples at the decimated rate. No-op when decimation == 1.
    """
    if decimation <= 1:
        return samples.astype(np.complex64, copy=False)
    offset_hz = zoom_center_hz - file_center_hz
    n = samples.size
    if offset_hz != 0:
        phase = -2.0 * math.pi * offset_hz * np.arange(n, dtype=np.float64) / orig_sample_rate_hz
        mixer = np.exp(1j * phase).astype(np.complex64)
        samples = (samples * mixer).astype(np.complex64, copy=False)
    # LPF cutoff just under Nyquist of the decimated rate, applied as a FIR so
    # we can convolve over complex input (scipy.signal.decimate rejects complex).
    cutoff = 0.5 * orig_sample_rate_hz / decimation * 0.9
    taps = scipy_signal.firwin(numtaps=129, cutoff=cutoff, fs=orig_sample_rate_hz).astype(np.float32)
    filtered_i = np.convolve(samples.real, taps, mode="same")
    filtered_q = np.convolve(samples.imag, taps, mode="same")
    decimated = (filtered_i[::decimation] + 1j * filtered_q[::decimation]).astype(np.complex64)
    return decimated


def compute_tile_info(
    total_samples: int,
    fft_size: int,
    tile_height: int = 256,
    decimation: int = 1,
) -> dict:
    """Compute tile grid metadata for a recording.

    Args:
        total_samples: Total number of IQ samples in the recording
        fft_size: FFT size
        tile_height: Number of FFT rows per tile (at max zoom)

    Returns:
        Dict with tile grid info
    """
    # With freq zoom active, one FFT row consumes `fft_size * decimation` of the
    # original samples (decimate by D, then take fft_size samples), so total rows
    # collapse by the same factor.
    effective_samples_per_row = fft_size * max(1, int(decimation))
    total_ffts = total_samples // effective_samples_per_row
    if total_ffts == 0:
        return {"total_ffts": 0, "max_zoom": 0, "tile_height": tile_height, "fft_size": fft_size, "zoom_levels": {}}

    max_zoom = max(0, math.ceil(math.log2(max(total_ffts / tile_height, 1))))

    zoom_levels = {}
    for z in range(max_zoom + 1):
        # At each zoom level, how many FFT rows per tile row
        rows_per_tile_row = 2 ** (max_zoom - z)
        effective_ffts = math.ceil(total_ffts / rows_per_tile_row)
        num_tiles = math.ceil(effective_ffts / tile_height)
        zoom_levels[z] = {"num_tiles": num_tiles, "rows_per_tile_row": rows_per_tile_row, "effective_ffts": effective_ffts}

    return {
        "total_ffts": total_ffts,
        "max_zoom": max_zoom,
        "tile_height": tile_height,
        "fft_size": fft_size,
        "total_samples": total_samples,
        "zoom_levels": zoom_levels,
    }


def compute_tile_db(
    samples: np.ndarray,
    fft_size: int,
    zoom: int,
    time_index: int,
    tile_height: int = 256,
    window: str = "hanning",
    total_ffts: Optional[int] = None,
    max_zoom: Optional[int] = None,
) -> np.ndarray:
    """Compute the zoom-averaged dB magnitude tile (no colormap, no PNG).

    Returns a 2D float32 array of shape (num_output_rows, fft_size).
    Shared hot path between the PNG tile endpoint and the float32 tile endpoint.
    """
    num_samples = len(samples)
    if total_ffts is None:
        total_ffts = num_samples // fft_size
    if max_zoom is None:
        max_zoom = max(0, math.ceil(math.log2(max(total_ffts / tile_height, 1))))

    rows_per_tile_row = 2 ** (max_zoom - zoom)

    start_fft = time_index * tile_height * rows_per_tile_row
    end_fft = min(start_fft + tile_height * rows_per_tile_row, total_ffts)
    if start_fft >= total_ffts:
        return np.zeros((0, fft_size), dtype=np.float32)

    sample_start = start_fft * fft_size
    sample_end = end_fft * fft_size
    tile_samples = samples[sample_start:sample_end]

    db = compute_spectrogram_db(tile_samples, fft_size, window)
    if db.shape[0] == 0:
        return db

    if rows_per_tile_row > 1 and db.shape[0] > tile_height:
        num_output_rows = math.ceil(db.shape[0] / rows_per_tile_row)
        padded_rows = num_output_rows * rows_per_tile_row
        if padded_rows > db.shape[0]:
            pad = np.full((padded_rows - db.shape[0], fft_size), np.nan, dtype=np.float32)
            db = np.concatenate([db, pad], axis=0)
        db = np.nanmean(db.reshape(num_output_rows, rows_per_tile_row, fft_size), axis=1)

    return db.astype(np.float32, copy=False)


def compute_tile(
    samples: np.ndarray,
    fft_size: int,
    zoom: int,
    time_index: int,
    tile_height: int = 256,
    window: str = "hanning",
    cmap: str = "viridis",
    mag_min: Optional[float] = None,
    mag_max: Optional[float] = None,
    total_ffts: Optional[int] = None,
    max_zoom: Optional[int] = None,
) -> Tuple[bytes, dict]:
    """Compute a single spectrogram tile as PNG (colormap applied server-side)."""
    db = compute_tile_db(samples, fft_size, zoom, time_index, tile_height, window, total_ffts, max_zoom)
    if db.shape[0] == 0:
        rgb = np.zeros((1, fft_size, 3), dtype=np.uint8)
        return rgb_to_png(rgb), {"rows": 0, "cols": fft_size}
    rgb = apply_colormap(db, cmap=cmap, mag_min=mag_min, mag_max=mag_max)
    return rgb_to_png(rgb), {"rows": rgb.shape[0], "cols": rgb.shape[1]}
