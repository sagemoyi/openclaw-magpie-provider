// Explicit opt-in: reads the real Magpie catalog. Set MAGPIE_BASE_URL and
// MAGPIE_API_KEY. Discovery is read-only and does not invoke a model.
// Set MAGPIE_LIVE_CASES to also send tiny requests, for example:
//   [{"id":"codex/gpt-6.1-sol","level":"low"}]
import assert from "node:assert/strict";
import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { createMagpieProvider } from "../src/provider.js";

const { MAGPIE_BASE_URL, MAGPIE_API_KEY } = process.env;
if (!MAGPIE_BASE_URL || !MAGPIE_API_KEY) {
  throw new Error("Set MAGPIE_BASE_URL and MAGPIE_API_KEY to run the opt-in live test");
}

const config = { models: { providers: { magpie: { baseUrl: MAGPIE_BASE_URL, models: [] } } } };
const magpie = createMagpieProvider({
  config,
  fetchRows: fetchLiveProviderModelRows,
  resolveAuth: async () => ({ apiKey: MAGPIE_API_KEY }),
});
const snapshot = await magpie.discover({ config }, { force: true });
assert.ok(snapshot.models.length > 0, "Magpie returned an empty catalog");
for (const model of snapshot.models) {
  assert.ok(model.id);
  assert.ok(model.contextWindow > 0);
  assert.ok(Array.isArray(model.input));
  assert.ok(["openai-completions", "openai-responses", "anthropic-messages"].includes(model.api));
}
console.log(JSON.stringify({
  discovered: snapshot.models.length,
  priced: snapshot.priced,
  api: [...new Set(snapshot.models.map((model) => model.api))],
  reasoning: snapshot.models.filter((model) => model.reasoning).length,
  warnings: snapshot.warnings,
  examples: snapshot.models.slice(0, 5).map((model) => ({
    id: model.id,
    api: model.api,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    efforts: model.compat.supportedReasoningEfforts,
    cost: model.cost,
  })),
}, null, 2));

const cases = process.env.MAGPIE_LIVE_CASES ? JSON.parse(process.env.MAGPIE_LIVE_CASES) : [];
for (const entry of cases) {
  const ctx = {
    config,
    modelId: entry.id,
    thinkingLevel: entry.level,
    extraParams: { magpieReasoningEffort: entry.exact },
  };
  const model = magpie.provider.resolveDynamicModel(ctx);
  assert.ok(model, `Magpie did not advertise ${entry.id}`);
  let wireEffort;
  const capture = (resolved, messages, options) => streamSimple(resolved, messages, {
    ...options,
    onPayload: async (payload, wireModel) => {
      const body = await options.onPayload(payload, wireModel);
      wireEffort = body.reasoning?.effort ?? body.reasoning_effort;
      return body;
    },
  });
  const stream = await magpie.provider.wrapStreamFn({ ...ctx, streamFn: capture })(
    model,
    { messages: [{ role: "user", content: "Reply with only the word OK.", timestamp: Date.now() }] },
    { apiKey: MAGPIE_API_KEY, maxTokens: 512, signal: AbortSignal.timeout(60000) },
  );
  const result = await stream.result();
  console.log(JSON.stringify({
    id: entry.id,
    api: model.api,
    requested: entry.level,
    exact: entry.exact,
    wireEffort,
    stopReason: result.stopReason,
    output: result.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
    inputTokens: result.usage?.input,
    outputTokens: result.usage?.output,
    error: result.stopReason === "error" ? "Upstream request failed" : undefined,
  }));
  assert.notEqual(result.stopReason, "error", `Live request failed for ${entry.id}`);
  assert.notEqual(result.stopReason, "aborted", `Live request aborted for ${entry.id}`);
}
