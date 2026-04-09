import React, { useEffect, useMemo, useRef, useState } from "react";
import WaveformCanvas from "./WaveformCanvas";
import { buildSignal, computePeaks, parseSensorText, snapToNearestPeakDetail } from "./utils";

const CHANNEL_OPTIONS = [
  "accel_mag",
  "gyro_mag",
  "accel_x",
  "accel_y",
  "accel_z",
  "gyro_x",
  "gyro_y",
  "gyro_z",
  "value"
];

function Section({ title, hint, open, onToggle, children }) {
  return (
    <div className="accordion">
      <button className="accordion-head" onClick={onToggle} type="button">
        <span>{title}</span>
        <span className="muted">{hint}</span>
        <span className="chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open ? <div className="accordion-body">{children}</div> : null}
    </div>
  );
}

function Badge({ ok, label }) {
  return <span className={`badge ${ok ? "ok" : "warn"}`}>{label}</span>;
}

function App() {
  const [videoUrl, setVideoUrl] = useState("");
  const [videoUrlInput, setVideoUrlInput] = useState("");
  const [videoMode, setVideoMode] = useState("file");

  const [leftRaw, setLeftRaw] = useState([]);
  const [rightRaw, setRightRaw] = useState([]);
  const [leftUrlInput, setLeftUrlInput] = useState("");
  const [rightUrlInput, setRightUrlInput] = useState("");
  const [leftMode, setLeftMode] = useState("file");
  const [rightMode, setRightMode] = useState("file");
  const [loadingLeft, setLoadingLeft] = useState(false);
  const [loadingRight, setLoadingRight] = useState(false);

  const [channel, setChannel] = useState("accel_mag");
  const [labels, setLabels] = useState([]);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [windowSec, setWindowSec] = useState(2);
  const [snapRadius, setSnapRadius] = useState(0.25);
  const [showPeaks, setShowPeaks] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Load video + both sensor CSVs to start.");

  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [labelingOpen, setLabelingOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const videoRef = useRef(null);

  const leftPoints = useMemo(() => buildSignal(leftRaw, channel, "all"), [leftRaw, channel]);
  const rightPoints = useMemo(() => buildSignal(rightRaw, channel, "all"), [rightRaw, channel]);
  const leftPeaks = useMemo(() => computePeaks(leftPoints), [leftPoints]);
  const rightPeaks = useMemo(() => computePeaks(rightPoints), [rightPoints]);

  const leftLabels = useMemo(() => labels.filter((l) => l.sensor === "left"), [labels]);
  const rightLabels = useMemo(() => labels.filter((l) => l.sensor === "right"), [labels]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "1") {
        e.preventDefault();
        addLabel("left", "left");
      } else if (e.key === "2") {
        e.preventDefault();
        addLabel("right", "right");
      } else if (e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setCurrentTime(video.currentTime || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);

    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
  }, [speed]);

  function labelKey(label) {
    return `${label.sensor}|${label.type}|${label.time.toFixed(6)}`;
  }

  function dedupeLabels(list) {
    const seen = new Set();
    const out = [];
    for (const l of list) {
      const k = labelKey(l);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
    return out.sort((a, b) => a.time - b.time);
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function addLabel(sensor, type) {
    const video = videoRef.current;
    if (!video) return;
    const sourcePoints = sensor === "left" ? leftPoints : rightPoints;
    if (!sourcePoints.length) {
      setStatus(`Load ${sensor} sensor before labeling.`);
      return;
    }

    const rawVideoTime = video.currentTime || 0;
    const snap = snapToNearestPeakDetail(sourcePoints, rawVideoTime, snapRadius);
    const label = {
      time: snap.time,
      type,
      sensor,
      video_time: rawVideoTime,
      sample_index: snap.sampleIndex,
      snap_source: snap.snapSource
    };

    setUndoStack((stack) => [...stack, labels]);
    setRedoStack([]);

    setLabels((prev) => {
      const k = labelKey(label);
      if (prev.some((l) => labelKey(l) === k)) {
        setStatus(`Duplicate ignored @ ${label.time.toFixed(3)}s (${sensor}).`);
        return prev;
      }
      const next = dedupeLabels([...prev, label]);
      setStatus(`Added ${sensor} step @ ${label.time.toFixed(3)}s (snap: ${snap.snapSource}).`);
      return next;
    });
  }

  function undo() {
    setUndoStack((stack) => {
      if (!stack.length) return stack;
      const prevState = stack[stack.length - 1];
      setRedoStack((redo) => [labels, ...redo]);
      setLabels(prevState);
      setStatus("Undo");
      return stack.slice(0, -1);
    });
  }

  function redo() {
    setRedoStack((stack) => {
      if (!stack.length) return stack;
      const [nextState, ...rest] = stack;
      setUndoStack((undoHistory) => [...undoHistory, labels]);
      setLabels(nextState);
      setStatus("Redo");
      return rest;
    });
  }

  function onVideoSelected(file) {
    if (!file) return;
    if (videoUrl && videoUrl.startsWith("blob:")) {
      URL.revokeObjectURL(videoUrl);
    }
    setVideoUrl(URL.createObjectURL(file));
    setStatus(`Loaded video: ${file.name}`);
  }

  function onVideoUrlLoad() {
    if (!videoUrlInput.trim()) return;
    if (videoUrl && videoUrl.startsWith("blob:")) {
      URL.revokeObjectURL(videoUrl);
    }
    setVideoUrl(videoUrlInput.trim());
    setStatus("Loaded video from URL.");
  }

  async function onSensorSelected(file, side) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseSensorText(text, file.name);
      if (side === "left") setLeftRaw(parsed);
      else setRightRaw(parsed);
      setError(parsed.length ? "" : `No valid ${side} sensor samples found.`);
      setLabels([]);
      setUndoStack([]);
      setRedoStack([]);
      setStatus(`Loaded ${side} sensor: ${file.name} (${parsed.length} samples)`);
    } catch {
      setError(`Failed to parse ${side} sensor file.`);
      if (side === "left") setLeftRaw([]);
      else setRightRaw([]);
    }
  }

  async function onSensorUrlLoad(side) {
    const url = side === "left" ? leftUrlInput.trim() : rightUrlInput.trim();
    if (!url) return;
    side === "left" ? setLoadingLeft(true) : setLoadingRight(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const parsed = parseSensorText(text, url);
      if (side === "left") setLeftRaw(parsed);
      else setRightRaw(parsed);
      setError(parsed.length ? "" : `No valid ${side} sensor samples found from URL.`);
      setLabels([]);
      setUndoStack([]);
      setRedoStack([]);
      setStatus(`Loaded ${side} sensor from URL (${parsed.length} samples).`);
    } catch (err) {
      console.error(err);
      setError(`Failed to load ${side} sensor URL.`);
      if (side === "left") setLeftRaw([]);
      else setRightRaw([]);
    } finally {
      side === "left" ? setLoadingLeft(false) : setLoadingRight(false);
    }
  }

  function exportLabels() {
    const deduped = dedupeLabels(labels);
    const payload = {
      createdAt: new Date().toISOString(),
      snapRadiusSec: snapRadius,
      channel,
      labels: deduped
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = "step_labels.json";
    a.click();
    URL.revokeObjectURL(href);
  }

  function seekBy(delta) {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.max(0, Math.min((video.duration || Infinity) - 0.01, video.currentTime + delta));
    video.currentTime = next;
    setCurrentTime(next);
  }

  const readyLeft = leftPoints.length > 0;
  const readyRight = rightPoints.length > 0;
  const readyVideo = Boolean(videoUrl);

  return (
    <div className="app">
      <section className="panel">
        <div className="header">
          <h1 className="title">Step Labeling Tool</h1>
          <div className="meta">
            <span>{`t=${currentTime.toFixed(3)}s`}</span>
            <span>{`labels=${labels.length}`}</span>
            <span>{`left=${leftPoints.length}`}</span>
            <span>{`right=${rightPoints.length}`}</span>
          </div>
        </div>
        <div className="status-line">
          <span>{status}</span>
          {error ? <span style={{ color: "#b91c1c" }}>{error}</span> : null}
        </div>
      </section>

      <section className="panel">
        <Section
          title="Sources"
          hint="Video + left/right sensors"
          open={sourcesOpen}
          onToggle={() => setSourcesOpen((v) => !v)}
        >
          <div className="badges-row">
            <Badge ok={readyVideo} label="Video" />
            <Badge ok={readyLeft} label="Left CSV" />
            <Badge ok={readyRight} label="Right CSV" />
          </div>

          <div className="source-block">
            <div className="block-title">Video</div>
            <div className="tabs">
              <button className={`tab ${videoMode === "file" ? "active" : ""}`} onClick={() => setVideoMode("file")}>
                Upload
              </button>
              <button className={`tab ${videoMode === "url" ? "active" : ""}`} onClick={() => setVideoMode("url")}>
                URL
              </button>
            </div>
            {videoMode === "file" ? (
              <label className="file-label">
                <span>Choose file</span>
                <input type="file" accept="video/*" onChange={(e) => onVideoSelected(e.target.files?.[0])} />
              </label>
            ) : (
              <div className="url-row">
                <input
                  type="text"
                  placeholder="https://...mp4"
                  value={videoUrlInput}
                  onChange={(e) => setVideoUrlInput(e.target.value)}
                />
                <button onClick={onVideoUrlLoad} disabled={!videoUrlInput.trim()}>Load</button>
              </div>
            )}
          </div>

          <div className="grid2 source-grid">
            <div className="source-block">
              <div className="block-title">Left sensor</div>
              <div className="tabs">
                <button className={`tab ${leftMode === "file" ? "active" : ""}`} onClick={() => setLeftMode("file")}>
                  Upload
                </button>
                <button className={`tab ${leftMode === "url" ? "active" : ""}`} onClick={() => setLeftMode("url")}>
                  URL
                </button>
              </div>
              {leftMode === "file" ? (
                <label className="file-label">
                  <span>Left CSV</span>
                  <input
                    type="file"
                    accept=".csv,.json,text/csv,application/json"
                    onChange={(e) => onSensorSelected(e.target.files?.[0], "left")}
                  />
                </label>
              ) : (
                <div className="url-row">
                  <input
                    type="text"
                    placeholder="https://...left.csv"
                    value={leftUrlInput}
                    onChange={(e) => setLeftUrlInput(e.target.value)}
                  />
                  <button onClick={() => onSensorUrlLoad("left")} disabled={!leftUrlInput.trim() || loadingLeft}>
                    {loadingLeft ? "Loading..." : "Load"}
                  </button>
                </div>
              )}
            </div>

            <div className="source-block">
              <div className="block-title">Right sensor</div>
              <div className="tabs">
                <button className={`tab ${rightMode === "file" ? "active" : ""}`} onClick={() => setRightMode("file")}>
                  Upload
                </button>
                <button className={`tab ${rightMode === "url" ? "active" : ""}`} onClick={() => setRightMode("url")}>
                  URL
                </button>
              </div>
              {rightMode === "file" ? (
                <label className="file-label">
                  <span>Right CSV</span>
                  <input
                    type="file"
                    accept=".csv,.json,text/csv,application/json"
                    onChange={(e) => onSensorSelected(e.target.files?.[0], "right")}
                  />
                </label>
              ) : (
                <div className="url-row">
                  <input
                    type="text"
                    placeholder="https://...right.csv"
                    value={rightUrlInput}
                    onChange={(e) => setRightUrlInput(e.target.value)}
                  />
                  <button onClick={() => onSensorUrlLoad("right")} disabled={!rightUrlInput.trim() || loadingRight}>
                    {loadingRight ? "Loading..." : "Load"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </Section>

        <Section
          title="Labeling"
          hint="Keyboard first"
          open={labelingOpen}
          onToggle={() => setLabelingOpen((v) => !v)}
        >
          <div className="controls compact">
            <button className="primary" onClick={togglePlay}>{isPlaying ? "Pause (Space)" : "Play (Space)"}</button>
            <button onClick={() => addLabel("left", "left")} disabled={!readyLeft}>Left (1)</button>
            <button onClick={() => addLabel("right", "right")} disabled={!readyRight}>Right (2)</button>
            <button onClick={undo} disabled={!undoStack.length}>Undo (Z)</button>
            <button onClick={redo} disabled={!redoStack.length}>Redo (Y / Shift+Z)</button>
            <button onClick={() => seekBy(-0.1)}>-0.1s</button>
            <button onClick={() => seekBy(0.1)}>+0.1s</button>
            <button onClick={exportLabels} disabled={!labels.length}>Export JSON</button>
          </div>
          <div className="meta small" style={{ marginTop: 6 }}>
            <span>Space play/pause • 1 left • 2 right • Z undo • Y/Shift+Z redo</span>
          </div>
        </Section>

        <Section
          title="Advanced"
          hint="Channel, zoom, snapping"
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
        >
          <div className="controls compact wrap">
            <label>
              Channel {" "}
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CHANNEL_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </label>

            <label>
              Window ±s {" "}
              <input
                type="range"
                min={0.5}
                max={5}
                step={0.5}
                value={windowSec}
                onChange={(e) => setWindowSec(Number(e.target.value))}
              />
              <span className="pill">{windowSec.toFixed(1)}s</span>
            </label>

            <label>
              Snap radius {" "}
              <input
                type="range"
                min={0.1}
                max={0.5}
                step={0.05}
                value={snapRadius}
                onChange={(e) => setSnapRadius(Number(e.target.value))}
              />
              <span className="pill">{snapRadius.toFixed(2)}s</span>
            </label>

            <label>
              Speed {" "}
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                <option value={0.5}>0.5x</option>
                <option value={0.75}>0.75x</option>
                <option value={1}>1x</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.5x</option>
              </select>
            </label>

            <label className="inline">
              <input type="checkbox" checked={showPeaks} onChange={(e) => setShowPeaks(e.target.checked)} /> show peaks
            </label>
          </div>
        </Section>
      </section>

      <section className="panel">
        <div className="track-label">Video</div>
        <video ref={videoRef} src={videoUrl} controls style={{ width: "100%" }} />
      </section>

      <section className="panel">
        <div className="grid2" style={{ marginTop: 4 }}>
          <div>
            <div className="track-label" style={{ color: "#dc2626" }}>Left sensor</div>
            <WaveformCanvas
              points={leftPoints}
              labels={leftLabels}
              peaks={leftPeaks}
              currentTime={currentTime}
              windowSec={windowSec}
              showPeaks={showPeaks}
            />
          </div>
          <div>
            <div className="track-label" style={{ color: "#16a34a" }}>Right sensor</div>
            <WaveformCanvas
              points={rightPoints}
              labels={rightLabels}
              peaks={rightPeaks}
              currentTime={currentTime}
              windowSec={windowSec}
              showPeaks={showPeaks}
            />
          </div>
        </div>

        <div className="legend" style={{ marginTop: 10 }}>
          <span><span className="dot left" />Left step line</span>
          <span><span className="dot right" />Right step line</span>
          <span><span className="dot" style={{ background: "#f59e0b" }} />Peaks</span>
        </div>

        <div className="meta" style={{ marginTop: 6 }}>
          {!readyVideo ? <span style={{ color: "#b45309" }}>Video not loaded.</span> : null}
          {!readyLeft ? <span style={{ color: "#b45309" }}>Left CSV not loaded.</span> : null}
          {!readyRight ? <span style={{ color: "#b45309" }}>Right CSV not loaded.</span> : null}
        </div>
      </section>
    </div>
  );
}

export default App;
