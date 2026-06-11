import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMonitor } from "./monitors.js";

export const rootDir = fileURLToPath(new URL("../", import.meta.url));
export const monitorsPath = process.env.MONITORS_FILE
  ? path.resolve(process.env.MONITORS_FILE)
  : path.join(rootDir, "config", "monitors.json");
export const statePath = process.env.STATE_FILE
  ? path.resolve(process.env.STATE_FILE)
  : path.join(rootDir, "data", "state.json");

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export async function loadMonitors() {
  const raw = await readJson(monitorsPath, []);
  if (!Array.isArray(raw)) {
    throw new Error("config/monitors.json must contain an array");
  }
  return raw.map((monitor) => normalizeMonitor(monitor));
}

export async function saveMonitors(monitors) {
  const normalized = monitors.map((monitor) => normalizeMonitor(monitor));
  await writeJson(monitorsPath, normalized);
  return normalized;
}

export async function loadState() {
  return readJson(statePath, {
    schemaVersion: 1,
    generatedAt: null,
    source: {
      api: "Rakuten Ichiba Item Search API 2026-04-01",
      mode: "not-configured"
    },
    summary: {},
    monitors: [],
    logs: []
  });
}

export async function saveState(state) {
  await writeJson(statePath, state);
  return state;
}
