/**
 * TileClient — Fetches server-rendered spectrogram tiles (PNG) for the recording view.
 * This is a parallel rendering path that doesn't replace client-side FFT.
 */

export interface TileInfo {
  total_ffts: number;
  max_zoom: number;
  tile_height: number;
  fft_size: number;
  total_samples: number;
  data_type: string;
  sample_rate_hz?: number;
  center_freq_hz?: number;
  original_sample_rate_hz?: number;
  original_center_freq_hz?: number;
  zoom_decimation?: number;
  zoom_levels: Record<
    number,
    {
      num_tiles: number;
      rows_per_tile_row: number;
      effective_ffts: number;
    }
  >;
}

export interface FreqZoomParams {
  freqCenterHz: number;
  freqBandwidthHz: number;
}

export interface TileResult {
  image: ImageBitmap;
  zoom: number;
  timeIndex: number;
  rows: number;
  cols: number;
}

export interface TileDbResult {
  db: Float32Array;
  zoom: number;
  timeIndex: number;
  rows: number;
  cols: number;
}

/**
 * Fetch tile grid metadata for a recording.
 */
export async function fetchTileInfo(
  account: string,
  container: string,
  filePath: string,
  fftSize: number = 1024,
  freqZoom: FreqZoomParams | null = null
): Promise<TileInfo> {
  const params = new URLSearchParams({ fft_size: String(fftSize) });
  if (freqZoom) params.set('freq_bandwidth_hz', String(freqZoom.freqBandwidthHz));
  const url = `/api/datasources/${account}/${container}/${filePath}/spectrogram/info?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch tile info: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

/**
 * Fetch a single spectrogram tile as an ImageBitmap.
 */
export async function fetchTile(
  account: string,
  container: string,
  filePath: string,
  zoom: number,
  timeIndex: number,
  options: {
    fftSize?: number;
    window?: string;
    cmap?: string;
    magMin?: number;
    magMax?: number;
    freqCenterHz?: number;
    freqBandwidthHz?: number;
    signal?: AbortSignal;
  } = {}
): Promise<TileResult> {
  const params = new URLSearchParams();
  if (options.fftSize) params.set('fft_size', String(options.fftSize));
  if (options.window) params.set('window', options.window);
  if (options.cmap) params.set('cmap', options.cmap);
  if (options.magMin !== undefined) params.set('mag_min', String(options.magMin));
  if (options.magMax !== undefined) params.set('mag_max', String(options.magMax));
  if (options.freqCenterHz !== undefined && options.freqBandwidthHz !== undefined) {
    params.set('freq_center_hz', String(options.freqCenterHz));
    params.set('freq_bandwidth_hz', String(options.freqBandwidthHz));
  }

  const url = `/api/datasources/${account}/${container}/${filePath}/spectrogram/tile/${zoom}/${timeIndex}?${params.toString()}`;
  const resp = await fetch(url, { signal: options.signal });
  if (!resp.ok) {
    throw new Error(`Failed to fetch tile ${zoom}/${timeIndex}: ${resp.status}`);
  }

  const rows = parseInt(resp.headers.get('X-Tile-Rows') || '256', 10);
  const cols = parseInt(resp.headers.get('X-Tile-Cols') || '1024', 10);

  const blob = await resp.blob();
  const image = await createImageBitmap(blob);

  return { image, zoom, timeIndex, rows, cols };
}

/**
 * Fetch a raw-dB tile (float32 magnitudes). Colormap + mag scaling are applied
 * client-side so that changing magnitude/colormap doesn't invalidate the cache.
 */
export async function fetchTileDb(
  account: string,
  container: string,
  filePath: string,
  zoom: number,
  timeIndex: number,
  options: {
    fftSize?: number;
    window?: string;
    freqCenterHz?: number;
    freqBandwidthHz?: number;
    signal?: AbortSignal;
  } = {}
): Promise<TileDbResult> {
  const params = new URLSearchParams({ format: 'float32' });
  if (options.fftSize) params.set('fft_size', String(options.fftSize));
  if (options.window) params.set('window', options.window);
  if (options.freqCenterHz !== undefined && options.freqBandwidthHz !== undefined) {
    params.set('freq_center_hz', String(options.freqCenterHz));
    params.set('freq_bandwidth_hz', String(options.freqBandwidthHz));
  }

  const url = `/api/datasources/${account}/${container}/${filePath}/spectrogram/tile/${zoom}/${timeIndex}?${params.toString()}`;
  const resp = await fetch(url, { signal: options.signal });
  if (!resp.ok) {
    throw new Error(`Failed to fetch tile ${zoom}/${timeIndex}: ${resp.status}`);
  }

  const rows = parseInt(resp.headers.get('X-Tile-Rows') || '0', 10);
  const cols = parseInt(resp.headers.get('X-Tile-Cols') || '0', 10);
  const buf = await resp.arrayBuffer();
  const db = new Float32Array(buf);
  return { db, zoom, timeIndex, rows, cols };
}

/**
 * Compute which tiles are visible for a given scroll position and viewport.
 */
export function getVisibleTiles(
  tileInfo: TileInfo,
  zoom: number,
  viewportStartFFT: number,
  viewportHeight: number
): number[] {
  const zoomLevel = tileInfo.zoom_levels[zoom];
  if (!zoomLevel) return [];

  const rowsPerTileRow = zoomLevel.rows_per_tile_row;
  const tileHeight = tileInfo.tile_height;

  // `viewportStartFFT` is in original FFT units; `viewportHeight` is in viewport PIXELS.
  // Each viewport pixel corresponds to one row of the zoomed tile (which itself
  // aggregates `rowsPerTileRow` original FFTs). So the viewport spans
  // `viewportHeight * rowsPerTileRow` original FFTs.
  const effectiveStartFFT = Math.floor(viewportStartFFT / rowsPerTileRow);
  const effectiveEndFFT = effectiveStartFFT + viewportHeight;

  const startTile = Math.floor(effectiveStartFFT / tileHeight);
  const endTile = Math.ceil(effectiveEndFFT / tileHeight);

  const tiles: number[] = [];
  for (let i = startTile; i < Math.min(endTile, zoomLevel.num_tiles); i++) {
    tiles.push(i);
  }
  return tiles;
}
