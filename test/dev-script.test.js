import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/dev.sh", import.meta.url));
const repo = path.dirname(path.dirname(script));
const forbiddenEnv = [
  "OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR", "OPENCLAW_OAUTH_DIR",
  "OPENCLAW_INCLUDE_ROOTS", "OPENCLAW_CONFIG_READONLY", "OPENCLAW_NIX_MODE",
  "OPENCLAW_PACKAGE_DIR", "OPENCLAW_CONTAINER", "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND", "OPENCLAW_GATEWAY_SERVICE_PID", "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_SYSTEMD_UNIT", "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_WINDOWS_TASK_NAME", "OPENCLAW_UNKNOWN_FUTURE_SELECTOR",
  "CLAWDBOT_STATE_DIR", "MOLTBOT_CONFIG_PATH", "USERPROFILE", "HOMEDRIVE",
  "HOMEPATH", "PREFIX", "ANDROID_DATA", "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SYSTEM_BUS_ADDRESS", "SYSTEMD_UNIT_PATH", "SUDO_USER", "NODE_OPTIONS",
];

// All three executable names use this mock. Even setup's Node editor is recorded
// before executing its stdin in an isolated process; no real CLI/systemctl runs.
const mockSource = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const kind = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MAGPIE_TEST_RECORDS, JSON.stringify({
  kind, args, env: process.env,
}) + "\\n");
if (kind === "openclaw") {
  const command = args.slice(2);
  if (command.join(" ") === "plugins install --help") {
    console.log("--accept-capabilities");
  }
  if (command[0] === "setup") {
    fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true });
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
      gateway: { mode: "remote", bind: "lan", port: 18789,
        remote: { url: "ws://127.0.0.1:18789" } },
    }));
  }
  if (command.join(" ") === "plugins list") console.log("magpie");
} else if (kind === "node") {
  if (args.length !== 1 || args[0] !== "-") process.exit(97);
  const vm = require("node:vm");
  vm.runInThisContext("(function(require) {" + fs.readFileSync(0, "utf8") + "\\n})")(require);
} else if (kind !== "systemctl") {
  process.exit(98);
}
`;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "magpie-dev-script-"));
  const home = path.join(root, "home with spaces");
  const bin = path.join(root, "bin");
  const records = path.join(root, "calls.jsonl");
  const production = path.join(root, "production-not-to-be-created");
  mkdirSync(home);
  mkdirSync(bin);
  for (const name of ["openclaw", "node", "systemctl"]) {
    writeFileSync(path.join(bin, name), mockSource, { mode: 0o755 });
  }
  t.after(() => {
    assert.equal(existsSync(production), false, "no production fixture path is created");
    assert.equal(existsSync(path.join(home, ".openclaw")), false, "no default state is created");
    // root is the exact absolute directory returned by mkdtempSync above.
    assert.equal(path.dirname(root), realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("magpie-dev-script-"));
    rmSync(root, { recursive: true, force: true });
  });
  const env = {
    HOME: home,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    MAGPIE_TEST_RECORDS: records,
    NODE_PATH: path.join(root, "node-modules"),
    NODE_NO_WARNINGS: "1",
    HTTPS_PROXY: "http://127.0.0.1:9",
    OPENCLAW_HOME: production,
    OPENCLAW_PROFILE: "production",
    OPENCLAW_STATE_DIR: production,
    OPENCLAW_CONFIG_PATH: path.join(production, "openclaw.json"),
    OPENCLAW_WORKSPACE_DIR: path.join(production, "workspace"),
    OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
    XDG_CONFIG_HOME: production,
    XDG_CACHE_HOME: production,
    XDG_DATA_HOME: production,
    XDG_STATE_HOME: production,
    XDG_RUNTIME_DIR: production,
  };
  for (const key of forbiddenEnv) env[key] = key === "NODE_OPTIONS" ? "--no-warnings" : production;
  return {
    root, home, env,
    run(args, extraEnv = {}) {
      return spawnSync("/bin/bash", [script, ...args], {
        cwd: repo, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15000,
      });
    },
    calls() {
      return existsSync(records)
        ? readFileSync(records, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
        : [];
    },
  };
}

function assertIsolated(call, f) {
  const home = realpathSync(f.home);
  const state = path.join(home, ".openclaw-dev");
  assert.equal(call.env.HOME, home);
  assert.equal(call.env.OPENCLAW_HOME, home);
  assert.equal(call.env.OPENCLAW_PROFILE, "dev");
  assert.equal(call.env.OPENCLAW_STATE_DIR, state);
  assert.equal(call.env.OPENCLAW_CONFIG_PATH, path.join(state, "openclaw.json"));
  assert.equal(call.env.OPENCLAW_WORKSPACE_DIR, path.join(state, "workspace"));
  assert.equal(call.env.OPENCLAW_GATEWAY_PORT, "19001");
  assert.equal(call.env.OPENCLAW_GATEWAY_URL, "ws://127.0.0.1:19001");
  assert.equal(call.env.XDG_CONFIG_HOME, path.join(home, ".config"));
  assert.equal(call.env.XDG_CACHE_HOME, path.join(home, ".cache"));
  assert.equal(call.env.XDG_DATA_HOME, path.join(home, ".local/share"));
  assert.equal(call.env.XDG_STATE_HOME, path.join(home, ".local/state"));
  assert.equal(call.env.XDG_RUNTIME_DIR, `/run/user/${process.getuid()}`);
  for (const key of forbiddenEnv) assert.equal(call.env[key], undefined, key);
  assert.equal(call.env.PATH, f.env.PATH, "keep executable discovery and Node runtime PATH");
  assert.equal(call.env.NODE_PATH, f.env.NODE_PATH);
  assert.equal(call.env.NODE_NO_WARNINGS, "1");
  assert.equal(call.env.HTTPS_PROXY, f.env.HTTPS_PROXY);
  if (call.kind === "openclaw") assert.deepEqual(call.args.slice(0, 2), ["--profile", "dev"]);
}

function success(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("install isolates the consent help probe and linked installation", (t) => {
  const f = fixture(t);
  success(f.run(["install"]));
  const calls = f.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["--profile", "dev", "plugins", "install", "--help"]);
  assert.deepEqual(calls[1].args, [
    "--profile", "dev", "plugins", "install", "--link", "--force", "--accept-capabilities", repo,
  ]);
  for (const call of calls) assertIsolated(call, f);
});

test("uninstall and RPC preserve ordinary options but never inherited selectors", (t) => {
  const f = fixture(t);
  success(f.run(["uninstall", "--force"]));
  success(f.run(["call", "models.list", "--json", "--params", '{"all":true}']));
  success(f.run(["call", "--", "health"]));
  const calls = f.calls();
  assert.deepEqual(calls.map((call) => call.args.slice(2)), [
    ["plugins", "uninstall", "magpie", "--force"],
    ["gateway", "call", "--port", "19001", "models.list", "--json", "--params", '{"all":true}'],
    ["gateway", "call", "--port", "19001", "--", "health"],
  ]);
  for (const call of calls) assertIsolated(call, f);
});

test("all Gateway and diagnostic entrypoints use the same controlled environment", (t) => {
  const f = fixture(t);
  for (const command of ["reload", "restart", "start", "status", "logs", "inspect", "run", "stop"]) {
    success(f.run([command]));
  }
  const calls = f.calls();
  assert.equal(calls.length, 9); // status invokes Gateway status and plugin list.
  for (const call of calls) {
    assertIsolated(call, f);
    const command = call.args.slice(2, 4).join(" ");
    if (command === "gateway status") {
      assert.deepEqual(call.args.slice(4, 6), ["--port", "19001"], "force local port and keep config auth");
    }
    if (call.args[2] === "logs") assert.deepEqual(call.args.slice(3, 5), ["--port", "19001"]);
  }
  assert.deepEqual(calls.at(-1).args, ["--user", "stop", "openclaw-gateway-dev.service"]);
  assert.equal(calls.at(-1).kind, "systemctl");
});

test("setup's CLI, Node editor and service manager agree on the canonical temporary HOME", (t) => {
  const f = fixture(t);
  const alias = path.join(f.root, "home-alias");
  symlinkSync(f.home, alias, "dir");
  success(f.run(["setup"], { HOME: `${alias}/.` }));
  const calls = f.calls();
  assert.deepEqual(calls.map((call) => call.kind), ["openclaw", "node", "openclaw", "systemctl"]);
  for (const call of calls) assertIsolated(call, f);
  assert.deepEqual(calls[0].args.slice(2), ["setup", "--baseline"]);
  assert.deepEqual(calls[2].args.slice(2), ["gateway", "install", "--force"]);
  assert.deepEqual(calls[3].args, ["--user", "disable", "openclaw-gateway-dev.service"]);
  const config = path.join(f.home, ".openclaw-dev/openclaw.json");
  const gateway = JSON.parse(readFileSync(config, "utf8")).gateway;
  assert.equal(gateway.mode, "local");
  assert.equal(gateway.bind, "loopback");
  assert.equal(gateway.port, 19001);
  assert.equal(gateway.remote, undefined);
  assert.equal(gateway.auth.mode, "token");
  assert.match(gateway.auth.token, /^[a-f0-9]{48}$/);
  assert.equal(lstatSync(config).mode & 0o777, 0o600);
});

test("selector overrides are rejected before any CLI, consent probe or service call", (t) => {
  const f = fixture(t);
  const flags = [
    "--url", "--port", "--profile", "--dev", "--no-dev", "--gateway-url",
    "--gateway-port", "--host", "--bind", "--remote", "--container", "--home",
    "--root", "--state-dir", "--config", "--config-path", "--workspace",
    "--workspace-dir", "--agent", "--agent-dir", "--service", "--systemd-unit",
    "--launchd-label", "--windows-task-name", "--env", "--env-file", "-p",
  ];
  for (const flag of flags) {
    for (const args of [["call", "models.list", flag, "forbidden"], ["install", `${flag}=forbidden`]]) {
      const result = f.run(args);
      assert.ifError(result.error);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /不允许覆盖开发实例/);
    }
  }
  for (const args of [["stop", "--url=forbidden"], ["setup", "--profile", "dev"], ["call", "models.list", "--", "--port=19001"], ["call", "models.list", "-p18789"]]) {
    assert.equal(f.run(args).status, 2);
  }
  assert.deepEqual(f.calls(), [], "no side effects even when the command ignores extra arguments");
});

test("missing, relative or root HOME fails closed without consulting fallback homes", (t) => {
  const f = fixture(t);
  for (const home of ["", "relative", "/", "undefined", "null", path.join(f.root, "missing-home")]) {
    const result = f.run(["install"], { HOME: home, USERPROFILE: f.home, OPENCLAW_HOME: f.home });
    assert.equal(result.status, 2, `${home}: ${result.stderr}`);
  }
  assert.deepEqual(f.calls(), []);
});

test("dev state/config symlinks cannot redirect the fixed development paths", (t) => {
  const f = fixture(t);
  const state = path.join(f.home, ".openclaw-dev");
  const other = path.join(f.root, "other-state");
  mkdirSync(other);
  symlinkSync(other, state, "dir");
  assert.equal(f.run(["install"]).status, 2);
  // Only unlink the exact temporary symlink created immediately above.
  assert.equal(lstatSync(state).isSymbolicLink(), true);
  rmSync(state);
  mkdirSync(state);
  symlinkSync(path.join(other, "openclaw.json"), path.join(state, "openclaw.json"));
  assert.equal(f.run(["setup"]).status, 2);
  assert.deepEqual(f.calls(), []);
});
