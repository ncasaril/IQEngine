/**
 * Hook for server-side spectrogram tile fetching and compositing.
 * Parallel rendering path — does not affect client-side FFT.
 *
 * Tiles are fetched as raw-dB float32 from the server and the colormap + magnitude
 * scaling is applied in the browser. This decouples the tile cache from the
 * colormap / dB slider / magnitude settings.
 *
 * Scroll optimisation: tiles are composed onto an oversized off-screen buffer
 * (BUFFER_MULTIPLIER × viewport height). As long as the viewport stays inside
 * the buffer (with a safety margin), scrolls — including those that cross tile
 * boundaries — only slide the Konva Image via the returned imageOffsetY. We
 * repaint when the viewport enters the top/bottom margin or a display param
 * (colormap, magnitude, window, zoom) changes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchTileDb, fetchTileInfo, getVisibleTiles, TileDbResult, TileInfo } from '@/api/iqdata/TileClient';
import { dbTileToImageData } from '@/pages/recording-view/utils/db-tile-render';
import { useSpectrogramContext } from './use-spectrogram-context';

const BUFFER_MULTIPLIER = 3;
const TRIGGER_MARGIN_RATIO = 0.33;

interface ServerSpectrogramResult {
  image: ImageBitmap | null;
  imageOffsetY: number;
  ready: boolean;
  loading: boolean;
  tileInfo: TileInfo | null;
}

interface PaintState {
  anchorFFT: number;
  bufferHeightPx: number;
  atTop: boolean;
  atBottom: boolean;
  bufferedKey: string;
  colmap: string;
  magMin: number;
  magMax: number;
  windowFn: string;
  zoomKey: string;
  zoom: number;
  timeZoomIn: number;
  rowsPerTileRow: number;
}

export function useServerSpectrogram(currentFFT: number): ServerSpectrogramResult {
  const {
    account,
    container,
    filePath,
    fftSize,
    fftStepSize,
    spectrogramHeight,
    spectrogramWidth,
    colmap,
    windowFunction,
    magnitudeMin,
    magnitudeMax,
    freqZoomCenterHz,
    freqZoomBandwidthHz,
    timeZoomIn,
  } = useSpectrogramContext();
  const freqZoom =
    freqZoomCenterHz != null && freqZoomBandwidthHz != null && freqZoomBandwidthHz > 0
      ? { freqCenterHz: freqZoomCenterHz, freqBandwidthHz: freqZoomBandwidthHz }
      : null;

  const [tileInfo, setTileInfo] = useState<TileInfo | null>(null);
  const [tileInfoZoomKey, setTileInfoZoomKey] = useState<string>('full');
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [imageOffsetY, setImageOffsetY] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const tileCache = useRef<Map<string, TileDbResult>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const paintedRef = useRef<PaintState | null>(null);
  const currentZoomKey = freqZoom ? `${freqZoom.freqCenterHz}:${freqZoom.freqBandwidthHz}` : 'full';

  useEffect(() => {
    if (!account || !container || !filePath) return;
    let cancelled = false;
    setTileInfo(null);
    tileCache.current.clear();
    paintedRef.current = null;
    const fetchZoomKey = currentZoomKey;
    fetchTileInfo(account, container, filePath, fftSize, freqZoom)
      .then((info) => {
        if (!cancelled) {
          setTileInfo(info);
          setTileInfoZoomKey(fetchZoomKey);
        }
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to fetch tile info:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [account, container, filePath, fftSize, freqZoomCenterHz, freqZoomBandwidthHz]);

  const zoom = useMemo(() => {
    if (!tileInfo) return 0;
    const desired = fftStepSize + 1;
    let pick = tileInfo.max_zoom;
    let pickRpr = 1;
    for (const key of Object.keys(tileInfo.zoom_levels)) {
      const z = parseInt(key, 10);
      const rpr = tileInfo.zoom_levels[z]?.rows_per_tile_row ?? 1;
      if (rpr <= desired && rpr > pickRpr) {
        pick = z;
        pickRpr = rpr;
      }
    }
    return pick;
  }, [tileInfo, fftStepSize]);

  useEffect(() => {
    if (!tileInfo || !account || !container || !filePath) return;
    if (tileInfoZoomKey !== currentZoomKey) return;

    const zoomLevel = tileInfo.zoom_levels[zoom];
    const rowsPerTileRow = zoomLevel?.rows_per_tile_row ?? 1;
    const tileHeightRows = tileInfo.tile_height;
    const effectiveFfts = zoomLevel?.effective_ffts ?? 0;
    const totalImagePx = (effectiveFfts * timeZoomIn) | 0;
    // rowsPerPixel in ORIGINAL FFT row units
    const rowsPerPixel = rowsPerTileRow / Math.max(1, timeZoomIn);
    const zoomKey = freqZoom ? `${freqZoom.freqCenterHz}:${freqZoom.freqBandwidthHz}` : 'full';

    // ---------------- FAST PATH ----------------
    // Viewport is still inside the currently painted oversized buffer and nothing
    // about the display params has changed — just slide the composite.
    const p = paintedRef.current;
    if (
      p &&
      p.colmap === colmap &&
      p.magMin === magnitudeMin &&
      p.magMax === magnitudeMax &&
      p.windowFn === windowFunction &&
      p.zoomKey === zoomKey &&
      p.zoom === zoom &&
      p.timeZoomIn === timeZoomIn &&
      p.rowsPerTileRow === rowsPerTileRow
    ) {
      const viewportOffsetPx = ((currentFFT - p.anchorFFT) / rowsPerTileRow) * timeZoomIn;
      const triggerPx = spectrogramHeight * TRIGGER_MARGIN_RATIO;
      const topOk = p.atTop || viewportOffsetPx >= triggerPx;
      const bottomOk = p.atBottom || viewportOffsetPx + spectrogramHeight <= p.bufferHeightPx - triggerPx;
      if (viewportOffsetPx >= 0 && viewportOffsetPx + spectrogramHeight <= p.bufferHeightPx && topOk && bottomOk) {
        setImageOffsetY(-viewportOffsetPx);
        return;
      }
    }

    // ---------------- SLOW PATH ----------------
    // Repaint oversized buffer centred on the current viewport.
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const desiredBufferPx = Math.max(spectrogramHeight, Math.min(totalImagePx || Infinity, BUFFER_MULTIPLIER * spectrogramHeight));
    const bufferHeightPx = totalImagePx > 0 ? Math.min(desiredBufferPx, totalImagePx) : desiredBufferPx;

    // Center the viewport within the buffer, clamped to recording bounds.
    let anchorFFT = Math.floor(currentFFT - ((bufferHeightPx - spectrogramHeight) / 2) * rowsPerPixel);
    const maxAnchorFFT = totalImagePx > 0 ? Math.max(0, Math.floor((totalImagePx - bufferHeightPx) * rowsPerPixel)) : anchorFFT;
    if (anchorFFT < 0) anchorFFT = 0;
    if (anchorFFT > maxAnchorFFT) anchorFFT = maxAnchorFFT;
    const atTop = anchorFFT === 0;
    const atBottom = anchorFFT === maxAnchorFFT;

    const bufferedIndices = getVisibleTiles(tileInfo, zoom, anchorFFT, bufferHeightPx);
    if (bufferedIndices.length === 0) {
      setLoading(false);
      return;
    }
    const bufferedKey = bufferedIndices.slice().sort((a, b) => a - b).join(',');

    const fetchOptions = {
      fftSize,
      window: windowFunction,
      signal: controller.signal,
      ...(freqZoom ? { freqCenterHz: freqZoom.freqCenterHz, freqBandwidthHz: freqZoom.freqBandwidthHz } : {}),
    };

    const composedTiles: Map<number, TileDbResult> = new Map();

    let refreshPending = false;
    const commit = () => {
      if (refreshPending || controller.signal.aborted) return;
      refreshPending = true;
      requestAnimationFrame(() => {
        refreshPending = false;
        if (controller.signal.aborted) return;
        const canvas = new OffscreenCanvas(spectrogramWidth, bufferHeightPx);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, spectrogramWidth, bufferHeightPx);
        for (const tile of composedTiles.values()) {
          if (tile.rows === 0 || tile.cols === 0) continue;
          const imgData = dbTileToImageData(tile.db, tile.rows, tile.cols, magnitudeMin, magnitudeMax, colmap);
          const scratch = new OffscreenCanvas(tile.cols, tile.rows);
          const sctx = scratch.getContext('2d');
          if (!sctx) continue;
          sctx.putImageData(imgData, 0, 0);
          const tileStartFFT = tile.timeIndex * tileHeightRows * rowsPerTileRow;
          const yOffset = ((tileStartFFT - anchorFFT) / rowsPerTileRow) * timeZoomIn;
          ctx.drawImage(scratch, 0, yOffset, spectrogramWidth, tile.rows * timeZoomIn);
        }
        const bmp = canvas.transferToImageBitmap();
        if (!controller.signal.aborted) {
          setImage(bmp);
          const viewportOffsetPx = ((currentFFT - anchorFFT) / rowsPerTileRow) * timeZoomIn;
          setImageOffsetY(-viewportOffsetPx);
        }
      });
    };

    const perTile = bufferedIndices.map(async (tileIndex) => {
      const cacheKey = `${zoom}/${tileIndex}/${windowFunction}/${zoomKey}`;
      const cached = tileCache.current.get(cacheKey);
      if (cached) {
        if (controller.signal.aborted) return;
        composedTiles.set(tileIndex, cached);
        commit();
        return;
      }
      try {
        const result = await fetchTileDb(account, container, filePath, zoom, tileIndex, fetchOptions);
        if (controller.signal.aborted) return;
        tileCache.current.set(cacheKey, result);
        if (tileCache.current.size > 200) {
          const firstKey = tileCache.current.keys().next().value;
          if (firstKey !== undefined) tileCache.current.delete(firstKey);
        }
        composedTiles.set(tileIndex, result);
        commit();
      } catch (err: any) {
        if (!controller.signal.aborted && err?.name !== 'AbortError') {
          console.error(`Failed to fetch tile ${zoom}/${tileIndex}:`, err);
        }
      }
    });

    Promise.allSettled(perTile).then(() => {
      if (!controller.signal.aborted) {
        setLoading(false);
        paintedRef.current = {
          anchorFFT,
          bufferHeightPx,
          atTop,
          atBottom,
          bufferedKey,
          colmap,
          magMin: magnitudeMin,
          magMax: magnitudeMax,
          windowFn: windowFunction,
          zoomKey,
          zoom,
          timeZoomIn,
          rowsPerTileRow,
        };
      }
    });

    return () => {
      controller.abort();
    };
  }, [
    tileInfo,
    tileInfoZoomKey,
    currentZoomKey,
    zoom,
    currentFFT,
    spectrogramHeight,
    spectrogramWidth,
    colmap,
    magnitudeMin,
    magnitudeMax,
    windowFunction,
    fftSize,
    fftStepSize,
    freqZoomCenterHz,
    freqZoomBandwidthHz,
    timeZoomIn,
    account,
    container,
    filePath,
  ]);

  return {
    image,
    imageOffsetY,
    ready: tileInfo !== null,
    loading,
    tileInfo,
  };
}
