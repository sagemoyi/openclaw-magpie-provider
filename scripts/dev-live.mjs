#!/usr/bin/env node
// Development-only live smoke test. It creates a temporary OpenClaw state and
// Gateway, links this checkout, and asks the real Magpie endpoint for its
// catalog. It never touches the default profile or the production config.
//
//   MAGPIE_BASE_URL=http://127.0.0.1:3425/v1 \
//   MAGPIE_API_KEY=... node scripts/dev-live.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function resolveHostCli(cwd = process.cwd(), pathEnv = process.env.PATH ?? "") {
  const local = path.join(cwd, "node_modules", ".bin", "openclaw");
  try { realpathSync(local); return local; } catch { /* use PATH */ }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "openclaw");
    try { realpathSync(candidate); return candidate; } catch { /* keep looking */ }
  }
  return "openclaw";
}
const baseUrl = process.env.MAGPIE_BASE_URL;
const apiKey = process.env.MAGPIE_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("Set MAGPIE_BASE_URL and MAGPIE_API_KEY for the isolated live smoke test");
}
const keep = process.env.MAGPIE_KEEP_STATE === "1";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

const stateDir = await mkdtemp(path.join(tmpdir(), "magpie-dev-live-"));
const configPath = path.join(stateDir, "openclaw.json");
const token = "magpie-dev-live-token";
const config = {
  gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token } },
  models: {
    providers: {
      magpie: { baseUrl, api: "openai-completions", apiKey, models: [] },
    },
  },
  plugins: { allow: ["magpie"], entries: { magpie: { enabled: true } } },
  agents: {
    defaults: {
      workspace: path.join(stateDir, "workspace"),
      model: { primary: "magpie/codex/gpt-6.1-sol" },
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
  XDG_CACHE_HOME: path.join(stateDir, "cache"),
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
};
delete env.OPENCLAW_AGENT_DIR;
delete env.OPENCLAW_GATEWAY_PORT;

const hostCli = resolveHostCli();
const cli = async (...args) => exec(hostCli, args, { env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
const installHelp = (await cli("plugins", "install", "--help")).stdout;
const installArgs = ["plugins", "install", "--link"];
if (/Confirm non-ClawHub sources/.test(installHelp)) installArgs.push("--force");
if (installHelp.includes("--accept-capabilities")) installArgs.push("--accept-capabilities");
await cli(...installArgs, repoRoot);

let child;
let log = "";
const start = () => {
  child = spawn(hostCli, ["gateway", "run", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { log = (log + chunk.toString()).slice(-20000); });
  child.stderr.on("data", (chunk) => { log = (log + chunk.toString()).slice(-20000); });
};
const stop = async () => {
  if (!child) return;
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), pause(5000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
};

try {
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
  let models;
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Gateway exited:\n${log}`);
    try {
      models = await list();
      if (models.length > 0) break;
    } catch {
      // The Gateway may still be starting.
    }
    await pause(1000);
  }
  assert.ok(models?.length, `No Magpie models were published.\n${log}`);
  console.log(JSON.stringify({
    ok: true,
    isolatedStateDir: keep ? stateDir : "(removed)",
    models: models.length,
    sample: models.slice(0, 8).map((model) => ({
      id: model.id,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      input: model.input,
      api: model.api,
    })),
  }, null, 2));
} finally {
  await stop();
  if (!keep) await rm(stateDir, { recursive: true, force: true });
}
