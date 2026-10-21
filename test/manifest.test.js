import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIN_OPENCLAW_VERSION } from "../src/sync.js";
import {
  hostCompatibilityViolations,
  parseHostRange,
  satisfiesHostRange,
} from "../scripts/host-compat.mjs";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the manifest opts into Gateway startup so the background catalog service runs", () => {
  // Without activation.onStartup, OpenClaw may load a provider plugin lazily
  // when models.providers.<id>.api names a core API. Lazy loads do not start
  // plugin services, which would silently disable auto-refresh.
  assert.equal(manifest.activation?.onStartup, true);
  assert.ok(manifest.activation.onProviders.includes("magpie"));
});

test("package and manifest agree on the provider id", () => {
  assert.equal(manifest.id, "magpie");
  assert.deepEqual(manifest.providers, ["magpie"]);
  assert.deepEqual(pkg.openclaw.providers, ["magpie"]);
});

test("host compatibility is one bounded range with a single lower bound", () => {
  // The host loads a plugin when its version satisfies compat.pluginApi, so a
  // range keeps one release working across patch bumps of a host line.
  assert.deepEqual(hostCompatibilityViolations(pkg), []);
  const range = parseHostRange(pkg.peerDependencies.openclaw);
  assert.equal(range.ok, true, range.error);
  assert.ok(range.maximumExclusive, "the supported window needs an upper bound");
  assert.equal(pkg.openclaw.compat.minGatewayVersion, range.minimum);
  assert.equal(MIN_OPENCLAW_VERSION, range.minimum);
  assert.equal(satisfiesHostRange(range.minimum, pkg.peerDependencies.openclaw), true);
  assert.equal(satisfiesHostRange(range.maximumExclusive, pkg.peerDependencies.openclaw), false);
});
