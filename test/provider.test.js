import test from "node:test";
import assert from "node:assert/strict";
import { projectModel } from "../src/catalog.js";
import {
  createMagpieProvider,
  mergeExplicit,
  patchPayload,
  selectEffort,
  thinkingProfile,
} from "../src/provider.js";
import { clineRow, codexRow, nonReasoningRow, thinkingWithoutLevelsRow } from "./fixtures.js";

test("thinking profiles expose advertised levels and default to the model's default effort", () => {
  const codex = projectModel(codexRow());
  assert.deepEqual(thinkingProfile(codex), {
    levels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
    defaultLevel: "medium",
  });
  const empty = projectModel(thinkingWithoutLevelsRow());
  assert.deepEqual(thinkingProfile(empty), {
    levels: [{ id: "adaptive", label: "provider default" }],
    defaultLevel: "adaptive",
  });
  const plain = projectModel(nonReasoningRow());
  assert.deepEqual(thinkingProfile(plain), { levels: [{ id: "off" }], defaultLevel: "off" });
});

test("selectEffort honors exact wire overrides, maps OpenClaw levels, and falls back by strength", () => {
  const codex = projectModel(codexRow());
  assert.equal(selectEffort(codex, "high"), "high");
  assert.equal(selectEffort(codex, "max"), "max");
  assert.equal(selectEffort(codex, "adaptive"), undefined);
  assert.equal(selectEffort(codex, "off"), undefined);
  assert.equal(selectEffort(codex, "minimal"), "low");
  assert.equal(selectEffort(codex, "ultra"), "max");
  assert.equal(selectEffort(codex, "high", "ultra"), "ultra");
  assert.throws(() => selectEffort(codex, "high", "bogus"), /not advertised/);

  const cline = projectModel(clineRow());
  assert.equal(selectEffort(cline, "medium"), "high");
  assert.equal(selectEffort(cline, "xhigh"), "max");
  assert.equal(selectEffort(cline, "minimal"), "low");
  assert.equal(selectEffort(cline, undefined), "high");

  const plain = projectModel(nonReasoningRow());
  assert.equal(selectEffort(plain, "high"), undefined);
  assert.throws(() => selectEffort(plain, "high", "high"), /disabled reasoning/);
});

test("payload patching writes the dialect-specific field and preserves unrelated reasoning settings", () => {
  assert.deepEqual(patchPayload({ reasoning: { summary: "auto" } }, "openai-responses", "high"),
    { reasoning: { summary: "auto", effort: "high" } });
  assert.deepEqual(patchPayload({ reasoning: { summary: "auto", effort: "low" } }, "openai-responses", undefined),
    { reasoning: { summary: "auto" } });
  assert.deepEqual(patchPayload({ reasoning_effort: "low", model: "x" }, "openai-completions", "max"),
    { reasoning_effort: "max", model: "x" });
  assert.deepEqual(patchPayload({ reasoning_effort: "low", model: "x" }, "openai-completions", undefined),
    { model: "x" });
  const anthropic = { thinking: { type: "enabled", budget_tokens: 1000 } };
  assert.deepEqual(patchPayload(anthropic, "anthropic-messages", "high"), anthropic);
  assert.throws(() => patchPayload(null, "openai-completions", "high"), /invalid payload/);
});

test("explicit model configuration overrides live metadata without losing nested Magpie facts", () => {
  const live = projectModel(codexRow());
  const config = {
    models: {
      providers: {
        magpie: {
          models: [{
            id: live.id,
            maxTokens: 4096,
            input: ["text"],
            params: { magpieReasoningEffort: "high" },
          }],
        },
      },
    },
  };
  const merged = mergeExplicit(live, config);
  assert.equal(merged.maxTokens, 4096);
  assert.deepEqual(merged.input, ["text"]);
  assert.equal(merged.params.magpieReasoningEffort, "high");
  assert.equal(merged.params.magpie.owner, "codex");
  assert.equal(merged.api, "openai-responses");

  const disabled = mergeExplicit(live, {
    models: { providers: { magpie: { models: [{ id: live.id, reasoning: false }] } } },
  });
  assert.equal(disabled.reasoning, false);
  assert.equal(disabled.compat.supportsReasoningEffort, false);
  assert.deepEqual(disabled.compat.supportedReasoningEfforts, []);
});

function fakeProvider({ rows = [codexRow()], now = () => Date.now(), config } = {}) {
  let current = rows;
  const calls = [];
  const provider = createMagpieProvider({
    config: config ?? { models: { providers: { magpie: { baseUrl: "http://127.0.0.1:3425/v1", models: [] } } } },
    now,
    fetchRows: async (params) => {
      calls.push(params);
      return current;
    },
    resolveAuth: async () => ({ apiKey: "test-key" }),
  });
  return {
    provider,
    calls,
    setRows(next) { current = next; },
  };
}

