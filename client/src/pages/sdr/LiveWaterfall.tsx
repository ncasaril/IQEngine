import React, { useCallback, useEffect, useRef, useState } from 'react';

interface LiveWaterfallProps {
  /** Whether the monitor is currently running */
  active: boolean;
  /** WebSocket query params */
  fftSize?: number;
  cmap?: string;
  maxRows?: number;
  /** Canvas height in pixels */
  height?: number;
}

interface WaterfallConfig {
  session_id: string;
  fft_size: number;
  center_freq_hz: number;
  sample_rate_hz: number;
}

export function LiveWaterfall({ active, fftSize = 1024, cmap = 'viridis', maxRows = 64, height = 400 }: LiveWaterfallProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [config, setConfig] = useState<WaterfallConfig | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<string>('Connecting...');
  // Track whether we're expecting a metadata frame (text) or PNG frame (binary)
  const expectingPngRef = useRef(false);
  const stripMetaRef = useRef<{ rows: number; cols: number } | null>(null);

  const drawStrip = useCallback(
    async (pngBlob: Blob, rows: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const bmp = await createImageBitmap(pngBlob);

      // Shift existing content down by `rows` pixels, then draw new strip at top
      if (rows < canvas.height) {
        const existing = ctx.getImageData(0, 0, canvas.width, canvas.height - rows);
        ctx.putImageData(existing, 0, rows);
      }

      ctx.drawImage(bmp, 0, 0, canvas.width, rows);
      bmp.close();
    },
    []
  );

  useEffect(() => {
    if (!active) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
      setStatus('Monitor not running');
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/api/sdr/monitor/live?fft_size=${fftSize}&cmap=${cmap}&max_rows=${maxRows}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    expectingPngRef.current = false;

    ws.binaryType = 'blob';

    ws.onopen = () => {
      setConnected(true);
      setStatus('Connected, waiting for data...');
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // JSON text frame
        const msg = JSON.parse(ev.data);
        if (msg.type === 'config') {
          setConfig(msg);
          setStatus(`Live — ${(msg.center_freq_hz / 1e6).toFixed(1)} MHz`);
        } else if (msg.type === 'strip') {
          // Next binary frame will be the PNG
          stripMetaRef.current = { rows: msg.rows, cols: msg.cols };
          expectingPngRef.current = true;
          setStatus(
            `Live — ${(msg.center_freq_hz / 1e6).toFixed(1)} MHz — segment #${msg.segment_index}`
          );
        } else if (msg.type === 'stopped') {
          setStatus('Monitor stopped');
          setConnected(false);
        } else if (msg.type === 'error') {
          setStatus(`Error: ${msg.error}`);
        }
      } else if (ev.data instanceof Blob && expectingPngRef.current) {
        // Binary PNG frame
        expectingPngRef.current = false;
        const meta = stripMetaRef.current;
        if (meta) {
          drawStrip(ev.data, meta.rows);
        }
      }
    };

    ws.onerror = () => {
      setStatus('WebSocket error');
      setConnected(false);
    };

    ws.onclose = () => {
      setConnected(false);
      if (active) {
        setStatus('Disconnected — will retry...');
        // Auto-reconnect after 2s if monitor still active
        setTimeout(() => {
          // The effect will re-run if `active` is still true and ws is null
          wsRef.current = null;
        }, 2000);
      }
    };

    // Clear the canvas on new connection
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [active, fftSize, cmap, maxRows, drawStrip]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-500'}`} />
        <span className="text-xs opacity-70">{status}</span>
        {config && (
          <span className="text-xs opacity-50 ml-auto">
            FFT {config.fft_size} | {(config.sample_rate_hz / 1e6).toFixed(1)} Msps
          </span>
        )}
      </div>
      <canvas
        ref={canvasRef}
        width={fftSize}
        height={height}
        className="w-full bg-black"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
}
