import React, { useEffect, useRef, useState } from 'react';
import { VIRIDIS_LUT } from './colormap-viridis';
import { PLOT_MARGIN_LEFT, PLOT_MARGIN_RIGHT } from './plot-geometry';

interface Props {
  active: boolean;
  fftSize?: number;
  frameRate?: number;
  /** Display scaling (same semantics as SpectrumPlot) */
  minDb?: number;
  maxDb?: number;
  refOffsetDb?: number;
  height?: number;
  paused?: boolean;
  /** Notch DC bins server-side to hide the LO leakage spike. */
  dcRemove?: boolean;
}

/**
 * Waterfall driven by the /api/sdr/monitor/spectrum WS — one row per FFT frame,
 * colored client-side with the viridis LUT. Uses a persistent offscreen canvas
 * to cheaply scroll the image downward each frame.
 */
export function SpectrumWaterfall({
  active,
  fftSize = 4096,
  frameRate = 10,
  minDb = -100,
  maxDb = -10,
  refOffsetDb = 0,
  height = 360,
  paused = false,
  dcRemove = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingMetaRef = useRef<any>(null);
  const rowBufferRef = useRef<ImageData | null>(null);
  const [status, setStatus] = useState('idle');

  // Keep latest display params in refs so the WS onmessage handler sees them
  // without re-subscribing whenever the user tweaks them.
  const minDbRef = useRef(minDb);
  const maxDbRef = useRef(maxDb);
  const offsetRef = useRef(refOffsetDb);
  const pausedRef = useRef(paused);
  useEffect(() => { minDbRef.current = minDb; }, [minDb]);
  useEffect(() => { maxDbRef.current = maxDb; }, [maxDb]);
  useEffect(() => { offsetRef.current = refOffsetDb; }, [refOffsetDb]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Resize canvas buffer to the element's CSS size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sync = () => {
      const dpr = 1; // Keep waterfall 1:1 to keep scroll cheap; pixelated CSS handles upscaling.
      const cw = canvas.clientWidth;
      const desiredW = Math.max(1, Math.floor(cw * dpr));
      if (canvas.width !== desiredW || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = desiredW;
        canvas.height = Math.floor(height * dpr);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = 'black';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [height]);

  useEffect(() => {
    if (!active) {
      wsRef.current?.close();
      wsRef.current = null;
      setStatus('idle');
      return;
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/api/sdr/monitor/spectrum?fft_size=${fftSize}&frame_rate=${frameRate}&dc_remove=${dcRemove ? 1 : 0}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => setStatus('live');

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'config') {
          // Size the row buffer once
          rowBufferRef.current = null;
        } else if (msg.type === 'frame') {
          pendingMetaRef.current = msg;
        } else if (msg.type === 'stopped') {
          setStatus('stopped');
        }
      } else if (ev.data instanceof ArrayBuffer && pendingMetaRef.current) {
        pendingMetaRef.current = null;
        if (pausedRef.current) return;
        drawRow(canvasRef.current, rowBufferRef, new Float32Array(ev.data), {
          minDb: minDbRef.current,
          maxDb: maxDbRef.current,
          offset: offsetRef.current,
        });
      }
    };
    ws.onerror = () => setStatus('error');
    ws.onclose = () => { if (wsRef.current === ws) setStatus('closed'); };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [active, fftSize, frameRate, dcRemove]);

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height, imageRendering: 'pixelated' }}
        className="bg-black"
      />
      <div className="absolute top-1 left-2 text-[10px] tracking-wider opacity-60">{status.toUpperCase()}</div>
    </div>
  );
}

function drawRow(
  canvas: HTMLCanvasElement | null,
  rowBufferRef: React.MutableRefObject<ImageData | null>,
  frame: Float32Array,
  opts: { minDb: number; maxDb: number; offset: number }
) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) return;

  // The waterfall shares its x-range with the spectrum plot above. Pixels outside
  // the plot area stay black so the two canvases line up.
  const dpr = 1; // we sync the waterfall at dpr=1 in the resize effect
  const plotL = Math.min(w, Math.max(0, Math.floor(PLOT_MARGIN_LEFT * dpr)));
  const plotR = Math.min(w, Math.max(plotL, w - Math.floor(PLOT_MARGIN_RIGHT * dpr)));
  const plotW = plotR - plotL;

  // Scroll existing image down by 1 px, then draw the new row at the top.
  ctx.drawImage(canvas, 0, 0, w, h, 0, 1, w, h - 1);

  // Build/refresh a row ImageData of full canvas width so we can paint the
  // whole top row in one putImageData, keeping the margins black.
  let rowImg = rowBufferRef.current;
  if (!rowImg || rowImg.width !== w) {
    rowImg = ctx.createImageData(w, 1);
    rowBufferRef.current = rowImg;
  }
  const rowData = rowImg.data;
  // Zero all (makes margins black and sets alpha below)
  rowData.fill(0);

  const { minDb, maxDb, offset } = opts;
  const span = Math.max(1, maxDb - minDb);
  const n = frame.length;
  const binsPerCol = Math.max(1 / n, n / Math.max(1, plotW));

  for (let px = plotL; px < plotR; px++) {
    const col = px - plotL;
    const start = Math.floor(col * binsPerCol);
    const end = Math.max(start + 1, Math.floor((col + 1) * binsPerCol));
    let peak = -Infinity;
    for (let i = start; i < end && i < n; i++) {
      if (frame[i] > peak) peak = frame[i];
    }
    const v = (isFinite(peak) ? peak : minDb) + offset;
    const t = (v - minDb) / span;
    const idx = Math.max(0, Math.min(255, Math.floor(t * 255)));
    const lutOff = idx * 3;
    const pxOff = px * 4;
    rowData[pxOff] = VIRIDIS_LUT[lutOff];
    rowData[pxOff + 1] = VIRIDIS_LUT[lutOff + 1];
    rowData[pxOff + 2] = VIRIDIS_LUT[lutOff + 2];
    rowData[pxOff + 3] = 255;
  }

  // Set alpha=255 on the margins too so black is opaque (not transparent)
  for (let px = 0; px < plotL; px++) rowData[px * 4 + 3] = 255;
  for (let px = plotR; px < w; px++) rowData[px * 4 + 3] = 255;

  ctx.putImageData(rowImg, 0, 0);
}