test("discovery resolves credentials, returns a provider catalog, and resolves dynamic models", async () => {
  const fixture = fakeProvider();
  const config = { models: { providers: { magpie: { baseUrl: "http://127.0.0.1:3425/v1", models: [] } } } };
  const snapshot = await fixture.provider.discover({ config });
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].api, "openai-responses");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].endpoint, "http://127.0.0.1:3425/v1/models");
  assert.equal(fixture.calls[0].apiKey, "test-key");
  assert.equal(fixture.calls[0].requireHttps, false);
  const headers = fixture.calls[0].buildRequestHeaders({ apiKey: "test-key" });
  assert.equal(headers.Authorization, "Bearer test-key");
  assert.equal(headers["User-Agent"], "openclaw");
  assert.equal(headers["X-Magpie-Prices"], "1");

  const catalog = await fixture.provider.provider.catalog.run({ config });
  assert.equal(catalog.provider.api, "openai-completions");
  assert.equal(catalog.provider.models[0].id, "codex/gpt-6.1-sol");

  const model = fixture.provider.provider.resolveDynamicModel({ config, modelId: "codex/gpt-6.1-sol" });
  assert.equal(model.provider, "magpie");
  assert.equal(model.baseUrl, "http://127.0.0.1:3425/v1");
});

test("provider settings can opt out of the OpenClaw User-Agent", async () => {
  const config = { models: { providers: { magpie: { baseUrl: "http://127.0.0.1:3425/v1", models: [] } } } };
  const silent = fakeProvider({
    config: {
      ...config,
      plugins: { entries: { magpie: { enabled: true, config: { sendUserAgent: false } } } },
    },
  });
  await silent.provider.discover({ config });
  const headers = silent.calls[0].buildRequestHeaders({ apiKey: "test-key" });
  assert.equal(headers["User-Agent"], undefined);
  assert.equal(headers["X-Magpie-Prices"], "1");
});

test("request-time discovery rejects removed models and patches the final payload", async () => {
  let now = 1000;
  const fixture = fakeProvider({ now: () => now });
  const config = { models: { providers: { magpie: { baseUrl: "http://127.0.0.1:3425/v1", models: [] } } } };
  await fixture.provider.discover({ config });
  const model = fixture.provider.provider.resolveDynamicModel({ config, modelId: "codex/gpt-6.1-sol" });

  let sent;
  const streamFn = async (resolved, messages, options) => {
    const payload = await options.onPayload({ model: resolved.id });
    sent = { resolved, payload };
    return { ok: true };
  };
  const wrapped = fixture.provider.provider.wrapStreamFn({ config, streamFn, thinkingLevel: "high" });
  await wrapped(model, [{ role: "user", content: "hi" }], {});
  assert.equal(sent.resolved.api, "openai-responses");
  assert.equal(sent.payload.reasoning.effort, "high");

  fixture.setRows([]);
  now += 61000;
  await assert.rejects(
    wrapped(model, [{ role: "user", content: "hi" }], {}),
    /no longer advertised/,
  );
});

test("provider-scoped catalog reads return null without resolving credentials", async () => {
  const fixture = fakeProvider();
  const result = await fixture.provider.discover({
    config: { models: { providers: { magpie: { baseUrl: "http://127.0.0.1:3425/v1", models: [] } } } },
    providerIds: ["other"],
  });
  assert.equal(result, null);
  assert.equal(fixture.calls.length, 0);
});

test("discovery forwards caller cancellation to pending host authentication before starting a catalog fetch", async () => {
  const controller = new AbortController();
  const reason = new Error("service stopped during authentication");
  let authSignal;
  let fetched = false;
  const provider = createMagpieProvider({
    config: { models: { providers: { magpie: { baseUrl: "http://127.0.0.1:3425/v1", models: [] } } } },
    fetchRows: async () => { fetched = true; return []; },
    resolveAuth: ({ signal }) => {
      authSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const discovery = provider.discover({ signal: controller.signal });
  assert.equal(authSignal, controller.signal);
  controller.abort(reason);
  await assert.rejects(discovery, (error) => error === reason);
  assert.equal(fetched, false);
});

test("unresolved auth markers fail closed", async () => {
  const provider = createMagpieProvider({
    config: { models: { providers: { magpie: { baseUrl: "http://127.0.0.1:3425/v1", models: [] } } } },
    fetchRows: async () => [],
    resolveAuth: async () => ({ apiKey: "env:MAGPIE_API_KEY" }),
    isApiKeyMarker: (value) => value.startsWith("env:"),
  });
  const config = { models: { providers: { magpie: { baseUrl: "http://127.0.0.1:3425/v1", models: [] } } } };
  await assert.rejects(provider.discover({ config }), /marker/);
});
