const SORT_VALUES = new Set([
  "standard",
  "+itemPrice",
  "-itemPrice",
  "+reviewCount",
  "-reviewCount",
  "+reviewAverage",
  "-reviewAverage",
  "+updateTimestamp",
  "-updateTimestamp"
]);

function requiredText(value, name, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  if (text.length > maxLength) {
    throw new Error(`${name} must be ${maxLength} characters or fewer`);
  }
  return text;
}

export function normalizeMonitor(input, { requireId = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("monitor must be an object");
  }

  const id = String(input.id ?? "").trim();
  if (requireId && !id) {
    throw new Error("id is required");
  }

  const keyword = requiredText(input.keyword, "keyword", 128);
  const shopCode = requiredText(input.shopCode ?? input.shop, "shopCode", 100).toLowerCase();
  const itemCode = String(input.itemCode ?? input.item ?? "").trim().toLowerCase();
  const maxPagesValue = Number.parseInt(input.maxPages, 10);
  const maxPages = Number.isFinite(maxPagesValue)
    ? Math.min(100, Math.max(1, maxPagesValue))
    : 4;
  const sort = SORT_VALUES.has(input.sort) ? input.sort : "standard";

  return {
    id,
    keyword,
    shopCode,
    itemCode,
    enabled: input.enabled !== false,
    maxPages,
    sort
  };
}

export function normalizeMonitorPatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("request body must be an object");
  }

  const patch = {};
  if ("keyword" in input) patch.keyword = requiredText(input.keyword, "keyword", 128);
  if ("shopCode" in input || "shop" in input) {
    patch.shopCode = requiredText(input.shopCode ?? input.shop, "shopCode", 100).toLowerCase();
  }
  if ("itemCode" in input || "item" in input) {
    patch.itemCode = String(input.itemCode ?? input.item ?? "").trim().toLowerCase();
  }
  if ("enabled" in input) patch.enabled = Boolean(input.enabled);
  if ("maxPages" in input) {
    const value = Number.parseInt(input.maxPages, 10);
    if (!Number.isFinite(value) || value < 1 || value > 100) {
      throw new Error("maxPages must be an integer from 1 to 100");
    }
    patch.maxPages = value;
  }
  if ("sort" in input) {
    if (!SORT_VALUES.has(input.sort)) {
      throw new Error("sort is invalid");
    }
    patch.sort = input.sort;
  }
  return patch;
}

export function targetItemCode(monitor) {
  if (!monitor.itemCode) return "";
  return monitor.itemCode.includes(":")
    ? monitor.itemCode.toLowerCase()
    : `${monitor.shopCode}:${monitor.itemCode}`.toLowerCase();
}
