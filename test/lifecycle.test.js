import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogService, createCatalogSynchronizer } from "../src/lifecycle.js";

const pause = () => new Promise((resolve) => setImmediate(resolve));

function snapshot(revision = "r1", extra = {}) {
  return { baseUrl: "http://127.0.0.1:3425/v1", revision, stale: false, models: [{ id: "a" }], ...extra };
}

test("the synchronizer publishes changes, skips unchanged fingerprints and supports force", async () => {
  let revision = "r1";
  let calls = 0;
  const sync = createCatalogSynchronizer({
    config: {},
    discover: async () => snapshot(revision),
    publish: async () => {
      calls += 1;
      return { synced: true };
    },
  });
  assert.equal((await sync({})).synced, true);
  assert.equal((await sync({})).reason, "unchanged");
  revision = "r2";
  assert.equal((await sync({})).synced, true);
  assert.equal((await sync({}, true)).synced, true);
  assert.equal(calls, 3);
});

test("failed publication does not advance the fingerprint, so the next run retries", async () => {
  let fail = true;
  let calls = 0;
  const sync = createCatalogSynchronizer({
    config: {},
    discover: async () => snapshot(),
    publish: async () => {
      calls += 1;
      if (fail) throw new Error("publication failed");
      return { synced: true };
    },
  });
  await assert.rejects(sync({}), /publication failed/);
  fail = false;
  assert.equal((await sync({})).synced, true);
  assert.equal(calls, 2);
});

test("unconfigured and stale snapshots are not published", async () => {
  let calls = 0;
  const unconfigured = createCatalogSynchronizer({
    config: {},
    discover: async () => null,
    publish: async () => { calls += 1; return { synced: true }; },
  });
  assert.deepEqual(await unconfigured({}), { synced: false, reason: "unconfigured" });
  const stale = createCatalogSynchronizer({
    config: {},
    discover: async () => snapshot("r", { stale: true }),
    publish: async () => { calls += 1; return { synced: true }; },
  });
  assert.deepEqual(await stale({}), { synced: false, reason: "stale" });
  assert.equal(calls, 0);
});

test("concurrent synchronizations are serialized in discovery order", async () => {
  const published = [];
  let sequence = 0;
  const sync = createCatalogSynchronizer({
    config: {},
    discover: async () => {
      const revision = `r${++sequence}`;
      await new Promise((resolve) => setTimeout(resolve, revision === "r1" ? 20 : 0));
      return snapshot(revision);
    },
    publish: async (_config, value) => {
      published.push(value.revision);
      return { synced: true };
    },
  });
  await Promise.all([sync({}), sync({})]);
  assert.deepEqual(published, ["r1", "r2"]);
});

test("configuration changes force a fresh publication for the same catalog revision", async () => {
  let calls = 0;
  const sync = createCatalogSynchronizer({
    config: {},
    discover: async () => snapshot(),
    publish: async () => { calls += 1; return { synced: true }; },
  });
  await sync({ config: { plugins: { entries: { magpie: { config: { refreshSeconds: 10 } } } } } });
  await sync({ config: { plugins: { entries: { magpie: { config: { refreshSeconds: 20 } } } } } });
  assert.equal(calls, 2);
});

test("the fallback service starts immediately, reschedules after settling and stops cleanly", async () => {
  let calls = 0;
  let scheduled;
  let cancelled = false;
  const service = createCatalogService({
    intervalMs: 1000,
    sync: async () => { calls += 1; },
    schedule: (callback) => { scheduled = callback; return { unref() {} }; },
    cancel: () => { cancelled = true; },
  });
  const ctx = { logger: { warn() {} } };
  await service.start(ctx);
  while (calls < 1 || !scheduled) await pause();
  assert.equal(calls, 1);
  const next = scheduled;
  await next();
  assert.equal(calls, 2);
  await service.stop();
  assert.equal(cancelled, true);
  await next();
  assert.equal(calls, 2);
});

test("the service owns its timer even when a host scheduler is present", async () => {
  let scheduled;
  let cancelled = false;
  let runs = 0;
  const service = createCatalogService({
    intervalMs: 5000,
    sync: async () => { runs += 1; },
    schedule: (callback) => { scheduled = callback; return { unref() {} }; },
    cancel: () => { cancelled = true; },
  });
  await service.start({
    logger: { warn() {} },
    scheduler: { schedule() { throw new Error("the plugin timer must be used instead"); } },
  });
  while (!scheduled) await pause();
  assert.equal(runs, 1);
  await scheduled();
  assert.equal(runs, 2);
  await service.stop();
  assert.equal(cancelled, true);
});
