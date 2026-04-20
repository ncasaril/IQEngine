/**
 * Hook for server-side spectrogram tile fetching and compositing.
 * Parallel rendering path — does not affect client-side FFT.
 *
 * Tiles are fetched as raw-dB float32 from the server and the colormap + magnitude
 * scaling is applied in the browser. This decouples the tile cache from the
 * colormap / dB slider / magnitude settings: changing them is a free re-composite
 * from cached dB arrays, no network.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchTileDb, fetchTileInfo, getVisibleTiles, TileDbResult, TileInfo } from '@/api/iqdata/TileClient';
import { dbTileToImageData } from '@/pages/recording-view/utils/db-tile-render';
import { useSpectrogramContext } from './use-spectrogram-context';

interface ServerSpectrogramResult {
  image: ImageBitmap | null;
  ready: boolean;
  loading: boolean;
  tileInfo: TileInfo | null;
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
  } = useSpectrogramContext();
  const freqZoom =
    freqZoomCenterHz != null && freqZoomBandwidthHz != null && freqZoomBandwidthHz > 0
      ? { freqCenterHz: freqZoomCenterHz, freqBandwidthHz: freqZoomBandwidthHz }
      : null;

  const [tileInfo, setTileInfo] = useState<TileInfo | null>(null);
  const [tileInfoZoomKey, setTileInfoZoomKey] = useState<string>('full');
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [loading, setLoading] = useState(false);
  const tileCache = useRef<Map<string, TileDbResult>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const currentZoomKey = freqZoom ? `${freqZoom.freqCenterHz}:${freqZoom.freqBandwidthHz}` : 'full';

  useEffect(() => {
    if (!account || !container || !filePath) return;
    let cancelled = false;
    setTileInfo(null);
    tileCache.current.clear();
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

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const fetchOptions = {
      fftSize,
      window: windowFunction,
      signal: controller.signal,
      ...(freqZoom ? { freqCenterHz: freqZoom.freqCenterHz, freqBandwidthHz: freqZoom.freqBandwidthHz } : {}),
    };

    const zoomKey = freqZoom ? `${freqZoom.freqCenterHz}:${freqZoom.freqBandwidthHz}` : 'full';
    const zoomLevel = tileInfo.zoom_levels[zoom];
    const rowsPerTileRow = zoomLevel?.rows_per_tile_row ?? 1;
    const tileHeightRows = tileInfo.tile_height;

    const canvas = new OffscreenCanvas(spectrogramWidth, spectrogramHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setLoading(false);
      return;
    }
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, spectrogramWidth, spectrogramHeight);

    let refreshPending = false;
    const scheduleRefresh = () => {
      if (refreshPending || controller.signal.aborted) return;
      refreshPending = true;
      requestAnimationFrame(() => {
        refreshPending = false;
        if (controller.signal.aborted) return;
        canvas.convertToBlob().then((blob) => {
          if (controller.signal.aborted) return;
          createImageBitmap(blob).then((bmp) => {
            if (!controller.signal.aborted) setImage(bmp);
          });
        });
      });
    };

    // Render a dB tile with the CURRENT colormap + magnitude slider values, then
    // blit onto the composite canvas at the right Y. Colormap / mag aren't part of
    // the cache key, so slider changes just re-run this pass on cached tiles.
    const paintTile = (tile: TileDbResult) => {
      if (tile.rows === 0 || tile.cols === 0) return;
      const imgData = dbTileToImageData(tile.db, tile.rows, tile.cols, magnitudeMin, magnitudeMax, colmap);
      // Put onto a scratch canvas so we can draw-scale it to spectrogramWidth.
      const scratch = new OffscreenCanvas(tile.cols, tile.rows);
      const sctx = scratch.getContext('2d');
      if (!sctx) return;
      sctx.putImageData(imgData, 0, 0);
      const tileStartFFT = tile.timeIndex * tileHeightRows * rowsPerTileRow;
      const yOffset = (tileStartFFT - currentFFT) / rowsPerTileRow;
      ctx.drawImage(scratch, 0, yOffset, spectrogramWidth, tile.rows);
    };

    const perTile = visibleIndices.map(async (tileIndex) => {
      const cacheKey = `${zoom}/${tileIndex}/${windowFunction}/${zoomKey}`;
      const cached = tileCache.current.get(cacheKey);
      if (cached) {
        if (controller.signal.aborted) return;
        paintTile(cached);
        scheduleRefresh();
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
        paintTile(result);
        scheduleRefresh();
      } catch (err: any) {
        if (!controller.signal.aborted && err?.name !== 'AbortError') {
          console.error(`Failed to fetch tile ${zoom}/${tileIndex}:`, err);
        }
      }
    });

    Promise.allSettled(perTile).then(() => {
      if (!controller.signal.aborted) setLoading(false);
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
    account,
    container,
    filePath,
  ]);

  return {
    image,
    ready: tileInfo !== null,
    loading,
    tileInfo,
  };
}
