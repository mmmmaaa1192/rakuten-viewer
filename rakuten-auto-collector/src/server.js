import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { runCollection } from "./collector.js";
import { normalizeMonitor, normalizeMonitorPatch } from "./monitors.js";
import {
  loadMonitors,
  loadState,
  rootDir,
  saveMonitors
} from "./storage.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT, 10) || 8787;
const adminToken = String(process.env.COLLECTOR_ADMIN_TOKEN || "");
const corsOrigin = String(process.env.CORS_ORIGIN || "");
let collectionPromise = null;

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(JSON.stringify(body));
}

function corsHeaders(request) {
  if (!corsOrigin) return {};
  const origin = request.headers.origin;
  return origin === corsOrigin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
}

function isAuthorized(request) {
  const remoteAddress = request.socket.remoteAddress || "";
  const isLoopback = remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
  if (!adminToken) return isLoopback;

  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expectedBuffer = Buffer.from(adminToken);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length
    && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function pendingMonitor(monitor, previous) {
  return {
    ...monitor,
    status: monitor.enabled ? "pending" : "disabled",
    currentRank: previous?.currentRank ?? null,
    previousRank: previous?.previousRank ?? null,
    delta: null,
    item: previous?.item ?? null,
    lastFetchedAt: previous?.lastFetchedAt ?? null,
    lastAttemptAt: previous?.lastAttemptAt ?? null,
    error: "",
    history: previous?.history ?? []
  };
}

async function dashboardState() {
  const [monitors, state] = await Promise.all([loadMonitors(), loadState()]);
  const stateById = new Map((state.monitors ?? []).map((monitor) => [monitor.id, monitor]));
  const merged = monitors.map((monitor) => {
    const previous = stateById.get(monitor.id);
    return previous ? { ...previous, ...monitor } : pendingMonitor(monitor);
  });
  return {
    ...state,
    summary: {
      ...(state.summary ?? {}),
      monitorCount: monitors.length,
      enabledCount: monitors.filter((monitor) => monitor.enabled).length
    },
    monitors: merged
  };
}

async function mutateMonitors(request, response, url, headers) {
  if (!isAuthorized(request)) {
    json(response, 401, { error: "A valid admin token is required" }, headers);
    return;
  }

  const monitors = await loadMonitors();
  if (request.method === "POST" && url.pathname === "/api/monitors") {
    const body = await readBody(request);
    const monitor = normalizeMonitor({ ...body, id: randomUUID() });
    await saveMonitors([monitor, ...monitors]);
    json(response, 201, { monitor }, headers);
    return;
  }

  const match = url.pathname.match(/^\/api\/monitors\/([^/]+)$/);
  if (!match) {
    json(response, 404, { error: "Not found" }, headers);
    return;
  }
  const id = decodeURIComponent(match[1]);
  const index = monitors.findIndex((monitor) => monitor.id === id);
  if (index < 0) {
    json(response, 404, { error: "Monitor not found" }, headers);
    return;
  }

  if (request.method === "PATCH") {
    const patch = normalizeMonitorPatch(await readBody(request));
    monitors[index] = normalizeMonitor({ ...monitors[index], ...patch });
    await saveMonitors(monitors);
    json(response, 200, { monitor: monitors[index] }, headers);
    return;
  }

  if (request.method === "DELETE") {
    const [removed] = monitors.splice(index, 1);
    await saveMonitors(monitors);
    json(response, 200, { monitor: removed }, headers);
    return;
  }

  json(response, 405, { error: "Method not allowed" }, headers);
}

async function serveFile(response, filePath, contentType) {
  try {
    const info = await stat(filePath);
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": info.size,
      "cache-control": contentType.startsWith("application/json") ? "no-store" : "public, max-age=300"
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT") {
      json(response, 404, { error: "Not found" });
      return;
    }
    throw error;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const headers = corsHeaders(request);

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...headers,
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS"
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, { ok: true, time: new Date().toISOString() }, headers);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, await dashboardState(), headers);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/monitors") {
      json(response, 200, { monitors: await loadMonitors() }, headers);
      return;
    }
    if (url.pathname === "/api/monitors" || url.pathname.startsWith("/api/monitors/")) {
      await mutateMonitors(request, response, url, headers);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/collect") {
      if (!isAuthorized(request)) {
        json(response, 401, { error: "A valid admin token is required" }, headers);
        return;
      }
      if (collectionPromise) {
        json(response, 409, { error: "Collection is already running" }, headers);
        return;
      }
      collectionPromise = runCollection();
      try {
        json(response, 200, await collectionPromise, headers);
      } finally {
        collectionPromise = null;
      }
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      await serveFile(response, path.join(rootDir, "index.html"), "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/app.js") {
      await serveFile(response, path.join(rootDir, "app.js"), "text/javascript; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/styles.css") {
      await serveFile(response, path.join(rootDir, "styles.css"), "text/css; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/data/state.json") {
      await serveFile(response, path.join(rootDir, "data", "state.json"), "application/json; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    json(response, 404, { error: "Not found" }, headers);
  } catch (error) {
    console.error(error);
    json(response, 500, { error: error.message || "Internal server error" }, headers);
  }
});

server.listen(port, host, () => {
  console.log(`Rakuten auto collector listening on http://${host}:${port}`);
  if (!adminToken) {
    console.log("Write APIs are restricted to loopback because COLLECTOR_ADMIN_TOKEN is not set.");
  }
});
