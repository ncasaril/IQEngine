// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

import React, { useState, useEffect } from 'react';
import { Layer, Rect, Text } from 'react-konva';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';

interface RulerSideProps {
  currentRowAtTop: number;
}

const RulerSide = ({ currentRowAtTop }: RulerSideProps) => {
  const { meta, fftSize, spectrogramHeight, spectrogramWidth, fftStepSize, timeZoomIn } = useSpectrogramContext();

  const [ticks, setTicks] = useState([]);
  const [labels, setLabels] = useState([]);

  useEffect(() => {
    // Draw the vertical time scale.
    //
    // One pixel of viewport covers `rowsPerPixel` source FFT rows, so the time
    // represented by `i` pixels is `i * rowsPerPixel * fftSize / sampleRate`.
    // Zoom Out increases rowsPerPixel (more time per pixel); Zoom In decreases
    // it (less time per pixel).
    //
    // Pick a single unit for the whole ruler based on the biggest tick value —
    // mixing ms and s within one ruler made the numbers look non-monotonic.
    const sampleRate = meta.getSampleRate();
    const rowsPerPixel = (fftStepSize + 1) / Math.max(1, timeZoomIn);
    const num_ticks = Math.floor(spectrogramHeight / 10) + 1;
    // Seconds per pixel at the current zoom.
    const secondsPerPixel = (rowsPerPixel * fftSize) / sampleRate;
    const topSeconds = (currentRowAtTop * fftSize) / sampleRate;
    const bottomSeconds = topSeconds + secondsPerPixel * (num_ticks * 10);

    // Choose unit + precision once, based on the largest value we'll render.
    let divisor: number;
    let unit: string;
    const biggest = Math.max(Math.abs(topSeconds), Math.abs(bottomSeconds));
    if (biggest >= 1) {
      divisor = 1;
      unit = 's';
    } else if (biggest >= 1e-3) {
      divisor = 1e-3;
      unit = 'ms';
    } else {
      divisor = 1e-6;
      unit = 'µs';
    }

    const temp_ticks = [];
    const temp_labels = [];
    for (let i = 0; i < num_ticks; i++) {
      if (i % 10 === 0) {
        temp_ticks.push({ x: 0, y: i * 10, width: 10, height: 0 });
        const t = (topSeconds + secondsPerPixel * i * 10) / divisor;
        const rounded = Math.round(t * 100) / 100;
        // Unit on every label — the ruler is only ~50 px wide, and showing it
        // only at the top meant the suffix was off-screen on initial load and
        // users had no way to know whether the numbers were ms, s, or µs.
        temp_labels.push({
          text: `${rounded} ${unit}`,
          x: 10,
          y: i * 10 - 7,
        });
      } else {
        temp_ticks.push({ x: 0, y: i * 10, width: 5, height: 0 });
      }
    }
    setTicks(temp_ticks);
    setLabels(temp_labels);
  }, [fftSize, meta.getSampleRate(), spectrogramHeight, spectrogramWidth, currentRowAtTop, fftStepSize, timeZoomIn]);

  if (ticks.length > 1) {
    return (
      <Layer>
        {ticks.map((tick, index) => (
          // couldnt get Line to work, kept getting NaN errors, so just using Rect instead
          <Rect
            x={tick.x}
            y={tick.y}
            width={tick.width}
            height={tick.height}
            fillEnabled={false}
            stroke="white"
            strokeWidth={1}
            key={index + 2000000}
          />
        ))}
        {labels.map((label, index) => (
          // for Text params see https://konvajs.org/api/Konva.Text.html
          <Text
            text={label.text}
            fontFamily="serif"
            fontSize={16}
            x={label.x}
            y={label.y}
            fill="white"
            key={index + 3000000}
            align="center"
          />
        ))}
      </Layer>
    );
  } else {
    return <></>;
  }
};

export { RulerSide };
