/**
 * Hook for server-side spectrogram tile fetching and compositing.
 * Parallel rendering path — does not affect client-side FFT.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTile, fetchTileInfo, getVisibleTiles, TileInfo, TileResult } from '@/api/iqdata/TileClient';
import { useSpectrogramContext } from './use-spectrogram-context';

interface ServerSpectrogramResult {
  /** Composited ImageBitmap for the current viewport, or null if loading */
  image: ImageBitmap | null;
  /** Whether tile info has been loaded */
  ready: boolean;
  /** Whether tiles are currently being fetched */
  loading: boolean;
  /** Tile grid metadata */
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
  const tileCache = useRef<Map<string, TileResult>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const currentZoomKey = freqZoom ? `${freqZoom.freqCenterHz}:${freqZoom.freqBandwidthHz}` : 'full';

  // Fetch tile info when recording or FFT size changes
  useEffect(() => {
    if (!account || !container || !filePath) return;

    let cancelled = false;
    // Clear stale tile info before refetching — otherwise the tile-fetch effect will
    // briefly request tiles at the OLD max_zoom (e.g. 7) against the NEW freq-zoom
    // decimation (which may only have max_zoom=2) and server will 400.
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

  // Pick the zoom level whose `rows_per_tile_row` matches the Zoom Out Level slider.
  // fftStepSize = N means each displayed row should aggregate N+1 source FFT rows.
  // Choose the most-zoomed-out level whose rows_per_tile_row still fits within `desired`
  // (i.e. the largest rpr that is ≤ desired) so we don't over-aggregate.
  // At fftStepSize=0 → desired=1 → picks max_zoom (1:1).
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

  // Fetch visible tiles and composite them
  useEffect(() => {
    if (!tileInfo || !account || !container || !filePath) return;
    // Skip until the tileInfo matches the current zoom parameters. Otherwise a just-
    // changed freq zoom would ask the server for a zoom level that only existed in
    // the pre-zoom tile pyramid → 400.
    if (tileInfoZoomKey !== currentZoomKey) return;

    const visibleIndices = getVisibleTiles(tileInfo, zoom, currentFFT, spectrogramHeight);
    if (visibleIndices.length === 0) return;

    // Cancel previous fetch batch
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);

    const fetchOptions = {
      fftSize,
      window: windowFunction,
      cmap: colmap,
      magMin: magnitudeMin,
      magMax: magnitudeMax,
      signal: controller.signal,
      ...(freqZoom ? { freqCenterHz: freqZoom.freqCenterHz, freqBandwidthHz: freqZoom.freqBandwidthHz } : {}),
    };

    const zoomKey = freqZoom ? `${freqZoom.freqCenterHz}:${freqZoom.freqBandwidthHz}` : 'full';
    const zoomLevel = tileInfo.zoom_levels[zoom];
    const rowsPerTileRow = zoomLevel?.rows_per_tile_row ?? 1;
    const tileHeightRows = tileInfo.tile_height;

    // Incremental composition: blit each tile onto the composite canvas as it
    // resolves (from cache or network) and refresh the <Image> bitmap, rAF-
    // throttled. One slow tile no longer blocks the whole viewport from showing.
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

    const paintTile = (tile: TileResult) => {
      const tileStartFFT = tile.timeIndex * tileHeightRows * rowsPerTileRow;
      const yOffset = (tileStartFFT - currentFFT) / rowsPerTileRow;
      ctx.drawImage(tile.image, 0, yOffset, spectrogramWidth, tile.rows);
    };

    const perTile = visibleIndices.map(async (tileIndex) => {
      const cacheKey = `${zoom}/${tileIndex}/${colmap}/${magnitudeMin}/${magnitudeMax}/${windowFunction}/${zoomKey}`;
      const cached = tileCache.current.get(cacheKey);
      if (cached) {
        if (controller.signal.aborted) return;
        paintTile(cached);
        scheduleRefresh();
        return;
      }

      try {
        const result = await fetchTile(account, container, filePath, zoom, tileIndex, fetchOptions);
        if (controller.signal.aborted) return;
        tileCache.current.set(cacheKey, result);
        if (tileCache.current.size > 200) {
          const firstKey = tileCache.current.keys().next().value;
          if (firstKey !== undefined) tileCache.current.delete(firstKey);
        }
        paintTile(result);
        scheduleRefresh();
      } catch (err: any) {
        // AbortError during a scroll is expected — don't log.
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
  }, [tileInfo, tileInfoZoomKey, currentZoomKey, zoom, currentFFT, spectrogramHeight, spectrogramWidth, colmap, magnitudeMin, magnitudeMax, windowFunction, fftSize, fftStepSize, freqZoomCenterHz, freqZoomBandwidthHz, account, container, filePath]);

  return {
    image,
    ready: tileInfo !== null,
    loading,
    tileInfo,
  };
}
