export function parseSensorText(text, fileName = "") {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".json")) {
    return parseJsonSensor(text);
  }
  return parseCsvSensor(text);
}

export function parseCsvSensor(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(delimiter).map((h) => h.trim());
  const records = [];

  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(delimiter).map((p) => p.trim());
    if (parts.length === 0) continue;

    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = parts[j] ?? "";
    }

    const timestamp = parseNumber(row.timestamp ?? row.t ?? row.time);
    if (!Number.isFinite(timestamp) || timestamp < 0) continue;

    records.push({
      topic: String(row.topic ?? "default"),
      timestamp,
      value: parseNumber(row.value),
      accel_x: parseNumber(row.accel_x),
      accel_y: parseNumber(row.accel_y),
      accel_z: parseNumber(row.accel_z),
      gyro_x: parseNumber(row.gyro_x),
      gyro_y: parseNumber(row.gyro_y),
      gyro_z: parseNumber(row.gyro_z)
    });
  }

  return records.sort((a, b) => a.timestamp - b.timestamp);
}

export function parseJsonSensor(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const records = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const timestamp = parseNumber(row.timestamp ?? row.t ?? row.time);
    if (!Number.isFinite(timestamp) || timestamp < 0) continue;

    records.push({
      topic: String(row.topic ?? "default"),
      timestamp,
      value: parseNumber(row.value),
      accel_x: parseNumber(row.accel_x),
      accel_y: parseNumber(row.accel_y),
      accel_z: parseNumber(row.accel_z),
      gyro_x: parseNumber(row.gyro_x),
      gyro_y: parseNumber(row.gyro_y),
      gyro_z: parseNumber(row.gyro_z)
    });
  }

  return records.sort((a, b) => a.timestamp - b.timestamp);
}

export function getTopics(records) {
  const set = new Set(records.map((r) => r.topic || "default"));
  return Array.from(set).sort();
}

export function buildSignal(records, channel, topic) {
  const points = [];
  for (const r of records) {
    if (topic && topic !== "all" && r.topic !== topic) continue;
    const value = readChannelValue(r, channel);
    if (!Number.isFinite(value)) continue;
    points.push({ t: r.timestamp, value });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

export function computePeaks(points) {
  if (points.length < 3) return [];
  const peaks = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1].value;
    const cur = points[i].value;
    const next = points[i + 1].value;
    if (cur > prev && cur >= next) {
      peaks.push(points[i]);
    }
  }
  return peaks;
}

export function snapToNearestPeak(points, rawTime, radiusSec = 0.25) {
  return snapToNearestPeakDetail(points, rawTime, radiusSec).time;
}

export function snapToNearestPeakDetail(points, rawTime, radiusSec = 0.25) {
  if (points.length === 0) {
    return { time: rawTime, sampleIndex: -1, snapSource: "none" };
  }

  const left = lowerBound(points, rawTime - radiusSec);
  const right = upperBound(points, rawTime + radiusSec);

  let bestPeak = null;
  for (let i = Math.max(1, left); i < Math.min(points.length - 1, right); i += 1) {
    const prev = points[i - 1].value;
    const cur = points[i].value;
    const next = points[i + 1].value;
    if (!(cur > prev && cur >= next)) continue;
    const dt = Math.abs(points[i].t - rawTime);
    if (!bestPeak || dt < bestPeak.dt || (dt === bestPeak.dt && cur > bestPeak.value)) {
      bestPeak = { time: points[i].t, value: cur, dt, sampleIndex: i, snapSource: "peak" };
    }
  }

  if (bestPeak) return bestPeak;

  let nearest = null;
  for (let i = left; i < right; i += 1) {
    const dt = Math.abs(points[i].t - rawTime);
    if (!nearest || dt < nearest.dt) {
      nearest = { time: points[i].t, dt, sampleIndex: i, snapSource: "nearest_sample" };
    }
  }
  if (nearest) return nearest;

  const fallbackIndex = lowerBound(points, rawTime);
  const clampedIndex = Math.min(points.length - 1, Math.max(0, fallbackIndex));
  return {
    time: points[clampedIndex].t,
    sampleIndex: clampedIndex,
    snapSource: "fallback_sample"
  };
}

export function lowerBound(points, targetTime) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < targetTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function upperBound(points, targetTime) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= targetTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function parseNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function readChannelValue(record, channel) {
  switch (channel) {
    case "value":
      return record.value;
    case "accel_x":
    case "accel_y":
    case "accel_z":
    case "gyro_x":
    case "gyro_y":
    case "gyro_z":
      return record[channel];
    case "accel_mag":
      return magnitude(record.accel_x, record.accel_y, record.accel_z);
    case "gyro_mag":
      return magnitude(record.gyro_x, record.gyro_y, record.gyro_z);
    default:
      return NaN;
  }
}

function magnitude(x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return NaN;
  return Math.sqrt(x * x + y * y + z * z);
}
