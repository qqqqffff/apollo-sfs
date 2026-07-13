import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import { colors } from '../theme';

export interface LinePoint {
  x: number; // epoch ms
  y: number;
}

interface Props {
  points: LinePoint[];
  width: number;
  height: number;
  color: string;
  formatY?: (v: number) => string;
  formatX?: (ms: number) => string;
}

function defaultFormatY(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(1)} TB`;
  if (abs >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (abs >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (abs >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

function defaultFormatX(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const PAD_LEFT = 52;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 22;

// A time-series line graph mirroring the web's LineGraph: a single colored
// series with three horizontal gridlines, y labels on the left, and start/end
// timestamps along the bottom.
export function LineGraph({ points, width, height, color, formatY, formatX }: Props) {
  const fmtY = formatY ?? defaultFormatY;
  const fmtX = formatX ?? defaultFormatX;

  if (points.length < 2) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 12, color: colors.textMuted }}>Not enough data yet</Text>
      </View>
    );
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  if (minY === maxY) {
    // Flat series — pad so the line sits mid-graph.
    minY = minY - (Math.abs(minY) || 1) * 0.1;
    maxY = maxY + (Math.abs(maxY) || 1) * 0.1;
  }

  const plotW = width - PAD_LEFT - PAD_RIGHT;
  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const toX = (x: number) => PAD_LEFT + ((x - minX) / (maxX - minX || 1)) * plotW;
  const toY = (y: number) => PAD_TOP + (1 - (y - minY) / (maxY - minY || 1)) * plotH;

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.x).toFixed(1)},${toY(p.y).toFixed(1)}`)
    .join(' ');

  const gridYs = [minY, (minY + maxY) / 2, maxY];

  return (
    <Svg width={width} height={height}>
      {gridYs.map((gy, i) => (
        <React.Fragment key={i}>
          <Line
            x1={PAD_LEFT}
            y1={toY(gy)}
            x2={width - PAD_RIGHT}
            y2={toY(gy)}
            stroke={colors.divider}
            strokeWidth={1}
          />
          <SvgText
            x={PAD_LEFT - 6}
            y={toY(gy) + 3}
            fontSize={9}
            fill={colors.textMuted}
            textAnchor="end"
          >
            {fmtY(gy)}
          </SvgText>
        </React.Fragment>
      ))}
      <Path d={path} stroke={color} strokeWidth={1.5} fill="none" />
      <SvgText x={PAD_LEFT} y={height - 6} fontSize={9} fill={colors.textMuted} textAnchor="start">
        {fmtX(minX)}
      </SvgText>
      <SvgText x={width - PAD_RIGHT} y={height - 6} fontSize={9} fill={colors.textMuted} textAnchor="end">
        {fmtX(maxX)}
      </SvgText>
    </Svg>
  );
}
