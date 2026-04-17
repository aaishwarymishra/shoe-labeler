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

const LOCAL_DRAFT_KEY = "step_labeling_tool_draft_v1";
const AUTO_SAVE_MS = 15000;
const MAX_AUTOSAVE_BYTES = 4 * 1024 * 1024;

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

function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.style.display = "none";

  document.body.appendChild(a);
  a.click();
  a.remove();

  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
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
  const [labelsListOpen, setLabelsListOpen] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [draftPromptOpen, setDraftPromptOpen] = useState(false);
  const [pendingDraft, setPendingDraft] = useState(null);

  const videoRef = useRef(null);
  const sessionInputRef = useRef(null);
  const labelsInputRef = useRef(null);
  const lastAutosaveContentRef = useRef("");
  const autosaveWarningRef = useRef("");

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
      } else if (e.key.toLowerCase() === "d" && e.shiftKey) {
        e.preventDefault();
        removeNearestLabel();
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

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOCAL_DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed?.state?.labels || !Array.isArray(parsed.state.labels)) return;
      setPendingDraft(parsed);
      lastAutosaveContentRef.current = raw;
      setDraftPromptOpen(true);
    } catch {
      localStorage.removeItem(LOCAL_DRAFT_KEY);
    }
  }, []);

  useEffect(() => {
    if (!autoSaveEnabled) return;
    const timer = window.setInterval(() => {
      try {
        const payload = buildSessionPayload();
        const serialized = JSON.stringify(payload);
        if (serialized === lastAutosaveContentRef.current) return;

        const bytes = new Blob([serialized]).size;
        if (bytes > MAX_AUTOSAVE_BYTES) {
          const warn = "Autosave paused: draft too large. Use Save Progress file.";
          if (autosaveWarningRef.current !== warn) {
            autosaveWarningRef.current = warn;
            setStatus(warn);
          }
          return;
        }

        localStorage.setItem(LOCAL_DRAFT_KEY, serialized);
        lastAutosaveContentRef.current = serialized;
        if (autosaveWarningRef.current) {
          autosaveWarningRef.current = "";
        }
      } catch {
        const warn = "Autosave failed (storage quota/browser limit). Use Save Progress file.";
        if (autosaveWarningRef.current !== warn) {
          autosaveWarningRef.current = warn;
          setStatus(warn);
        }
      }
    }, AUTO_SAVE_MS);

    return () => window.clearInterval(timer);
  }, [
    autoSaveEnabled,
    labels,
    undoStack,
    redoStack,
    currentTime,
    channel,
    windowSec,
    snapRadius,
    speed,
    showPeaks,
    videoMode,
    leftMode,
    rightMode,
    videoUrlInput,
    leftUrlInput,
    rightUrlInput,
    sourcesOpen,
    labelingOpen,
    advancedOpen,
    labelsListOpen
  ]);

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

  async function onSensorUrlLoad(side, options = { clearProgress: true, url: "" }) {
    const fallbackUrl = side === "left" ? leftUrlInput.trim() : rightUrlInput.trim();
    const url = options.url ? String(options.url).trim() : fallbackUrl;
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
      if (options.clearProgress) {
        setLabels([]);
        setUndoStack([]);
        setRedoStack([]);
      }
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

  function buildSessionPayload(savedAt = new Date().toISOString()) {
    return {
      version: 1,
      savedAt,
      state: {
        labels: dedupeLabels(labels),
        undoStack,
        redoStack,
        currentTime,
        channel,
        windowSec,
        snapRadius,
        speed,
        showPeaks,
        autoSaveEnabled,
        ui: {
          videoMode,
          leftMode,
          rightMode,
          videoUrlInput,
          leftUrlInput,
          rightUrlInput,
          sourcesOpen,
          labelingOpen,
          advancedOpen,
          labelsListOpen
        }
      }
    };
  }

  async function restoreSessionPayload(parsed, options = { source: "file" }) {
    const state = parsed?.state;
    if (!state || !Array.isArray(state.labels)) {
      throw new Error("Invalid session file");
    }

    const restoredLabels = dedupeLabels(state.labels.filter((l) => {
      return l && typeof l === "object" && Number.isFinite(Number(l.time)) && (l.sensor === "left" || l.sensor === "right");
    }));

    setLabels(restoredLabels);
    setUndoStack(Array.isArray(state.undoStack) ? state.undoStack : []);
    setRedoStack(Array.isArray(state.redoStack) ? state.redoStack : []);

    if (typeof state.channel === "string") setChannel(state.channel);
    if (Number.isFinite(Number(state.windowSec))) setWindowSec(Number(state.windowSec));
    if (Number.isFinite(Number(state.snapRadius))) setSnapRadius(Number(state.snapRadius));
    if (Number.isFinite(Number(state.speed))) setSpeed(Number(state.speed));
    if (typeof state.showPeaks === "boolean") setShowPeaks(state.showPeaks);
    if (typeof state.autoSaveEnabled === "boolean") setAutoSaveEnabled(state.autoSaveEnabled);

    const ui = state.ui || {};
    if (ui.videoMode === "file" || ui.videoMode === "url") setVideoMode(ui.videoMode);
    if (ui.leftMode === "file" || ui.leftMode === "url") setLeftMode(ui.leftMode);
    if (ui.rightMode === "file" || ui.rightMode === "url") setRightMode(ui.rightMode);
    if (typeof ui.videoUrlInput === "string") setVideoUrlInput(ui.videoUrlInput);
    if (typeof ui.leftUrlInput === "string") setLeftUrlInput(ui.leftUrlInput);
    if (typeof ui.rightUrlInput === "string") setRightUrlInput(ui.rightUrlInput);
    if (typeof ui.sourcesOpen === "boolean") setSourcesOpen(ui.sourcesOpen);
    if (typeof ui.labelingOpen === "boolean") setLabelingOpen(ui.labelingOpen);
    if (typeof ui.advancedOpen === "boolean") setAdvancedOpen(ui.advancedOpen);
    if (typeof ui.labelsListOpen === "boolean") setLabelsListOpen(ui.labelsListOpen);

    const restoredTime = Number(state.currentTime);
    if (Number.isFinite(restoredTime) && restoredTime >= 0) {
      setCurrentTime(restoredTime);
      const video = videoRef.current;
      if (video) {
        const seek = () => {
          video.currentTime = restoredTime;
        };
        if (video.readyState >= 1) seek();
        else video.addEventListener("loadedmetadata", seek, { once: true });
      }
    }

      setLastSavedAt(typeof parsed.savedAt === "string" ? parsed.savedAt : "");
      setStatus(`Progress restored (${restoredLabels.length} labels).`);
      setError("");
      autosaveWarningRef.current = "";

    if (typeof ui.videoUrlInput === "string" && ui.videoUrlInput.trim()) {
      if (videoUrl && videoUrl.startsWith("blob:")) {
        URL.revokeObjectURL(videoUrl);
      }
      setVideoUrl(ui.videoUrlInput.trim());
    }

    if (typeof ui.leftUrlInput === "string" && ui.leftUrlInput.trim()) {
      await onSensorUrlLoad("left", { clearProgress: false, url: ui.leftUrlInput });
    }
    if (typeof ui.rightUrlInput === "string" && ui.rightUrlInput.trim()) {
      await onSensorUrlLoad("right", { clearProgress: false, url: ui.rightUrlInput });
    }

    if (options.source === "draft") {
      setStatus(`Draft restored (${restoredLabels.length} labels).`);
    }
  }

  function clearLocalDraft() {
    localStorage.removeItem(LOCAL_DRAFT_KEY);
    lastAutosaveContentRef.current = "";
    autosaveWarningRef.current = "";
    setPendingDraft(null);
    setDraftPromptOpen(false);
    setStatus("Local draft cleared.");
  }

  async function restoreLocalDraft() {
    if (!pendingDraft) return;
    try {
      await restoreSessionPayload(pendingDraft, { source: "draft" });
      setDraftPromptOpen(false);
    } catch (err) {
      console.error(err);
      setError("Failed to restore local draft.");
      setStatus("Draft restore failed.");
    }
  }

  function saveProgress() {
    try {
      const payload = buildSessionPayload();
      const serialized = JSON.stringify(payload);

      downloadJsonFile("step_session.json", payload);

      localStorage.setItem(LOCAL_DRAFT_KEY, serialized);
      lastAutosaveContentRef.current = serialized;
      autosaveWarningRef.current = "";

      setLastSavedAt(payload.savedAt);
      setStatus(`Progress saved at ${new Date(payload.savedAt).toLocaleString()}.`);
      setError("");
    } catch (err) {
      console.error(err);
      setError("Failed to save progress file.");
      setStatus("Save progress failed.");
    }
  }

  function openLabelsPicker() {
    labelsInputRef.current?.click();
  }

  async function onLabelsSelected(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      const rawLabels = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.labels)
          ? parsed.labels
          : Array.isArray(parsed?.state?.labels)
            ? parsed.state.labels
            : null;

      if (!rawLabels) {
        throw new Error("Invalid labels file");
      }

      const restoredLabels = dedupeLabels(rawLabels.filter((l) => {
        return l && typeof l === "object" && Number.isFinite(Number(l.time)) && (l.sensor === "left" || l.sensor === "right");
      }));

      setLabels(restoredLabels);
      setUndoStack([]);
      setRedoStack([]);

      if (typeof parsed?.channel === "string") setChannel(parsed.channel);
      if (Number.isFinite(Number(parsed?.snapRadiusSec))) setSnapRadius(Number(parsed.snapRadiusSec));
      if (Number.isFinite(Number(parsed?.snapRadius))) setSnapRadius(Number(parsed.snapRadius));

      setStatus(`Imported ${restoredLabels.length} labels from ${file.name}.`);
      setError("");
    } catch (err) {
      console.error(err);
      setError("Failed to import labels file.");
      setStatus("Labels import failed.");
    }
  }

  function openProgressPicker() {
    sessionInputRef.current?.click();
  }

  async function onProgressSelected(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await restoreSessionPayload(parsed, { source: "file" });
    } catch (err) {
      console.error(err);
      setError("Failed to load progress file.");
      setStatus("Progress restore failed.");
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

    try {
      downloadJsonFile("step_labels.json", payload);
      setError("");
    } catch (err) {
      console.error(err);
      setError("Failed to export labels file.");
      setStatus("Export failed.");
    }
  }

  function seekBy(delta) {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.max(0, Math.min((video.duration || Infinity) - 0.01, video.currentTime + delta));
    video.currentTime = next;
    setCurrentTime(next);
  }

  function removeLabelByKey(key) {
    if (!key) return;
    setUndoStack((stack) => [...stack, labels]);
    setRedoStack([]);
    setLabels((prev) => {
      const index = prev.findIndex((l) => labelKey(l) === key);
      if (index < 0) return prev;
      const removed = prev[index];
      const next = [...prev.slice(0, index), ...prev.slice(index + 1)];
      setStatus(`Removed ${removed.sensor} @ ${removed.time.toFixed(3)}s.`);
      return next;
    });
  }

  function removeNearestLabel() {
    if (!labels.length) return;
    let best = null;
    for (const label of labels) {
      const dt = Math.abs(label.time - currentTime);
      if (!best || dt < best.dt) best = { label, dt };
    }
    if (!best) return;
    removeLabelByKey(labelKey(best.label));
  }

  function resetLabels() {
    if (!labels.length) return;
    const ok = window.confirm("Reset all labels? This will clear current annotations.");
    if (!ok) return;
    setUndoStack((stack) => [...stack, labels]);
    setRedoStack([]);
    setLabels([]);
    setStatus("All labels cleared.");
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
        {draftPromptOpen ? (
          <div className="draft-banner">
            <span>Recovered an auto-saved draft from {new Date(pendingDraft?.savedAt || Date.now()).toLocaleString()}.</span>
            <div className="controls compact">
              <button onClick={restoreLocalDraft}>Restore Draft</button>
              <button onClick={clearLocalDraft}>Discard Draft</button>
            </div>
          </div>
        ) : null}
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
            <button onClick={removeNearestLabel} disabled={!labels.length}>Delete Nearest (Shift+D)</button>
            <button onClick={() => seekBy(-0.1)}>-0.1s</button>
            <button onClick={() => seekBy(0.1)}>+0.1s</button>
          </div>
          <div className="controls compact" style={{ marginTop: 8 }}>
            <button onClick={saveProgress}>Save Progress</button>
            <button onClick={openProgressPicker}>Load Progress</button>
            <button onClick={exportLabels} disabled={!labels.length}>Export JSON</button>
            <button onClick={openLabelsPicker}>Import Labels JSON</button>
            <button className="danger" onClick={resetLabels} disabled={!labels.length}>Reset Labels</button>
            <button onClick={clearLocalDraft}>Clear Local Draft</button>
            <input
              ref={sessionInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => onProgressSelected(e.target.files?.[0])}
            />
            <input
              ref={labelsInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => onLabelsSelected(e.target.files?.[0])}
            />
          </div>

          <div className="labels-panel">
            <button className="labels-head" type="button" onClick={() => setLabelsListOpen((v) => !v)}>
              <span>{`Labels (${labels.length})`}</span>
              <span className="muted">{labelsListOpen ? "Hide" : "Show"}</span>
            </button>
            {labelsListOpen ? (
              <div className="labels-list">
                {labels.length ? labels.map((label) => {
                  const k = labelKey(label);
                  return (
                    <div className="label-row" key={k}>
                      <span className={`badge ${label.sensor === "left" ? "warn" : "ok"}`}>{label.sensor}</span>
                      <span className="pill">{label.type}</span>
                      <span className="label-time">{label.time.toFixed(3)}s</span>
                      <button className="small-btn" onClick={() => removeLabelByKey(k)}>Delete</button>
                    </div>
                  );
                }) : <div className="muted">No labels yet.</div>}
              </div>
            ) : null}
          </div>

          <div className="meta small" style={{ marginTop: 6 }}>
            <span>Space play/pause • 1 left • 2 right • Z undo • Y/Shift+Z redo • Shift+D delete nearest</span>
            {lastSavedAt ? <span>{`Last save: ${new Date(lastSavedAt).toLocaleString()}`}</span> : null}
            <label className="inline">
              <input
                type="checkbox"
                checked={autoSaveEnabled}
                onChange={(e) => setAutoSaveEnabled(e.target.checked)}
              />
              auto-save every 15s
            </label>
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
                <option value={0.25}>0.25x</option>
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
