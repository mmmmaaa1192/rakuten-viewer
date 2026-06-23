import { targetItemCode } from "./monitors.js";

export const RAKUTEN_API_NAME = "Rakuten Ichiba Item Search API 2026-04-01";
export const RAKUTEN_API_ENDPOINT =
  "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401";

const OUTPUT_ELEMENTS = [
  "itemName",
  "itemCode",
  "itemPrice",
  "itemUrl",
  "shopName",
  "shopCode",
  "mediumImageUrls",
  "reviewAverage",
  "reviewCount"
].join(",");

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeItems(payload) {
  const items = payload.items ?? payload.Items ?? [];
  return items
    .map((entry) => entry?.item ?? entry?.Item ?? entry)
    .filter((entry) => entry && typeof entry === "object");
}

function imageUrl(item) {
  const first = Array.isArray(item.mediumImageUrls) ? item.mediumImageUrls[0] : null;
  return typeof first === "string" ? first : first?.imageUrl ?? "";
}

function publicItem(item) {
  return {
    itemCode: item.itemCode ?? "",
    itemName: item.itemName ?? "",
    itemPrice: item.itemPrice ?? null,
    itemUrl: item.itemUrl ?? "",
    imageUrl: imageUrl(item),
    shopCode: item.shopCode ?? "",
    shopName: item.shopName ?? "",
    reviewAverage: item.reviewAverage ?? null,
    reviewCount: item.reviewCount ?? null
  };
}

export function buildSearchUrl(monitor, credentials, page) {
  const url = new URL(RAKUTEN_API_ENDPOINT);
  url.searchParams.set("applicationId", credentials.applicationId);
  url.searchParams.set("keyword", monitor.keyword);
  url.searchParams.set("hits", "30");
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", monitor.sort || "standard");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("elements", OUTPUT_ELEMENTS);
  if (credentials.affiliateId) {
    url.searchParams.set("affiliateId", credentials.affiliateId);
  }
  return url;
}

async function fetchJson(url, credentials, { fetchImpl, retries, timeoutMs }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          accessKey: credentials.accessKey,
          accept: "application/json"
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;

      const description = payload.error_description || payload.error || response.statusText;
      const error = new Error(`Rakuten API ${response.status}: ${description}`);
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;

      const retryAfter = Number.parseInt(response.headers.get("retry-after"), 10);
      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(8000, 800 * 2 ** attempt);
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (error.status && error.status !== 429 && error.status < 500) throw error;
      if (attempt < retries) await sleep(Math.min(8000, 800 * 2 ** attempt));
    }
  }
  throw lastError ?? new Error("Rakuten API request failed");
}

export async function searchMonitor(monitor, credentials, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 15000;
  const requestDelayMs = options.requestDelayMs ?? 800;
  const wantedItemCode = targetItemCode(monitor);
  let matchedResult = null;
  const rankedItems = [];
  let searchedPages = 0;

  for (let page = 1; page <= monitor.maxPages; page += 1) {
    const payload = await fetchJson(buildSearchUrl(monitor, credentials, page), credentials, {
      fetchImpl,
      retries,
      timeoutMs
    });
    const items = normalizeItems(payload);
    searchedPages = page;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const shopCode = String(item.shopCode || item.itemCode?.split(":")[0] || "").toLowerCase();
      const itemCode = String(item.itemCode || "").toLowerCase();
      const shopMatches = shopCode === monitor.shopCode.toLowerCase();
      const itemMatches = !wantedItemCode || itemCode === wantedItemCode;
      if (shopMatches) {
        const rank = (page - 1) * 30 + index + 1;
        rankedItems.push({
          rank,
          item: publicItem(item)
        });
        if (itemMatches && !matchedResult) {
          matchedResult = {
            status: "ok",
            rank,
            item: publicItem(item),
            searchedPages: page
          };
        }
      }
    }

    const pageCount = Number(payload.pageCount ?? payload.PageCount ?? page);
    if (items.length < 30 || page >= pageCount) break;
    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }

  if (matchedResult) {
    return {
      ...matchedResult,
      searchedPages,
      shopRankedCount: rankedItems.length,
      rankedItems
    };
  }

  return {
    status: "not_found",
    rank: null,
    item: null,
    searchedPages,
    shopRankedCount: rankedItems.length,
    rankedItems
  };
}
