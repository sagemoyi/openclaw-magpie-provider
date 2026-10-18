import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the manifest opts into Gateway startup so the background catalog service runs", () => {
  // Without activation.onStartup, OpenClaw may load a provider plugin lazily
  // when models.providers.<id>.api names a core API. Lazy loads do not start
  // plugin services, which would silently disable auto-refresh.
  assert.equal(manifest.activation?.onStartup, true);
  assert.ok(manifest.activation.onProviders.includes("magpie"));
});

test("package and manifest agree on the provider id and target host", () => {
  assert.equal(manifest.id, "magpie");
  assert.deepEqual(manifest.providers, ["magpie"]);
  assert.deepEqual(pkg.openclaw.providers, ["magpie"]);
  assert.equal(pkg.peerDependencies.openclaw, "2026.10.3");
  assert.equal(pkg.openclaw.compat.pluginApi, "2026.10.3");
  assert.equal(pkg.openclaw.build.openclawVersion, "2026.10.3");
});
