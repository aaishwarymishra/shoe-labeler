import React, { useEffect, useRef } from "react";
import { lowerBound, upperBound } from "./utils";

function WaveformCanvas({
  points,
  labels,
  peaks,
  currentTime,
  windowSec,
  showPeaks,
  tone = "left"
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const width = Math.max(300, parent?.clientWidth || 900);
    const height = 260;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, width, height, points, labels, peaks, currentTime, windowSec, showPeaks, tone);
  }, [points, labels, peaks, currentTime, windowSec, showPeaks, tone]);

  return <canvas ref={canvasRef} className="timeline" />;
}

function draw(ctx, width, height, points, labels, peaks, currentTime, windowSec, showPeaks, tone) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfdff";
  ctx.fillRect(0, 0, width, height);

  const padLeft = 44;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 28;

  const t0 = Math.max(0, currentTime - windowSec);
  const t1 = currentTime + windowSec;
  const domain = Math.max(0.001, t1 - t0);

  const start = lowerBound(points, t0);
  const end = upperBound(points, t1);
  const visible = points.slice(start, end);

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of visible) {
    if (p.value < minY) minY = p.value;
    if (p.value > maxY) maxY = p.value;
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    minY = -1;
    maxY = 1;
  }
  if (minY === maxY) {
    minY -= 1;
    maxY += 1;
  }

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xFromT = (t) => padLeft + ((t - t0) / domain) * plotW;
  const yFromV = (v) => padTop + (1 - (v - minY) / (maxY - minY)) * plotH;

  drawGrid(ctx, padLeft, padTop, plotW, plotH);

  if (visible.length >= 2) {
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = tone === "right" ? "#14532d" : "#7f1d1d";
    ctx.moveTo(xFromT(visible[0].t), yFromV(visible[0].value));
    for (let i = 1; i < visible.length; i += 1) {
      ctx.lineTo(xFromT(visible[i].t), yFromV(visible[i].value));
    }
    ctx.stroke();
  }

  if (showPeaks) {
    const peakStart = lowerBound(peaks, t0);
    const peakEnd = upperBound(peaks, t1);
    ctx.fillStyle = "#f59e0b";
    for (let i = peakStart; i < peakEnd; i += 1) {
      const p = peaks[i];
      ctx.beginPath();
      ctx.arc(xFromT(p.t), yFromV(p.value), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const label of labels) {
    if (label.time < t0 || label.time > t1) continue;
    const x = xFromT(label.time);
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.lineWidth = 2;
    ctx.strokeStyle = label.sensor === "left" ? "#dc2626" : "#16a34a";
    ctx.stroke();
  }

  const cursorX = xFromT(currentTime);
  ctx.beginPath();
  ctx.moveTo(cursorX, padTop);
  ctx.lineTo(cursorX, padTop + plotH);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#0369a1";
  ctx.stroke();

  ctx.fillStyle = "#334155";
  ctx.font = "12px sans-serif";
  ctx.fillText(`${t0.toFixed(2)}s`, padLeft, height - 8);
  ctx.fillText(`${currentTime.toFixed(2)}s`, cursorX + 4, height - 8);
  ctx.fillText(`${t1.toFixed(2)}s`, width - 56, height - 8);

  ctx.fillStyle = "#64748b";
  ctx.fillText(maxY.toFixed(2), 4, padTop + 10);
  ctx.fillText(minY.toFixed(2), 4, padTop + plotH);
}

function drawGrid(ctx, x, y, w, h) {
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  const hLines = 4;
  for (let i = 1; i < hLines; i += 1) {
    const yy = y + (i / hLines) * h;
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
    ctx.stroke();
  }
}

export default WaveformCanvas;
