import { loadMonitors, loadState, saveState } from "./storage.js";
import { RAKUTEN_API_NAME, searchMonitor } from "./rakuten.js";

const DEFAULT_HISTORY_LIMIT = 365;
const DEFAULT_LOG_LIMIT = 100;

export function credentialsFromEnv(env = process.env) {
  return {
    applicationId: String(env.RAKUTEN_APPLICATION_ID ?? "").trim(),
    accessKey: String(env.RAKUTEN_ACCESS_KEY ?? "").trim(),
    affiliateId: String(env.RAKUTEN_AFFILIATE_ID ?? "").trim()
  };
}

function historyEntry(time, result, error) {
  return {
    collectedAt: time,
    status: error ? "error" : result.status,
    rank: error ? null : result.rank,
    shopRankedCount: error ? null : result.shopRankedCount ?? null,
    itemCode: error ? "" : result.item?.itemCode ?? "",
    itemName: error ? "" : result.item?.itemName ?? "",
    error: error ? error.message : ""
  };
}

function prependLog(logs, time, level, message) {
  return [{ time, level, message }, ...logs];
}

export async function collectState({
  monitors,
  previousState,
  credentials,
  now = new Date(),
  search = searchMonitor,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  logLimit = DEFAULT_LOG_LIMIT
}) {
  const collectedAt = now.toISOString();
  const previousById = new Map((previousState.monitors ?? []).map((monitor) => [monitor.id, monitor]));
  const nextMonitors = [];
  let logs = Array.isArray(previousState.logs) ? previousState.logs : [];
  let collectedCount = 0;
  let foundCount = 0;
  let notFoundCount = 0;
  let errorCount = 0;

  const enabled = monitors.filter((monitor) => monitor.enabled);
  if (enabled.length && (!credentials.applicationId || !credentials.accessKey)) {
    throw new Error("RAKUTEN_APPLICATION_ID and RAKUTEN_ACCESS_KEY are required");
  }

  for (const monitor of monitors) {
    const previous = previousById.get(monitor.id);
    const previousHistory = Array.isArray(previous?.history) ? previous.history : [];

    if (!monitor.enabled) {
      nextMonitors.push({
        ...monitor,
        status: "disabled",
        currentRank: previous?.currentRank ?? null,
        previousRank: previous?.previousRank ?? null,
        delta: null,
        shopRankedCount: previous?.shopRankedCount ?? null,
        rankedItems: previous?.rankedItems ?? [],
        item: previous?.item ?? null,
        lastFetchedAt: previous?.lastFetchedAt ?? null,
        lastAttemptAt: previous?.lastAttemptAt ?? null,
        error: "",
        history: previousHistory
      });
      continue;
    }

    try {
      const result = await search(monitor, credentials);
      const previousRank = Number.isFinite(previous?.currentRank) ? previous.currentRank : null;
      const currentRank = Number.isFinite(result.rank) ? result.rank : null;
      const delta = previousRank !== null && currentRank !== null
        ? previousRank - currentRank
        : null;
      const history = [
        historyEntry(collectedAt, result),
        ...previousHistory
      ].slice(0, historyLimit);

      nextMonitors.push({
        ...monitor,
        status: result.status,
        currentRank,
        previousRank,
        delta,
        shopRankedCount: result.shopRankedCount ?? null,
        rankedItems: result.rankedItems ?? [],
        item: result.item,
        lastFetchedAt: collectedAt,
        lastAttemptAt: collectedAt,
        error: "",
        history
      });
      collectedCount += 1;
      if (result.status === "ok") {
        foundCount += 1;
        logs = prependLog(logs, collectedAt, "success", `「${monitor.keyword}」: ${currentRank}位`);
      } else {
        notFoundCount += 1;
        logs = prependLog(logs, collectedAt, "warning", `「${monitor.keyword}」: 上位${monitor.maxPages * 30}件に見つかりません`);
      }
    } catch (error) {
      const history = [
        historyEntry(collectedAt, {}, error),
        ...previousHistory
      ].slice(0, historyLimit);
      nextMonitors.push({
        ...monitor,
        status: "error",
        currentRank: previous?.currentRank ?? null,
        previousRank: previous?.previousRank ?? null,
        delta: null,
        shopRankedCount: previous?.shopRankedCount ?? null,
        rankedItems: previous?.rankedItems ?? [],
        item: previous?.item ?? null,
        lastFetchedAt: previous?.lastFetchedAt ?? null,
        lastAttemptAt: collectedAt,
        error: error.message,
        history
      });
      errorCount += 1;
      logs = prependLog(logs, collectedAt, "error", `「${monitor.keyword}」: ${error.message}`);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: collectedAt,
    source: {
      api: RAKUTEN_API_NAME,
      mode: enabled.length ? "connected" : "no-enabled-monitors"
    },
    summary: {
      monitorCount: monitors.length,
      enabledCount: enabled.length,
      collectedCount,
      foundCount,
      notFoundCount,
      errorCount
    },
    monitors: nextMonitors,
    logs: logs.slice(0, logLimit)
  };
}

export async function runCollection(options = {}) {
  const monitors = options.monitors ?? await loadMonitors();
  const previousState = options.previousState ?? await loadState();
  const state = await collectState({
    monitors,
    previousState,
    credentials: options.credentials ?? credentialsFromEnv(),
    now: options.now,
    search: options.search,
    historyLimit: options.historyLimit,
    logLimit: options.logLimit
  });
  if (options.persist !== false) await saveState(state);
  return state;
}
