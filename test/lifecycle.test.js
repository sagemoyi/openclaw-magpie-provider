import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createCatalogService as createService, createCatalogSynchronizer } from "../src/lifecycle.js";
import { CatalogClient } from "../src/catalog.js";

const pause = () => new Promise((resolve) => setImmediate(resolve));
// Pure tests inject an equivalent admission runner; the real entry requires the
// pinned host lifecycle API rather than silently inheriting an expired start token.
const createCatalogService = (options) => createService({ runInBackgroundContext: (run) => run(), ...options });

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

test("the service requires host background admission rather than a detached unowned fallback", () => {
  assert.throws(() => createService({ sync: async () => {}, intervalMs: 1000 }), /host background lifecycle API/);
});

test("every tick has a fresh host admission that owns the complete publication promise", async () => {
  const scope = new AsyncLocalStorage();
  const active = new Set();
  const seen = [];
  let scheduled;
  let finishPublication;
  const sync = createCatalogSynchronizer({
    config: {},
    discover: async () => {
      await pause();
      assert.ok(active.has(scope.getStore()));
      return snapshot();
    },
    publish: async () => {
      const token = scope.getStore();
      seen.push(token);
      if (seen.length === 1) await new Promise((resolve) => { finishPublication = resolve; });
      await pause();
      assert.ok(active.has(token), "host admission remains live through publication settlement");
      return { synced: true };
    },
  });
  const service = createService({
    sync: (ctx) => sync(ctx, true), intervalMs: 1000,
    runInBackgroundContext: (run) => {
      const token = {};
      active.add(token);
      return scope.run(token, async () => {
        try { return await run(); } finally { active.delete(token); }
      });
    },
    schedule: (callback) => { scheduled = callback; return { unref() {} }; },
    cancel() {},
  });
  await service.start({});
  while (!finishPublication) await pause();
  assert.equal(active.size, 1);
  assert.equal(scheduled, undefined, "do not start another tick while publication runs");
  finishPublication();
  while (!scheduled) await pause();
  assert.equal(active.size, 0);
  await scheduled();
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "a released startup/timer token is never reused");
  assert.equal(active.size, 0);
  await service.stop();
});

test("a host-like replacement guard can reject admitted publication and the restarted service recovers", async () => {
  const scope = new AsyncLocalStorage();
  let reserved = false;
  let finishDiscovery;
  let publications = 0;
  let scheduled;
  const warnings = [];
  const sync = createCatalogSynchronizer({
    config: {},
    discover: async () => {
      if (!finishDiscovery) await new Promise((resolve) => { finishDiscovery = resolve; });
      return snapshot();
    },
    publish: async () => {
      assert.equal(scope.getStore()?.active, true);
      if (reserved) throw new Error("admitted plugin work cannot wait for replacement");
      publications++;
      return { synced: true };
    },
  });
  const service = createService({
    sync, intervalMs: 1000,
    runInBackgroundContext: (run) => scope.run({ active: true }, async () => {
      const token = scope.getStore();
      try { return await run(); } finally { token.active = false; }
    }),
    schedule: (callback) => { scheduled = callback; return { unref() {} }; },
    cancel() {},
  });
  await service.start({ logger: { warn: (message) => warnings.push(message) } });
  while (!finishDiscovery) await pause();
  reserved = true;
  finishDiscovery();
  while (!scheduled) await pause();
  await service.stop();
  assert.equal(publications, 0);
  assert.match(warnings[0], /cannot wait for replacement/);
  reserved = false;
  scheduled = undefined;
  await service.start({});
  while (!scheduled) await pause();
  await service.stop();
  assert.equal(publications, 1);
});

test("the service starts immediately, reschedules after settling and stops cleanly", async () => {
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


test("the service subscribes to discovery, credential and agent configuration", () => {
  const service = createCatalogService({ sync: async () => {}, intervalMs: 1000 });
  assert.deepEqual(service.reload.configPrefixes, ["models.providers.magpie", "auth", "agents", "secrets"]);
});

test("stopping a service cancels its wait without aborting shared discovery or publishing", async () => {
  let complete;
  let requestSignal;
  let publications = 0;
  const warnings = [];
  const client = new CatalogClient({
    fetchRows: ({ signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => { complete = resolve; });
    },
  });
  const args = { baseUrl: "http://127.0.0.1:3425/v1", apiKey: "test-key" };
  const sync = createCatalogSynchronizer({
    config: {},
    discover: (ctx) => client.get({ ...args, signal: ctx.signal }),
    publish: async () => { publications++; return { synced: true }; },
  });
  const service = createCatalogService({
    sync,
    intervalMs: 1000,
    schedule: () => { throw new Error("stopped service must not reschedule"); },
  });
  await service.start({ config: {}, logger: { warn: (message) => warnings.push(message) } });
  while (!complete) await pause();
  const otherConsumer = client.get(args);
  await service.stop();
  assert.equal(requestSignal.aborted, false);
  complete([]);
  assert.deepEqual((await otherConsumer).models, []);
  await pause();
  assert.equal(publications, 0);
  assert.deepEqual(warnings, []);
});

test("a cancelled discovery result cannot publish and queued cancelled runs never start", async () => {
  let finish;
  let discoveries = 0;
  let publications = 0;
  const sync = createCatalogSynchronizer({
    config: {},
    discover: () => {
      discoveries++;
      return new Promise((resolve) => { finish = resolve; });
    },
    publish: async () => { publications++; return { synced: true }; },
  });
  const controller = new AbortController();
  const first = sync({ signal: controller.signal });
  const queued = sync({ signal: controller.signal });
  const rejected = Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(queued, { name: "AbortError" }),
  ]);
  await pause();
  controller.abort();
  finish(snapshot());
  await rejected;
  assert.equal(discoveries, 1);
  assert.equal(publications, 0);
});

test("stop drains already admitted host publication and restart uses committed configuration", async () => {
  const observed = [];
  let finishPublication;
  const sync = createCatalogSynchronizer({
    config: {},
    discover: async (ctx) => snapshot("r", { baseUrl: ctx.config.endpoint }),
    publish: async (config) => {
      observed.push(config.endpoint);
      if (config.endpoint === "old") await new Promise((resolve) => { finishPublication = resolve; });
      return { synced: true };
    },
  });
  let scheduled;
  const service = createCatalogService({
    sync, intervalMs: 1000,
    schedule: (callback) => { scheduled = callback; return { unref() {} }; },
    cancel: () => {},
  });
  await service.start({ config: { endpoint: "old" } });
  while (!finishPublication) await pause();
  let stopped = false;
  const stop = service.stop().then(() => { stopped = true; });
  await pause();
  assert.equal(stopped, false);
  finishPublication();
  await stop;
  await service.start({ config: { endpoint: "new" } });
  while (!scheduled) await pause();
  await service.stop();
  assert.deepEqual(observed, ["old", "new"]);
});
