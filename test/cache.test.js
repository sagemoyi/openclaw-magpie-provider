import test from "node:test";
import assert from "node:assert/strict";
import { CatalogClient } from "../src/catalog.js";
import { codexRow, grokRow } from "./fixtures.js";

function fixture() {
  let time = 1000;
  let calls = 0;
  let failure;
  let rows = [codexRow()];
  let headers;
  const client = new CatalogClient({
    now: () => time,
    ttlMs: 100,
    staleMs: 200,
    includePrices: true,
    fetchRows: async (params) => {
      calls += 1;
      headers = params.buildRequestHeaders({ apiKey: params.apiKey });
      if (failure) throw failure;
      return rows.map((row) => ({ ...row }));
    },
  });
  return {
    client,
    args: { baseUrl: "http://127.0.0.1:3425/v1", apiKey: "key-a" },
    calls: () => calls,
    headers: () => headers,
    advance: (ms) => { time += ms; },
    fail(status) { failure = Object.assign(new Error("upstream detail must not leak"), { status }); },
    recover() { failure = undefined; },
    change(next) { rows = next; },
  };
}

function controlledFixture(options = {}) {
  let calls = 0;
  let requestSignal;
  const pending = Promise.withResolvers();
  const client = new CatalogClient({
    ...options,
    fetchRows: ({ signal }) => {
      calls += 1;
      requestSignal = signal;
      signal.throwIfAborted();
      const cancelled = () => pending.reject(signal.reason);
      signal.addEventListener("abort", cancelled, { once: true });
      return pending.promise.finally(() => signal.removeEventListener("abort", cancelled));
    },
  });
  return {
    client,
    args: { baseUrl: "http://127.0.0.1:3425/v1", apiKey: "key-a" },
    calls: () => calls,
    signal: () => requestSignal,
    resolve: (rows = [codexRow()]) => pending.resolve(rows),
  };
}

test("TTL cache coalesces concurrent reads and atomically adds, updates and removes models", async () => {
  const f = fixture();
  const values = await Promise.all(Array.from({ length: 10 }, () => f.client.get(f.args)));
  assert.equal(f.calls(), 1);
  assert.equal(values[0].models[0].id, "codex/gpt-6.1-sol");
  assert.equal(f.headers().Authorization, "Bearer key-a");
  assert.equal(f.headers()["X-Magpie-Prices"], "1");

  f.change([grokRow()]);
  f.advance(101);
  const next = await f.client.get(f.args);
  assert.deepEqual(next.models.map((model) => model.id), ["grok/grok-4.5@500k"]);
  assert.notEqual(next.revision, values[0].revision);

  f.change([]);
  f.advance(101);
  assert.deepEqual((await f.client.get(f.args)).models, []);
});

test("cancelling the first waiter does not cancel shared discovery or poison later reads", async () => {
  const f = controlledFixture();
  const controller = new AbortController();
  const reason = new Error("first waiter cancelled");
  const a = f.client.get({ ...f.args, signal: controller.signal });
  const b = f.client.get(f.args);
  const cancelled = assert.rejects(a, (error) => error === reason);
  controller.abort(reason);
  await cancelled;
  assert.equal(f.signal().aborted, false);
  const c = f.client.get(f.args);
  f.resolve();
  const [fromB, fromC] = await Promise.all([b, c]);
  assert.equal(fromB, fromC);
  assert.equal(fromB.stale, false);
  assert.equal(await f.client.get(f.args), fromB);
  assert.equal(f.calls(), 1);
});

test("cancelling a later waiter leaves the initiating and other waiters intact", async () => {
  const f = controlledFixture();
  const first = f.client.get(f.args);
  const controller = new AbortController();
  const reason = new Error("later waiter cancelled");
  const later = f.client.get({ ...f.args, signal: controller.signal });
  const other = f.client.get(f.args);
  const cancelled = assert.rejects(later, (error) => error === reason);
  controller.abort(reason);
  await cancelled;
  assert.equal(f.signal().aborted, false);
  f.resolve();
  const [fromFirst, fromOther] = await Promise.all([first, other]);
  assert.equal(fromFirst, fromOther);
  assert.equal(f.calls(), 1);
});

