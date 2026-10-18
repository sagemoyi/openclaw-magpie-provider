import "./isolated-host-env.js";
// Explicit integration suite: requires an installed OpenClaw executable + peer SDK.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { calculateCost, streamSimple } from "openclaw/plugin-sdk/llm";
import { projectModel } from "../src/catalog.js";
import { createMagpieProvider } from "../src/provider.js";
import { installHostPlugin, resolveHostCli } from "./install-host-plugin.js";
import { clineRow, codexRow, thinkingWithoutLevelsRow } from "./fixtures.js";
const exec = promisify(execFile);

function sendChat(res, body) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.write(`data: ${JSON.stringify({
    id: "chat-test",
    object: "chat.completion.chunk",
    created: 1,
    model: body.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: "chat-test",
    object: "chat.completion.chunk",
    created: 1,
    model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function sendResponses(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  const event = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  event({ type: "response.created", response: { id: "resp-mock" } });
  event({ type: "response.output_item.added", item: { id: "msg-mock", type: "message", role: "assistant", content: [] } });
  event({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
  event({ type: "response.output_text.delta", delta: "OK" });
  event({
    type: "response.output_item.done",
    item: { id: "msg-mock", type: "message", content: [{ type: "output_text", text: "OK" }] },
  });
  event({
    type: "response.completed",
    response: { id: "resp-mock", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  });
  res.end();
}

async function startMock(getRows) {
  const requests = [];
  let modelHeader;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer test-key") {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "unauthorized" } }));
      return;
    }
    if (req.url === "/v1/models") {
      modelHeader = req.headers["x-magpie-prices"];
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: getRows() }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end("{}");
      return;
    }
    requests.push({ url: req.url, body: parsed });
    if (req.url === "/v1/chat/completions") sendChat(res, parsed);
    else if (req.url === "/v1/responses") sendResponses(res);
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    modelHeader: () => modelHeader,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("real host pricing uses base rates below the threshold and tier rates at and above it", () => {
  const model = projectModel(codexRow());
  for (const input of [1000, 271999, 272000, 272001]) {
    const usage = { input, output: 100, cacheRead: 0, cacheWrite: 0, cost: {} };
    const actual = calculateCost(model, usage);
    const [inputRate, outputRate] = input < 272000 ? [2, 10] : [4, 15];
    const expected = (input * inputRate + 100 * outputRate) / 1e6;
    assert.ok(Math.abs(actual.total - expected) < 1e-12, `wrong rate at ${input} input tokens`);
  }
  const partial = projectModel(codexRow({
    magpie_price: {
      input: 1, output: 2, cache_read: 0.1, cache_write: 3,
      tiers: [{ above: 100000, input: 4 }],
    },
  }));
  const usage = { input: 100000, output: 100, cacheRead: 1000, cacheWrite: 1000, cost: {} };
  assert.deepEqual(calculateCost(partial, usage), {
    input: 0.4, output: 0.0002, cacheRead: 0.0001, cacheWrite: 0.003,
    total: 0.4 + 0.0002 + 0.0001 + 0.003,
  });
});

test("real SDK discovery, Responses transport, Chat transport and thinking payloads", async (t) => {
  const mock = await startMock(() => [codexRow(), clineRow(), thinkingWithoutLevelsRow()]);
  t.after(() => mock.close());
  const config = {
    models: {
      providers: {
        magpie: {
          baseUrl: mock.baseUrl,
          api: "openai-completions",
          apiKey: "test-key",
          models: [],
        },
      },
    },
  };
  const magpie = createMagpieProvider({
    config,
    fetchRows: fetchLiveProviderModelRows,
    resolveAuth: async () => ({ apiKey: "test-key" }),
  });
  const catalog = await magpie.provider.catalog.run({ config });
  assert.equal(catalog.provider.models.length, 3);
  assert.equal(mock.modelHeader(), "1");

  const codex = magpie.provider.resolveDynamicModel({ config, modelId: "codex/gpt-6.1-sol" });
  assert.equal(codex.api, "openai-responses");
  const responses = await magpie.provider.wrapStreamFn({ config, thinkingLevel: "high", streamFn: streamSimple })(
    codex,
    { messages: [{ role: "user", content: "Reply only with OK.", timestamp: Date.now() }] },
    { apiKey: "test-key", maxTokens: 32 },
  );
  const responsesResult = await responses.result();
  assert.equal(responsesResult.stopReason, "stop", responsesResult.errorMessage);
  assert.equal(mock.requests.at(-1).url, "/v1/responses");
  assert.equal(mock.requests.at(-1).body.reasoning.effort, "high");
  assert.equal(mock.requests.at(-1).body.model, "codex/gpt-6.1-sol");

  const cline = magpie.provider.resolveDynamicModel({ config, modelId: "cline/cline-pass/deepseek-v4-pro" });
  assert.equal(cline.api, "openai-completions");
  const chat = await magpie.provider.wrapStreamFn({ config, thinkingLevel: "max", streamFn: streamSimple })(
    cline,
    { messages: [{ role: "user", content: "Reply only with OK.", timestamp: Date.now() }] },
    { apiKey: "test-key", maxTokens: 32 },
  );
  const chatResult = await chat.result();
  assert.equal(chatResult.stopReason, "stop", chatResult.errorMessage);
  assert.equal(mock.requests.at(-1).url, "/v1/chat/completions");
  assert.equal(mock.requests.at(-1).body.reasoning_effort, "max");

  const noLevels = magpie.provider.resolveDynamicModel({ config, modelId: "cline/cline-pass/mimo-v2.5" });
  assert.equal(noLevels.reasoning, true);
  const noLevelsStream = await magpie.provider.wrapStreamFn({ config, thinkingLevel: "high", streamFn: streamSimple })(
    noLevels,
    { messages: [{ role: "user", content: "Reply only with OK.", timestamp: Date.now() }] },
    { apiKey: "test-key", maxTokens: 32 },
  );
  const noLevelsResult = await noLevelsStream.result();
  assert.equal(noLevelsResult.stopReason, "stop", noLevelsResult.errorMessage);
  assert.equal(Object.hasOwn(mock.requests.at(-1).body, "reasoning_effort"), false);
});

test("isolated OpenClaw CLI installs and loads the provider, discovers models and syncs without editing config", { timeout: 240000 }, async (t) => {
  let rows = [
    codexRow({ id: "model-a", display_name: "Model A", native_endpoints: ["/v1/responses"], magpie_price: undefined }),
    clineRow({ id: "model-b", display_name: "Model B", native_endpoints: ["/v1/chat/completions"], magpie_price: undefined }),
  ];
  const mock = await startMock(() => rows);
  t.after(() => mock.close());
  const stateDir = await mkdtemp(path.join(tmpdir(), "magpie-openclaw-test-"));
  const configPath = path.join(stateDir, "openclaw.json");
  const config = {
    models: {
      providers: {
        magpie: { baseUrl: mock.baseUrl, api: "openai-completions", apiKey: "test-key", models: [] },
      },
    },
    plugins: { allow: ["magpie"], entries: { magpie: { enabled: true } } },
    agents: {
      defaults: {
        workspace: path.join(stateDir, "workspace"),
        models: { "magpie/*": {} },
        modelPolicy: { allow: ["magpie/*"] },
      },
    },
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  };
  delete env.OPENCLAW_AGENT_DIR;
  const cli = async (...args) => exec(resolveHostCli(), args, { env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  await installHostPlugin(cli);
  const installedConfig = await readFile(configPath, "utf8");
  const listing = JSON.parse((await cli("plugins", "list", "--json")).stdout);
  const plugin = listing.plugins.find((entry) => entry.id === "magpie");
  assert.equal(plugin.status, "loaded", JSON.stringify(plugin));

  const initial = JSON.parse((await cli("magpie", "catalog")).stdout);
  assert.deepEqual(initial.models.map((model) => model.id), ["model-a", "model-b"]);
  assert.ok(!JSON.stringify(initial).includes("test-key"));
  assert.ok(!JSON.stringify(initial).includes(mock.baseUrl));

  const firstSync = JSON.parse((await cli("magpie", "sync")).stdout);
  assert.equal(firstSync.synced, true);
  const refresh = (await cli("models", "list", "--help")).stdout.includes("--refresh") ? ["--refresh"] : [];
  const firstList = await cli("models", "list", "--all", "--provider", "magpie", ...refresh, "--json");
  t.diagnostic(`first models list: ${firstList.stdout.slice(0, 1200)}`);
  assert.ok(firstList.stdout.includes("magpie/model-a"));

  // Reproduce the production provider-level api: openai-completions and prove
  // the host still applies the per-model Responses route from the plugin.
  const run = JSON.parse((await cli("infer", "model", "run", "--model", "magpie/model-a",
    "--prompt", "Reply only with OK.", "--thinking", "high", "--local", "--json")).stdout);
  t.diagnostic(`model run: ${JSON.stringify(run).slice(0, 1200)}`);
  assert.equal(mock.requests.at(-1).url, "/v1/responses");
  assert.equal(mock.requests.at(-1).body.reasoning.effort, "high");

  rows = [
    clineRow({ id: "model-b", display_name: "Model B", native_endpoints: ["/v1/chat/completions"], magpie_price: undefined }),
    codexRow({ id: "model-c", display_name: "Model C", native_endpoints: ["/v1/responses"], magpie_price: undefined }),
  ];
  const updated = JSON.parse((await cli("magpie", "catalog")).stdout);
  assert.deepEqual(updated.models.map((model) => model.id), ["model-b", "model-c"]);
  assert.equal(JSON.parse((await cli("magpie", "sync")).stdout).synced, true);
  const models = await cli("models", "list", "--all", "--provider", "magpie", ...refresh, "--json");
  assert.ok(models.stdout.includes("magpie/model-c"));
  assert.ok(!models.stdout.includes("magpie/model-a"));
  assert.equal(await readFile(configPath, "utf8"), installedConfig);
  t.diagnostic(`Isolated host artifacts retained for inspection: ${stateDir}`);
});
