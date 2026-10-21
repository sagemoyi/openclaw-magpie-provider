import test from "node:test";
import assert from "node:assert/strict";
import {
  CatalogClient,
  buildMagpieHeaders,
  normalizeBaseUrl,
  projectCatalog,
  projectModel,
  readCatalogRows,
  readPrice,
} from "../src/catalog.js";
import {
  clineRow,
  codexRow,
  grokRow,
  imageRow,
  nonReasoningRow,
  thinkingWithoutLevelsRow,
  unpricedRow,
} from "./fixtures.js";

test("endpoint normalization preserves proxy prefixes and rejects credentials, queries and fragments", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:3425"), "http://127.0.0.1:3425/v1");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:3425/v1/"), "http://127.0.0.1:3425/v1");
  assert.equal(normalizeBaseUrl("https://proxy.test/magpie"), "https://proxy.test/magpie/v1");
  for (const url of ["file:///tmp/magpie", "http://user:secret@host", "https://host?key=secret", "https://host/#fragment", "not a url"]) {
    assert.throws(() => normalizeBaseUrl(url));
  }
});

test("endpoint normalization rejects even empty query/fragment delimiters without rejecting encoded path characters", () => {
  for (const suffix of ["?", "#", "?#", "/?", "/#", "/v1?", "/v1#"]) {
    assert.throws(() => normalizeBaseUrl(`https://proxy.test${suffix}`), /query or fragment/);
  }
  assert.equal(normalizeBaseUrl("https://proxy.test/path%3Fpart%23name"), "https://proxy.test/path%3Fpart%23name/v1");
});

test("catalog envelopes accept data[], models[] and top-level arrays", () => {
  assert.deepEqual(readCatalogRows({ data: [codexRow()] }), [codexRow()]);
  assert.deepEqual(readCatalogRows({ models: [codexRow()] }), [codexRow()]);
  assert.deepEqual(readCatalogRows([codexRow()]), [codexRow()]);
  assert.throws(() => readCatalogRows({ error: "no" }), /data\[\] or models\[\]/);
  assert.throws(() => readCatalogRows(null), /JSON object or array/);
});

test("codex rows map to Responses with context, output, modalities, reasoning, pricing and service tiers", () => {
  const model = projectModel(codexRow());
  assert.equal(model.id, "codex/gpt-6.1-sol");
  assert.equal(model.name, "GPT-6.1-Sol");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.contextWindow, 500000);
  assert.equal(model.maxTokens, 128000);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.compat.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(model.compat.supportedReasoningEfforts.includes("ultra"), false);
  assert.equal(model.compat.supportsReasoningEffort, true);
  assert.equal(model.compat.thinkingFormat, "openai");
  assert.deepEqual(model.cost, {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    tieredPricing: [
      { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, range: [0, 272000] },
      { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5, range: [272000] },
    ],
  });
  assert.deepEqual(model.params.magpie.serviceTiers, [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]);
  assert.equal(model.params.magpie.priced, true);
  assert.equal(model.params.magpie.defaultEffort, "medium");
  assert.ok(model.params.magpie.warnings.some((warning) => warning.includes("ultra")));
});

test("grok rows without an output limit fall back conservatively and cap at the context", () => {
  const model = projectModel(grokRow());
  assert.equal(model.api, "openai-responses");
  assert.equal(model.maxTokens, 65535);
  assert.equal(model.contextWindow, 500000);
  assert.ok(model.params.magpie.warnings.some((warning) => warning.includes("Output limit unknown")));
});

test("chat-native cline rows keep completions and text-only input", () => {
  const model = projectModel(clineRow());
  assert.equal(model.api, "openai-completions");
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.maxTokens, 384000);
  assert.equal(model.params.magpie.defaultEffort, "high");
  assert.equal(model.params.magpie.priced, true);
});

test("a thinking model with no advertised levels stays reasoning-capable without inventing controls", () => {
  const model = projectModel(thinkingWithoutLevelsRow());
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.compat.supportedReasoningEfforts, []);
  assert.equal(model.compat.supportsReasoningEffort, false);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.ok(model.params.magpie.warnings.some((warning) => warning.includes("audio, video")));
});

test("unpriced models use unknown-zero cost rather than claiming a free price", () => {
  const model = projectModel(unpricedRow());
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(model.params.magpie.priced, false);
  assert.ok(model.params.magpie.warnings.some((warning) => warning.includes("pricing")));
});

