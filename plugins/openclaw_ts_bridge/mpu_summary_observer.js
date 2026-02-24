import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import process from "node:process";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9000;
const DEFAULT_INTERVAL_MS = 1000;
const SENSOR_KEYS = ["ax", "ay", "az", "gx", "gy", "gz"];

function parseArgs(argv) {
  const out = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxRuntimeS: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      out.host = next;
      i += 1;
      continue;
    }
    if (arg === "--port" && next) {
      out.port = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--interval-ms" && next) {
      out.intervalMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--max-runtime-s" && next) {
      out.maxRuntimeS = Number(next);
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error(`Invalid --port: ${out.port}`);
  }
  if (!Number.isFinite(out.intervalMs) || out.intervalMs < 200) {
    throw new Error(`Invalid --interval-ms: ${out.intervalMs}`);
  }
  if (!Number.isFinite(out.maxRuntimeS) || out.maxRuntimeS < 0) {
    throw new Error(`Invalid --max-runtime-s: ${out.maxRuntimeS}`);
  }

  return out;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractFromObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return {};
  }

  const out = {};
  for (const key of SENSOR_KEYS) {
    const direct = toFiniteNumber(obj[key]);
    if (direct !== null) {
      out[key] = direct;
      continue;
    }
    const upper = toFiniteNumber(obj[key.toUpperCase()]);
    if (upper !== null) {
      out[key] = upper;
    }
  }
  return out;
}

function extractFromRaw(rawLine) {
  if (typeof rawLine !== "string") return {};
  const raw = rawLine.trim();
  if (!raw) return {};

  try {
    const maybeObj = JSON.parse(raw);
    return extractFromObject(maybeObj);
  } catch {
    // not JSON, continue with text parsing
  }

  const out = {};
  const pairRe = /\b([ag][xyz])\b\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi;
  for (const match of raw.matchAll(pairRe)) {
    const key = String(match[1]).toLowerCase();
    const value = toFiniteNumber(match[2]);
    if (value !== null) out[key] = value;
  }
  if (Object.keys(out).length > 0) return out;

  const nums = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => toFiniteNumber(token))
    .filter((n) => n !== null);

  if (nums.length >= 3) {
    out.ax = nums[0];
    out.ay = nums[1];
    out.az = nums[2];
  }
  if (nums.length >= 6) {
    out.gx = nums[3];
    out.gy = nums[4];
    out.gz = nums[5];
  }
  return out;
}

function mergeSensorValues(payloadObj, rawLine) {
  const merged = {};
  const parsedObj =
    payloadObj &&
    typeof payloadObj === "object" &&
    payloadObj.parsed &&
    typeof payloadObj.parsed === "object" &&
    !Array.isArray(payloadObj.parsed)
      ? payloadObj.parsed
      : payloadObj;

  Object.assign(merged, extractFromObject(parsedObj));
  Object.assign(merged, extractFromRaw(rawLine));
  return merged;
}

function createWindowState() {
  const values = {};
  for (const key of SENSOR_KEYS) {
    values[key] = {
      n: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      latest: null,
    };
  }
  return {
    frames: 0,
    sensorSamples: 0,
    values,
  };
}

function updateWindow(windowState, sensorValues) {
  windowState.frames += 1;
  let hasSensorField = false;
  for (const key of SENSOR_KEYS) {
    const value = toFiniteNumber(sensorValues[key]);
    if (value === null) continue;
    hasSensorField = true;
    const bucket = windowState.values[key];
    bucket.n += 1;
    bucket.sum += value;
    bucket.min = Math.min(bucket.min, value);
    bucket.max = Math.max(bucket.max, value);
    bucket.latest = value;
  }
  if (hasSensorField) windowState.sensorSamples += 1;
}

function flushWindow(windowState) {
  const keys = {};
  for (const key of SENSOR_KEYS) {
    const bucket = windowState.values[key];
    if (bucket.n <= 0) continue;
    keys[key] = {
      mean: bucket.sum / bucket.n,
      min: bucket.min,
      max: bucket.max,
      latest: bucket.latest,
      n: bucket.n,
    };
  }
  return {
    type: "mpu_summary",
    ts: Date.now(),
    frames: windowState.frames,
    parsed_samples: windowState.sensorSamples,
    keys,
    note:
      windowState.frames > 0 && Object.keys(keys).length === 0
        ? "frames_seen_but_no_ax_ay_az_fields"
        : undefined,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let windowState = createWindowState();
  let lineBuffer = "";

  const socket = createConnection({ host: args.host, port: args.port });
  socket.setNoDelay(true);
  socket.setKeepAlive(true);

  const rl = createInterface({ input: socket });
  rl.on("line", (line) => {
    lineBuffer = line;
    let payloadObj = null;
    try {
      payloadObj = JSON.parse(line);
    } catch {
      // allow raw non-JSON lines
    }

    const rawLine =
      payloadObj &&
      typeof payloadObj === "object" &&
      typeof payloadObj.raw === "string"
        ? payloadObj.raw
        : line;

    const sensorValues = mergeSensorValues(payloadObj, rawLine);
    updateWindow(windowState, sensorValues);
  });

  socket.on("connect", () => {
    console.log(
      JSON.stringify({
        type: "mpu_observer_start",
        host: args.host,
        port: args.port,
        interval_ms: args.intervalMs,
        max_runtime_s: args.maxRuntimeS,
      }),
    );
  });

  socket.on("error", (err) => {
    console.error(
      JSON.stringify({
        type: "mpu_observer_error",
        message: err.message,
      }),
    );
    process.exitCode = 1;
  });

  socket.on("close", () => {
    console.log(
      JSON.stringify({
        type: "mpu_observer_closed",
        last_line_sample: lineBuffer || null,
      }),
    );
  });

  const timer = setInterval(() => {
    const summary = flushWindow(windowState);
    console.log(JSON.stringify(summary));
    windowState = createWindowState();
  }, args.intervalMs);
  timer.unref?.();

  let stopTimer = null;
  if (args.maxRuntimeS > 0) {
    stopTimer = setTimeout(() => shutdown("max_runtime_reached"), args.maxRuntimeS * 1000);
    stopTimer.unref?.();
  }

  function shutdown(reason) {
    if (stopTimer) clearTimeout(stopTimer);
    clearInterval(timer);
    rl.close();
    socket.destroy();
    console.log(JSON.stringify({ type: "mpu_observer_shutdown", reason }));
  }

  process.on("SIGINT", () => shutdown("sigint"));
  process.on("SIGTERM", () => shutdown("sigterm"));
}

main();
