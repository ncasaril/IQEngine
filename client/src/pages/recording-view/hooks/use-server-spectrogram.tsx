/**
 * Hook for server-side spectrogram tile fetching and compositing.
 * Parallel rendering path — does not affect client-side FFT.
 *
 * Tiles are fetched as raw-dB float32 from the server and the colormap + magnitude
 * scaling is applied in the browser. This decouples the tile cache from the
 * colormap / dB slider / magnitude settings.
 *
 * Scroll optimisation: when a scroll doesn't change which tiles are visible, we
 * skip the canvas repaint entirely and just slide the Konva Image via the
 * returned imageOffsetY. The heavy compose (fetch → recolor → blit → transfer)
 * only fires when a tile boundary is crossed, a dependency changes, or a new
 * tile arrives from the network.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchTileDb, fetchTileInfo, getVisibleTiles, TileDbResult, TileInfo } from '@/api/iqdata/TileClient';
import { dbTileToImageData } from '@/pages/recording-view/utils/db-tile-render';
import { useSpectrogramContext } from './use-spectrogram-context';

interface ServerSpectrogramResult {
  image: ImageBitmap | null;
  imageOffsetY: number;
  ready: boolean;
  loading: boolean;
  tileInfo: TileInfo | null;
}

interface PaintState {
  anchorFFT: number;
  visibleKey: string;
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

    const visibleIndices = getVisibleTiles(tileInfo, zoom, currentFFT, spectrogramHeight);
    if (visibleIndices.length === 0) return;
    const visibleKey = visibleIndices.slice().sort((a, b) => a - b).join(',');

    const zoomLevel = tileInfo.zoom_levels[zoom];
    const rowsPerTileRow = zoomLevel?.rows_per_tile_row ?? 1;
    const tileHeightRows = tileInfo.tile_height;
    const zoomKey = freqZoom ? `${freqZoom.freqCenterHz}:${freqZoom.freqBandwidthHz}` : 'full';

    // ---------------- FAST PATH ----------------
    // Same tiles, same colors, same zoom settings — only currentFFT moved. The
    // already-painted image is still valid; just shift it on the Konva stage.
    const p = paintedRef.current;
    const canShift =
      p &&
      p.visibleKey === visibleKey &&
      p.colmap === colmap &&
      p.magMin === magnitudeMin &&
      p.magMax === magnitudeMax &&
      p.windowFn === windowFunction &&
      p.zoomKey === zoomKey &&
      p.zoom === zoom &&
      p.timeZoomIn === timeZoomIn &&
      p.rowsPerTileRow === rowsPerTileRow;

    if (canShift) {
      const yShift = ((p.anchorFFT - currentFFT) / rowsPerTileRow) * timeZoomIn;
      setImageOffsetY(yShift);
      return;
    }

    // ---------------- SLOW PATH ----------------
    // Tile set or display parameters changed: abort in-flight fetches and
    // fully re-compose.
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const anchorFFT = currentFFT;
    setImageOffsetY(0);

    const fetchOptions = {
      fftSize,
      window: windowFunction,
      signal: controller.signal,
      ...(freqZoom ? { freqCenterHz: freqZoom.freqCenterHz, freqBandwidthHz: freqZoom.freqBandwidthHz } : {}),
    };

    // Keep track of tiles currently composed so we can re-composite on
    // progressive arrival without re-running dbTileToImageData for the ones
    // already blitted in this pass.
    const composedTiles: Map<number, TileDbResult> = new Map();

    let refreshPending = false;
    const commit = () => {
      if (refreshPending || controller.signal.aborted) return;
      refreshPending = true;
      requestAnimationFrame(() => {
        refreshPending = false;
        if (controller.signal.aborted) return;
        // Fresh canvas per commit so transferToImageBitmap has something to move
        // without poking a long-lived OffscreenCanvas.
        const canvas = new OffscreenCanvas(spectrogramWidth, spectrogramHeight);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, spectrogramWidth, spectrogramHeight);
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
        // transferToImageBitmap is a zero-copy handoff (no PNG encode/decode),
        // dropping ~10-40 ms per commit vs the old convertToBlob → createImageBitmap.
        const bmp = canvas.transferToImageBitmap();
        if (!controller.signal.aborted) setImage(bmp);
      });
    };

    const perTile = visibleIndices.map(async (tileIndex) => {
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
        // Only record the paint state when all visible tiles have been accounted
        // for — otherwise a subsequent "same tiles" scroll would short-circuit
        // while part of the viewport is still black.
        paintedRef.current = {
          anchorFFT,
          visibleKey,
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
