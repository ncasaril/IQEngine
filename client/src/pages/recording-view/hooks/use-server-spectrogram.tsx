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
  const { account, container, filePath, fftSize, fftStepSize, spectrogramHeight, spectrogramWidth, colmap, windowFunction, magnitudeMin, magnitudeMax } =
    useSpectrogramContext();

  const [tileInfo, setTileInfo] = useState<TileInfo | null>(null);
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [loading, setLoading] = useState(false);
  const tileCache = useRef<Map<string, TileResult>>(new Map());
  const abortRef = useRef<AbortController | null>(null);

  // Fetch tile info when recording or FFT size changes
  useEffect(() => {
    if (!account || !container || !filePath) return;

    let cancelled = false;
    fetchTileInfo(account, container, filePath, fftSize)
      .then((info) => {
        if (!cancelled) {
          setTileInfo(info);
          tileCache.current.clear();
        }
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to fetch tile info:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [account, container, filePath, fftSize]);

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
    };

    // Check cache, fetch missing tiles
    const promises = visibleIndices.map(async (tileIndex) => {
      const cacheKey = `${zoom}/${tileIndex}/${colmap}/${magnitudeMin}/${magnitudeMax}/${windowFunction}`;
      const cached = tileCache.current.get(cacheKey);
      if (cached) return cached;

      try {
        const result = await fetchTile(account, container, filePath, zoom, tileIndex, fetchOptions);
        tileCache.current.set(cacheKey, result);

        // Evict old entries if cache too large
        if (tileCache.current.size > 200) {
          const firstKey = tileCache.current.keys().next().value;
          if (firstKey !== undefined) tileCache.current.delete(firstKey);
        }

        return result;
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error(`Failed to fetch tile ${zoom}/${tileIndex}:`, err);
        }
        return null;
      }
    });

    Promise.all(promises).then((tiles) => {
      if (controller.signal.aborted) return;

      const validTiles = tiles.filter((t): t is TileResult => t !== null);
      if (validTiles.length === 0) {
        setLoading(false);
        return;
      }

      // Composite tiles onto an offscreen canvas
      const canvas = new OffscreenCanvas(spectrogramWidth, spectrogramHeight);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setLoading(false);
        return;
      }

      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, spectrogramWidth, spectrogramHeight);

      const zoomLevel = tileInfo.zoom_levels[zoom];
      const rowsPerTileRow = zoomLevel?.rows_per_tile_row ?? 1;
      const tileHeight = tileInfo.tile_height;

      for (const tile of validTiles) {
        // Calculate Y position of this tile in the viewport
        const tileStartFFT = tile.timeIndex * tileHeight * rowsPerTileRow;
        const yOffset = (tileStartFFT - currentFFT) / rowsPerTileRow;

        // Scale tile to fill viewport width
        ctx.drawImage(tile.image, 0, yOffset, spectrogramWidth, tile.rows);
      }

      canvas.convertToBlob().then((blob) => {
        if (controller.signal.aborted) return;
        createImageBitmap(blob).then((bmp) => {
          if (!controller.signal.aborted) {
            setImage(bmp);
            setLoading(false);
          }
        });
      });
    });

    return () => {
      controller.abort();
    };
  }, [tileInfo, zoom, currentFFT, spectrogramHeight, spectrogramWidth, colmap, magnitudeMin, magnitudeMax, windowFunction, fftSize, fftStepSize, account, container, filePath]);

  return {
    image,
    ready: tileInfo !== null,
    loading,
    tileInfo,
  };
}
