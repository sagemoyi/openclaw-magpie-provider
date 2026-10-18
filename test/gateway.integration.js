import "./isolated-host-env.js";
// Requires the targeted OpenClaw peer. Catalog changes are checked through public RPC.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { installHostPlugin, resolveHostCli } from "./install-host-plugin.js";
import { codexRow } from "./fixtures.js";
const exec = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function row(id, context = 64000) {
  return codexRow({
    id,
    display_name: id,
    context_window: context,
    context_length: context,
    max_input_tokens: context,
    max_output_tokens: 4096,
    modalities: { input: ["text"] },
    native_endpoints: ["/v1/chat/completions"],
    magpie_price: undefined,
  });
}

test("Gateway publishes Magpie additions, removals, capability changes and empty catalogs without a restart", { timeout: 240000 }, async (t) => {
  let rows = [row("model-a"), row("model-b")];
  let context = 64000;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer test-key") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (req.url !== "/v1/models") {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: rows }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const stateDir = await mkdtemp(path.join(tmpdir(), "magpie-gateway-test-"));
  const configPath = path.join(stateDir, "openclaw.json");
  const token = "isolated-gateway-test-token";
  const config = {
    gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token } },
    models: {
      providers: {
        magpie: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "test-key", models: [] },
      },
    },
    plugins: { allow: ["magpie"], entries: { magpie: { enabled: true, config: { refreshSeconds: 10 } } } },
    agents: {
      defaults: {
        workspace: path.join(stateDir, "workspace"),
        model: { primary: "magpie/model-b" },
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
  const hostCli = resolveHostCli();
  await installHostPlugin((...args) => exec(hostCli, args, { env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }));
  const installedConfig = await readFile(configPath, "utf8");

  let child;
  let log = "";
  function start() {
    child = spawn(hostCli, ["gateway", "run", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { log = (log + chunk.toString()).slice(-20000); });
    child.stderr.on("data", (chunk) => { log = (log + chunk.toString()).slice(-20000); });
  }
  async function stop() {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), pause(5000)]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  t.after(stop);
  start();

  const list = async () => {
    const result = await exec(hostCli, [
      "gateway", "call", "models.list",
      "--url", `ws://127.0.0.1:${port}`,
      "--token", token,
      "--json",
    ], { env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(result.stdout).models.filter((model) => model.provider === "magpie");
  };
  async function waitFor(read, predicate, label) {
    const until = Date.now() + 45000;
    let last;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`Gateway exited: ${log}`);
      try {
        last = await read();
        if (predicate(last)) return last;
      } catch (error) {
        last = error.message;
      }
      await pause(1000);
    }
    throw new Error(`${label} failed: ${JSON.stringify(last)}\n${log}`);
  }

  const initial = await waitFor(list, (models) => models.some((model) => model.id === "model-a"), "initial discovery");
  assert.ok(initial.some((model) => model.id === "model-b"));
  const inspection = JSON.parse((await exec(hostCli,
    ["plugins", "inspect", "magpie", "--runtime", "--json"],
    { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  assert.equal(inspection.plugin.status, "loaded");
  assert.ok(inspection.plugin.providerIds.includes("magpie"));
  assert.equal(inspection.install.artifactKind, "npm-pack");

  rows = [row("model-b", 96000), row("model-c", 96000)];
  const changed = await waitFor(
    list,
    (models) => models.some((model) => model.id === "model-c") && !models.some((model) => model.id === "model-a"),
    "automatic publication",
  );
  assert.equal(changed.find((model) => model.id === "model-b").contextWindow, 96000);

  rows = [];
  await waitFor(list, (models) => models.length === 0, "empty catalog publication");
  assert.equal(await readFile(configPath, "utf8"), installedConfig);
  t.diagnostic(`Catalog published without restart; isolated artifacts: ${stateDir}`);
});