test("non-reasoning rows discard advertised levels", () => {
  const model = projectModel(nonReasoningRow({ reasoning_levels: ["low", "high"], supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }));
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.compat.supportedReasoningEfforts, []);
  assert.equal(model.compat.supportsReasoningEffort, false);
});

test("image and video rows are excluded from the text catalog", () => {
  assert.equal(projectModel(imageRow()), null);
  assert.equal(projectModel({ id: "grok/imagine", kind: "video", type: "model" }), null);
});

test("duplicate IDs and invalid rows fail the snapshot instead of deleting models", () => {
  assert.throws(() => projectCatalog([codexRow(), codexRow()]), /duplicate/);
  assert.throws(() => projectModel({ id: "" }), /invalid model ID/);
  assert.throws(() => projectModel({ id: "bad\nid" }), /invalid model ID/);
  assert.throws(() => projectModel({ id: "bad id" }), /invalid model ID/);
  assert.throws(() => projectModel(null), /non-object/);
});

test("multiple price tiers become half-open ranges with an open-ended last tier", () => {
  const price = readPrice({
    input: 1,
    output: 2,
    cache_read: 0.1,
    cache_write: 0,
    tiers: [
      { above: 200000, input: 2, output: 4, cache_read: 0.2, cache_write: 0 },
      { above: 400000, input: 4, output: 8, cache_read: 0.4, cache_write: 0 },
    ],
  });
  assert.deepEqual(price.tieredPricing.map((tier) => tier.range), [[0, 200000], [200000, 400000], [400000]]);
  assert.deepEqual(price.tieredPricing[0], { ...price.cost, range: [0, 200000] });
  assert.deepEqual(price.tieredPricing[1], { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0, range: [200000, 400000] });
  assert.deepEqual(price.tieredPricing[2], { input: 4, output: 8, cacheRead: 0.4, cacheWrite: 0, range: [400000] });
  for (const [tokens, expectedInput] of [[0, 1], [199999, 1], [200000, 2], [200001, 2], [399999, 2], [400000, 4], [400001, 4]]) {
    const matching = price.tieredPricing.filter(({ range: [start, end = Infinity] }) => tokens >= start && tokens < end);
    assert.equal(matching.length, 1, `exactly one price interval for ${tokens} tokens`);
    assert.equal(matching[0].input, expectedInput);
  }
});

test("partial and invalid tier rates inherit normalized base rates while explicit zero stays zero", () => {
  const { cost, tieredPricing } = readPrice({
    input: 1,
    output: 2,
    cache_read: 0.1,
    cache_write: 3,
    tiers: [
      { above: 100000, input: 4 },
      { above: 200000, input: -1, output: NaN, cache_read: "0.5", cache_write: Infinity },
      { above: 300000, input: 0, output: 0, cache_read: 0, cache_write: 0 },
    ],
  });
  assert.deepEqual(cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 });
  assert.deepEqual(tieredPricing, [
    { ...cost, range: [0, 100000] },
    { ...cost, input: 4, range: [100000, 200000] },
    { ...cost, range: [200000, 300000] },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, range: [300000] },
  ]);
});

test("absent or invalid price tiers do not add a redundant base interval", () => {
  const base = { input: 1, output: 2, cache_read: 0.1, cache_write: 3 };
  for (const tiers of [undefined, [], [{ above: 0 }], [{ above: -1 }], [{ above: Infinity }], [{ above: "100000" }]]) {
    assert.deepEqual(readPrice({ ...base, tiers }), {
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 },
      tieredPricing: undefined,
    });
  }
});

test("Magpie request headers carry the gateway key, identify OpenClaw and opt into pricing", () => {
  assert.deepEqual(buildMagpieHeaders({ apiKey: "secret", includePrices: true }), {
    Accept: "application/json",
    Authorization: "Bearer secret",
    "User-Agent": "openclaw",
    "X-Magpie-Prices": "1",
  });
  assert.deepEqual(buildMagpieHeaders({ discoveryApiKey: "discovery", includePrices: false }), {
    Accept: "application/json",
    Authorization: "Bearer discovery",
    "User-Agent": "openclaw",
  });
  // Sending the client identity is a default, not a requirement.
  assert.deepEqual(buildMagpieHeaders({ discoveryApiKey: "discovery", sendUserAgent: false }), {
    Accept: "application/json",
    Authorization: "Bearer discovery",
    "X-Magpie-Prices": "1",
  });
});

test("invalid limits do not escape to the runtime", () => {
  const model = projectModel(codexRow({ context_window: -1, context_length: -1, max_input_tokens: Infinity, max_output_tokens: 0 }));
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.maxTokens, 65535);
});