test("pre-cancelled waiters neither start discovery nor disturb an existing fetch", async () => {
  const f = controlledFixture();
  const reason = new Error("cancelled before discovery");
  const signal = AbortSignal.abort(reason);
  await assert.rejects(f.client.get({ ...f.args, signal }), (error) => error === reason);
  assert.equal(f.calls(), 0);
  assert.equal(f.client.entries.size, 0);
  const first = f.client.get(f.args);
  await assert.rejects(f.client.get({ ...f.args, signal }), (error) => error === reason);
  assert.equal(f.signal().aborted, false);
  f.resolve();
  await first;
  assert.equal(f.calls(), 1);
});

test("a genuine shared discovery timeout fails all waiters and retains error backoff", async () => {
  const f = controlledFixture({ timeoutMs: 20 });
  // AbortSignal.timeout is unref'ed; keep this mocked request alive until expiry.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const results = await Promise.allSettled([f.client.get(f.args), f.client.get(f.args)]);
    assert.equal(f.signal().aborted, true);
    assert.equal(f.signal().reason.name, "TimeoutError");
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /Magpie discovery failed \(network or invalid catalog\)/);
    }
    assert.equal(results[0].reason, results[1].reason);
    await assert.rejects(f.client.get(f.args), (error) => error === results[0].reason);
    assert.equal(f.calls(), 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("upstream network failures without a snapshot are backed off and can recover", async () => {
  const f = fixture();
  f.fail(undefined);
  const results = await Promise.allSettled([f.client.get(f.args), f.client.get(f.args)]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /network or invalid catalog/);
    assert.doesNotMatch(result.reason.message, /upstream detail/);
  }
  await assert.rejects(f.client.get(f.args), /network or invalid catalog/);
  assert.equal(f.calls(), 1);
  f.recover();
  f.advance(101);
  assert.equal((await f.client.get(f.args)).stale, false);
  assert.equal(f.calls(), 2);
});

test("transient failures use a bounded stale snapshot without extending its expiry", async () => {
  const f = fixture();
  const first = await f.client.get(f.args);
  f.advance(101);
  f.fail(503);
  const stale = await f.client.get(f.args);
  assert.equal(stale.stale, true);
  assert.equal(stale.models[0].id, first.models[0].id);
  const calls = f.calls();
  const again = await f.client.get(f.args);
  assert.equal(again.stale, true);
  assert.equal(f.calls(), calls);
  f.advance(301);
  await assert.rejects(f.client.get(f.args), /HTTP 503/);
});

test("401/403 invalidates the cached catalog instead of serving stale models", async () => {
  const f = fixture();
  await f.client.get(f.args);
  f.advance(101);
  f.fail(401);
  await assert.rejects(f.client.get(f.args), /HTTP 401/);
  assert.equal(f.client.peek(f.args.baseUrl, f.args.apiKey), undefined);
  f.recover();
  f.change([grokRow()]);
  f.advance(101);
  const recovered = await f.client.get(f.args);
  assert.equal(recovered.models[0].id, "grok/grok-4.5@500k");
});

test("cache entries are isolated by endpoint and credential", async () => {
  const f = fixture();
  await f.client.get(f.args);
  await f.client.get({ ...f.args, apiKey: "key-b" });
  assert.equal(f.calls(), 2);
  const before = f.calls();
  await f.client.get(f.args);
  assert.equal(f.calls(), before);
});

test("force bypasses TTL and returns a fresh revision", async () => {
  const f = fixture();
  await f.client.get(f.args);
  f.change([grokRow()]);
  const forced = await f.client.get({ ...f.args, force: true });
  assert.equal(forced.models[0].id, "grok/grok-4.5@500k");
  assert.equal(f.calls(), 2);
});

test("malformed and duplicate rows keep the last good snapshot instead of producing deletions", async () => {
  const f = fixture();
  const first = await f.client.get(f.args);
  f.change([codexRow(), codexRow()]);
  f.advance(101);
  const stale = await f.client.get(f.args);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.models.map((model) => model.id), first.models.map((model) => model.id));
  f.advance(301);
  await assert.rejects(f.client.get(f.args), /duplicate|invalid/);
});
