import { colMaps } from '@/utils/colormap';

/**
 * Convert a raw-dB tile (float32, row-major, fft-shifted in frequency) into an
 * RGBA ImageData using the given colormap and dB scaling range.
 *
 * All per-pixel work happens in a tight typed-array loop so the cost is O(rows*cols)
 * with no intermediate allocations per pixel. A typical 256x1024 tile recolors
 * in ~3-5 ms on a modern laptop CPU.
 */
export function dbTileToImageData(
  db: Float32Array,
  rows: number,
  cols: number,
  magMin: number,
  magMax: number,
  colormap: string
): ImageData {
  const lut = colMaps[colormap] || colMaps['viridis'];
  const span = magMax - magMin;
  const scale = span > 0 ? 255 / span : 0;
  const pixels = rows * cols;
  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    let v = (db[i] - magMin) * scale;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    const idx = v | 0; // truncate to int
    const rgb = lut[idx];
    const o = i * 4;
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
    out[o + 3] = 255;
  }
  return new ImageData(out, cols, rows);
}
