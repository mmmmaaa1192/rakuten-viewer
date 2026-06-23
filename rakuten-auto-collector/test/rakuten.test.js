import assert from "node:assert/strict";
import test from "node:test";
import { collectState } from "../src/collector.js";
import { buildSearchUrl, searchMonitor } from "../src/rakuten.js";

const credentials = {
  applicationId: "app-id",
  accessKey: "access-key",
  affiliateId: ""
};

const monitor = {
  id: "monitor-1",
  keyword: "wireless earphones",
  shopCode: "target-shop",
  itemCode: "item-2",
  enabled: true,
  maxPages: 3,
  sort: "standard"
};

test("buildSearchUrl uses the latest API without exposing the access key", () => {
  const url = buildSearchUrl(monitor, credentials, 2);
  assert.equal(url.pathname, "/ichibams/api/IchibaItem/Search/20260401");
  assert.equal(url.searchParams.get("applicationId"), "app-id");
  assert.equal(url.searchParams.get("keyword"), "wireless earphones");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.has("accessKey"), false);
});

test("searchMonitor calculates an absolute rank, matches the target item, and counts shop entries", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.accessKey, "access-key");
    const page = Number(new URL(url).searchParams.get("page"));
    const items = Array.from({ length: 30 }, (_, index) => ({
      itemCode: `other-shop:item-${page}-${index}`,
      shopCode: "other-shop"
    }));
    if (page === 2) {
      items[1] = {
        itemCode: "target-shop:item-1",
        itemName: "target shop sibling item",
        shopCode: "target-shop",
        shopName: "target shop",
        itemPrice: 900
      };
      items[4] = {
        itemCode: "target-shop:item-2",
        itemName: "target item",
        shopCode: "target-shop",
        shopName: "target shop",
        itemPrice: 1000
      };
    }
    return new Response(JSON.stringify({ items, pageCount: 3 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const result = await searchMonitor(monitor, credentials, {
    fetchImpl,
    requestDelayMs: 0
  });
  assert.equal(result.status, "ok");
  assert.equal(result.rank, 35);
  assert.equal(result.item.itemName, "target item");
  assert.equal(result.shopRankedCount, 2);
  assert.deepEqual(result.rankedItems.map((entry) => entry.rank), [32, 35]);
});

test("collectState appends history and calculates rank movement", async () => {
  const previousState = {
    monitors: [{
      ...monitor,
      currentRank: 20,
      history: [{ collectedAt: "2026-06-10T00:00:00.000Z", status: "ok", rank: 20 }]
    }],
    logs: []
  };
  const state = await collectState({
    monitors: [monitor],
    previousState,
    credentials,
    now: new Date("2026-06-11T00:00:00.000Z"),
    search: async () => ({
      status: "ok",
      rank: 12,
      shopRankedCount: 3,
      rankedItems: [
        { rank: 12, item: { itemCode: "target-shop:item-2", itemName: "target item" } }
      ],
      item: { itemCode: "target-shop:item-2", itemName: "target item" }
    })
  });

  assert.equal(state.monitors[0].currentRank, 12);
  assert.equal(state.monitors[0].previousRank, 20);
  assert.equal(state.monitors[0].delta, 8);
  assert.equal(state.monitors[0].shopRankedCount, 3);
  assert.equal(state.monitors[0].rankedItems.length, 1);
  assert.equal(state.monitors[0].history[0].shopRankedCount, 3);
  assert.equal(state.monitors[0].history.length, 2);
  assert.equal(state.summary.foundCount, 1);
});
