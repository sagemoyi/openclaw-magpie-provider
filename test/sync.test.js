import test from "node:test";
import assert from "node:assert/strict";
import { materializeCatalog } from "../src/sync.js";

const snapshot = (ids, extra = {}) => ({
  models: ids.map((id) => ({ id })),
  revision: "revision",
  stale: false,
  ...extra,
});
const config = { models: { providers: { magpie: { models: [] } } } };

test("prepared publication succeeds when the host publishes the complete snapshot", async () => {
  let received;
  const result = await materializeCatalog(config, snapshot(["a", "b"]), {
    async loadPreparedModelCatalog(params) {
      received = params;
      return [{ provider: "magpie", id: "a" }, { provider: "magpie", id: "b" }];
    },
  });
  assert.deepEqual(result, { synced: true, models: 2, revision: "revision", mode: "prepared" });
  assert.equal(received.readOnly, false);
  assert.equal(received.refreshFullCatalog, true);
});

test("incomplete publication and retained removed models fail so sync can retry", async () => {
  await assert.rejects(
    materializeCatalog(config, snapshot(["a", "b"]), {
      async loadPreparedModelCatalog() {
        return [{ provider: "magpie", id: "a" }];
      },
    }),
    /complete Magpie catalog/,
  );
  await assert.rejects(
    materializeCatalog(config, snapshot(["a"]), {
      async loadPreparedModelCatalog() {
        return [{ provider: "magpie", id: "a" }, { provider: "magpie", id: "removed" }];
      },
    }),
    /retained removed/,
  );
});

test("explicit configured models are allowed to remain published", async () => {
  const explicit = { models: { providers: { magpie: { models: [{ id: "manual" }] } } } };
  const result = await materializeCatalog(explicit, snapshot(["a"]), {
    async loadPreparedModelCatalog() {
      return [{ provider: "magpie", id: "a" }, { provider: "magpie", id: "manual" }];
    },
  });
  assert.equal(result.synced, true);
});

test("stale snapshots are never published as fresh catalogs", async () => {
  let called = false;
  const result = await materializeCatalog(config, snapshot(["a"], { stale: true }), {
    async loadPreparedModelCatalog() {
      called = true;
      return [];
    },
  });
  assert.deepEqual(result, { synced: false, reason: "stale" });
  assert.equal(called, false);
});

test("a host without the prepared catalog owner is rejected explicitly", async () => {
  await assert.rejects(
    materializeCatalog(config, snapshot(["a"]), {}),
    /targets OpenClaw 2026\.10\.3/,
  );
});
