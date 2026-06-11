import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

async function waitForServer(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("server did not start");
}

test("API server persists monitor changes and serves dashboard state", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "rakuten-collector-"));
  const monitorsFile = path.join(temporaryDirectory, "monitors.json");
  const stateFile = path.join(temporaryDirectory, "state.json");
  await writeFile(monitorsFile, "[]\n", "utf8");
  await writeFile(stateFile, JSON.stringify({
    schemaVersion: 1,
    generatedAt: null,
    source: { api: "test", mode: "not-configured" },
    summary: {},
    monitors: [],
    logs: []
  }), "utf8");

  const port = 19000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      MONITORS_FILE: monitorsFile,
      STATE_FILE: stateFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => child.kill());

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/api/health`, child);

  const scriptResponse = await fetch(`${baseUrl}/app.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /^text\/javascript/);

  const createResponse = await fetch(`${baseUrl}/api/monitors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      keyword: "ワイヤレスイヤホン",
      shopCode: "sample-shop",
      itemCode: "item-001",
      enabled: true
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const patchResponse = await fetch(`${baseUrl}/api/monitors/${created.monitor.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(patchResponse.status, 200);

  const collectResponse = await fetch(`${baseUrl}/api/collect`, { method: "POST" });
  assert.equal(collectResponse.status, 200);
  const collected = await collectResponse.json();
  assert.equal(collected.summary.monitorCount, 1);
  assert.equal(collected.monitors[0].status, "disabled");

  const stateResponse = await fetch(`${baseUrl}/api/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.monitors[0].keyword, "ワイヤレスイヤホン");
  assert.equal(state.monitors[0].enabled, false);

  const persisted = JSON.parse(await readFile(monitorsFile, "utf8"));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].enabled, false);
});
