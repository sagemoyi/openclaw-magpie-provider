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
