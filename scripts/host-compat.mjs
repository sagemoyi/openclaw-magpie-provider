/**
 * OpenClaw host compatibility metadata.
 *
 * package.json declares the supported host once, as a range with a lower bound:
 *
 *   peerDependencies.openclaw → the supported host range
 *   openclaw.compat.pluginApi → the same range (the host's install/load gate)
 *   openclaw.compat.minGatewayVersion → the inclusive lower bound of that range
 *   openclaw.build.* → the concrete host version this release was validated on
 *
 * The host resolves `compat.pluginApi` with `satisfiesSemverRange`, so a range
 * such as `>=2026.10.0 <2027` loads on every 2026.10.x host without a release
 * per host bump. This module is the single place those rules are checked.
 */

const CONCRETE = /^\d{4}\.\d+\.\d+$/;
const UPPER = /^\d{4}(?:\.\d+){0,2}$/;
const BUILD_FIELDS = ["openclawVersion", "pluginSdkVersion"];

/** Accepts `>=X.Y.Z`, optionally followed by `<year|X.Y|X.Y.Z`. */
export function parseHostRange(range) {
  if (typeof range !== "string") return { ok: false, error: "host range must be a string" };
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ok: false, error: "host range must not be empty" };
  let minimum;
  let maximumExclusive;
  for (const token of tokens) {
    const lower = /^>=(\S+)$/.exec(token);
    const upper = /^<(\S+)$/.exec(token);
    if (lower && minimum === undefined && maximumExclusive === undefined) {
      if (!CONCRETE.test(lower[1])) return { ok: false, error: `lower bound must be a full version: ${token}` };
      minimum = lower[1];
      continue;
    }
    if (upper && minimum !== undefined && maximumExclusive === undefined) {
      if (!UPPER.test(upper[1])) return { ok: false, error: `upper bound must be a year or a version: ${token}` };
      maximumExclusive = upper[1].split(".");
      while (maximumExclusive.length < 3) maximumExclusive.push("0");
      maximumExclusive = maximumExclusive.join(".");
      continue;
    }
    return { ok: false, error: `unsupported host range token: ${token}` };
  }
  if (minimum === undefined) return { ok: false, error: "host range must declare a lower bound (>=X.Y.Z)" };
  return { ok: true, minimum, ...(maximumExclusive === undefined ? {} : { maximumExclusive }) };
}

const tuple = (version) => version.split(".").map(Number);

export function compareVersions(a, b) {
  const [left, right] = [tuple(a), tuple(b)];
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function satisfiesHostRange(version, range) {
  if (!CONCRETE.test(version ?? "")) return false;
  const parsed = parseHostRange(range);
  if (!parsed.ok) return false;
  if (compareVersions(version, parsed.minimum) < 0) return false;
  return parsed.maximumExclusive === undefined || compareVersions(version, parsed.maximumExclusive) < 0;
}

/** Structural checks on package.json; empty means the metadata is consistent. */
export function hostCompatibilityViolations(pkg) {
  const violations = [];
  const peer = pkg?.peerDependencies?.openclaw;
  const parsed = parseHostRange(peer);
  if (!parsed.ok) violations.push(`peerDependencies.openclaw: ${parsed.error}`);
  const pluginApi = pkg?.openclaw?.compat?.pluginApi;
  if (pluginApi !== peer) {
    violations.push(`openclaw.compat.pluginApi must equal peerDependencies.openclaw (${peer})`);
  }
  const minimum = pkg?.openclaw?.compat?.minGatewayVersion;
  if (parsed.ok && minimum !== parsed.minimum) {
    violations.push(`openclaw.compat.minGatewayVersion must be the lower bound of the host range (${parsed.minimum})`);
  }
  for (const field of BUILD_FIELDS) {
    const value = pkg?.openclaw?.build?.[field];
    if (!CONCRETE.test(value ?? "")) {
      violations.push(`openclaw.build.${field} must be a concrete validated host version, got ${value}`);
    } else if (parsed.ok && !satisfiesHostRange(value, peer)) {
      violations.push(`openclaw.build.${field} (${value}) must satisfy the host range (${peer})`);
    }
  }
  return violations;
}

/** Reports the installed host when it falls outside the supported range. */
export function hostVersionViolation(pkg, hostVersion) {
  const peer = pkg?.peerDependencies?.openclaw;
  if (satisfiesHostRange(hostVersion, peer)) return undefined;
  return `Installed OpenClaw ${hostVersion} does not satisfy the supported host range ${peer}`;
}
