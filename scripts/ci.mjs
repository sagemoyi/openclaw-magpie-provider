import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { hostCompatibilityViolations, hostVersionViolation, parseHostRange } from "./host-compat.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const pkg = readJson("../package.json");
const violations = hostCompatibilityViolations(pkg);
if (violations.length) throw new Error(violations.join("\n"));
const { minimum } = parseHostRange(pkg.peerDependencies.openclaw);
const range = pkg.peerDependencies.openclaw;
let host;
try {
  host = readJson("../node_modules/openclaw/package.json");
} catch {
  throw new Error(`Install the test host first: npm install --no-save --package-lock=false openclaw@${minimum}`);
}
const hostViolation = hostVersionViolation(pkg, host.version);
if (hostViolation) {
  throw new Error(`${hostViolation}; install a supported host with npm install --no-save --package-lock=false openclaw@${minimum}`);
}
console.log(`host range ${range}; tested on OpenClaw ${host.version}`);

// The integration suites create temporary state/config and their own Gateway;
// this entry point never starts or changes a persistent dev/prod service.
for (const [command, args] of [
  ["git", ["diff", "--check"]],
  ["npm", ["run", "check"]],
  ["npm", ["test"]],
  ["npm", ["run", "test:host"]],
  ["npm", ["run", "test:gateway"]],
]) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
