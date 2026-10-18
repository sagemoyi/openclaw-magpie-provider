import { createHash } from "node:crypto";

export const PROVIDER = "magpie";

/** Effort names that OpenClaw can expose as first-class thinking levels. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** OpenClaw thinking level -> Magpie effort. */
export const THINKING_LEVELS = {
  none: "off",
  auto: "adaptive",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FALLBACK_CONTEXT = 128000;
const FALLBACK_MAX_TOKENS = 65535;
const CONTROL = /[\x00-\x1f\x7f]/;
const RATE_KEYS = [
  ["input", "input"],
  ["output", "output"],
  ["cache_read", "cacheRead"],
  ["cache_write", "cacheWrite"],
];

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const finiteNonNegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const stringOf = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;

export function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Set models.providers.magpie.baseUrl to your Magpie endpoint");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Magpie endpoint must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Magpie endpoint must be HTTP(S), without embedded credentials, query or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return url.toString().replace(/\/+$/, "");
}

export function readCatalogRows(body) {
  if (Array.isArray(body)) return body;
  if (!record(body)) throw new Error("Magpie catalog must be a JSON object or array");
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.models)) return body.models;
  throw new Error("Magpie catalog must contain data[] or models[]");
}

function readEfforts(row) {
  const supported = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : [];
  const flat = Array.isArray(row.reasoning_levels) ? row.reasoning_levels : [];
  const raw = supported.length ? supported : flat;
  const native = [];
  const efforts = [];
  for (const item of [...raw, ...flat]) {
    const effort = typeof item === "string" ? item : item?.effort;
    const normalized = stringOf(effort)?.toLowerCase();
    if (!normalized) continue;
    if (!native.includes(normalized)) native.push(normalized);
    // Magpie normalizes ultra to max on the wire (Codex's own orchestration
    // level). Do not expose it as a distinct OpenClaw thinking level.
    if (normalized !== "ultra" && EFFORTS.includes(normalized) && !efforts.includes(normalized)) {
      efforts.push(normalized);
    }
  }
  return { efforts, native };
}

function readInputModalities(row) {
  const declared = row.modalities?.input ?? row.input_modalities;
  if (!Array.isArray(declared)) {
    return { input: ["text"], known: false, dropped: [] };
  }
  const input = [];
  const dropped = [];
  const add = (value) => {
    if (!input.includes(value)) input.push(value);
  };
  for (const item of declared) {
    const value = stringOf(item)?.toLowerCase();
    if (!value) continue;
    if (value === "text" || value === "image") add(value);
    else if (value === "pdf" || value === "document" || value === "file") add("document");
    else dropped.push(value);
  }
  if (!input.includes("text")) input.unshift("text");
  return { input, known: true, dropped: [...new Set(dropped)] };
}

function readRate(source, fallback, key) {
  const value = finiteNonNegative(source?.[key]);
  return value ?? fallback[key] ?? 0;
}

export function readPrice(value) {
  if (!record(value)) return undefined;
  const base = Object.fromEntries(RATE_KEYS.map(([sourceKey, targetKey]) => [targetKey, readRate(value, ZERO_COST, sourceKey)]));
  const tiers = [];
  if (Array.isArray(value.tiers)) {
    const byAbove = new Map();
    for (const tier of value.tiers) {
      const above = positive(tier?.above);
      if (above && record(tier)) byAbove.set(above, tier);
    }
    const rows = [...byAbove].map(([above, tier]) => ({ above, tier })).sort((a, b) => a.above - b.above);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const next = rows[index + 1]?.above;
      const rates = Object.fromEntries(RATE_KEYS.map(([sourceKey, targetKey]) => [
        targetKey,
        readRate(row.tier, base, sourceKey),
      ]));
      tiers.push({ ...rates, range: next && next > row.above ? [row.above, next] : [row.above] });
    }
  }
  return { cost: base, tieredPricing: tiers.length ? tiers : undefined };
}

function readServiceTiers(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry.trim()].filter(Boolean).map((id) => ({ id }));
    if (!record(entry)) return [];
    const id = stringOf(entry.id);
    if (!id) return [];
    return [{
      id,
      ...(stringOf(entry.name) ? { name: stringOf(entry.name) } : {}),
      ...(stringOf(entry.description) ? { description: stringOf(entry.description) } : {}),
    }];
  });
}

function defaultEffortOf(efforts) {
  if (!efforts.length) return "none";
  if (efforts.includes("medium")) return "medium";
  const rank = (effort) => EFFORTS.indexOf(effort);
  const atLeastMedium = efforts
    .filter((effort) => effort !== "none" && rank(effort) >= rank("medium"))
    .sort((a, b) => rank(a) - rank(b));
  if (atLeastMedium.length) return atLeastMedium[0];
  const nonOff = efforts.filter((effort) => effort !== "none");
  return nonOff[0] ?? "none";
}

/**
 * Project one Magpie `/v1/models` row onto an OpenClaw catalog model.
 * Returns null for non-chat rows such as image or video generators.
 */
export function projectModel(row, { includePrices = true } = {}) {
  if (!record(row)) throw new Error("Magpie returned a non-object model row");
  if (typeof row.kind === "string" && row.kind !== "model") return null;
  if (typeof row.type === "string" && row.type !== "model") return null;
  const id = stringOf(row.id);
  if (!id || CONTROL.test(id) || /\s/.test(id)) throw new Error("Magpie returned an invalid model ID");

  const warnings = [];
  const contextWindow = positive(row.context_window)
    ?? positive(row.max_input_tokens)
    ?? positive(row.context_length)
    ?? FALLBACK_CONTEXT;
  if (!positive(row.context_window) && !positive(row.max_input_tokens) && !positive(row.context_length)) {
    warnings.push(`Context limit unknown; assuming ${FALLBACK_CONTEXT} tokens`);
  }

  const declaredOutput = positive(row.max_output_tokens);
  const maxTokens = Math.min(declaredOutput ?? FALLBACK_MAX_TOKENS, contextWindow);
  if (!declaredOutput) warnings.push(`Output limit unknown; assuming ${FALLBACK_MAX_TOKENS} tokens`);

  const modalities = readInputModalities(row);
  if (!modalities.known) warnings.push("Input modalities unknown; assuming text input");
  if (modalities.dropped.length) {
    warnings.push(`Dropped unsupported input modalities: ${modalities.dropped.join(", ")}`);
  }

  const { efforts, native } = readEfforts(row);
  const reasoning = row.reasoning === true || (row.reasoning === undefined && efforts.length > 0);
  const exposedEfforts = reasoning ? efforts : [];
  if (!reasoning && native.length) warnings.push("Magpie marks reasoning levels but reasoning is disabled; levels ignored");
  if (native.includes("ultra")) {
    warnings.push("Magpie advertises ultra, which it normalizes to max; ultra is not a separate thinking level");
  }

  const nativeEndpoints = Array.isArray(row.native_endpoints)
    ? row.native_endpoints.filter((entry) => typeof entry === "string")
    : [];
  let api = "openai-completions";
  if (nativeEndpoints.includes("/v1/responses")) api = "openai-responses";
  else if (nativeEndpoints.includes("/v1/messages")) api = "anthropic-messages";

  const price = includePrices ? readPrice(row.magpie_price) : undefined;
  if (includePrices && !price) warnings.push("Magpie did not publish pricing; cost is unknown");

  const serviceTiers = readServiceTiers(row.service_tiers);
  const defaultEffort = defaultEffortOf(exposedEfforts);
  const compat = {
    supportsReasoningEffort: exposedEfforts.length > 0,
    supportedReasoningEfforts: exposedEfforts,
    thinkingFormat: "openai",
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsUsageInStreaming: true,
    supportsStrictMode: false,
    supportsTools: true,
    maxTokensField: "max_tokens",
  };

  return {
    id,
    name: stringOf(row.display_name) ?? stringOf(row.magpie_label) ?? id,
    api,
    reasoning,
    input: modalities.input,
    contextWindow,
    maxTokens,
    cost: price?.cost ?? { ...ZERO_COST },
    ...(price?.tieredPricing ? { cost: { ...price.cost, tieredPricing: price.tieredPricing } } : {}),
    compat,
    params: {
      magpie: {
        source: "magpie-live",
        owner: stringOf(row.owned_by),
        defaultEffort,
        nativeReasoningEfforts: native,
        serviceTiers,
        priced: Boolean(price),
        warnings,
      },
    },
  };
}

export function projectCatalog(rows, options = {}) {
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    const model = projectModel(row, options);
    if (!model) continue;
    if (seen.has(model.id)) throw new Error(`Magpie returned a duplicate model ID: ${model.id}`);
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildMagpieHeaders({ apiKey, discoveryApiKey, includePrices = true } = {}) {
  const token = discoveryApiKey || apiKey;
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(includePrices ? { "X-Magpie-Prices": "1" } : {}),
  };
}

function waitForCatalog(pending, signal) {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      signal.removeEventListener("abort", cancelled);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancelled, { once: true });
    pending.then((value) => {
      signal.removeEventListener("abort", cancelled);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", cancelled);
      reject(error);
    });
  });
}

/**
 * Credential-isolated in-memory catalog cache. A successful snapshot is reused
 * for `ttlMs`; a bounded stale window covers transient failures only.
 */
export class CatalogClient {
  constructor({ fetchRows, now = Date.now, ttlMs = 60000, staleMs = 300000, timeoutMs = 10000, includePrices = true, warn = () => {} }) {
    if (typeof fetchRows !== "function") throw new Error("CatalogClient requires a fetchRows function");
    Object.assign(this, { fetchRows, now, ttlMs, staleMs, timeoutMs, includePrices, warn });
    this.entries = new Map();
  }

  key(baseUrl, apiKey) {
    return createHash("sha256").update(baseUrl).update("\0").update(apiKey ?? "").digest("hex");
  }

  peek(baseUrl, apiKey) {
    return this.peekByKey(this.key(normalizeBaseUrl(baseUrl), apiKey));
  }

  peekByKey(key) {
    const entry = this.entries.get(key);
    if (!entry?.value) return undefined;
    const age = this.now() - entry.at;
    if (age > this.ttlMs + this.staleMs) return undefined;
    return { ...entry.value, stale: age >= this.ttlMs };
  }

  async get({ baseUrl, apiKey, signal, force = false }) {
    signal?.throwIfAborted();
    baseUrl = normalizeBaseUrl(baseUrl);
    const key = this.key(baseUrl, apiKey);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 16) this.entries.delete(this.entries.keys().next().value);
      entry = { at: 0, retryAt: 0 };
      this.entries.set(key, entry);
    }
    if (entry.pending) return waitForCatalog(entry.pending, signal);
    if (!force && entry.value && this.now() - entry.at < this.ttlMs) return entry.value;
    if (!force && this.now() < entry.retryAt) {
      if (entry.value && this.now() - entry.at <= this.ttlMs + this.staleMs) {
        return { ...entry.value, stale: true };
      }
      throw entry.error;
    }

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    entry.pending = (async () => {
      try {
        const rows = await this.fetchRows({
          providerId: PROVIDER,
          endpoint: `${baseUrl}/models`,
          apiKey,
          discoveryApiKey: apiKey,
          signal: requestSignal,
          timeoutMs: this.timeoutMs,
          readRows: readCatalogRows,
          requireHttps: false,
          buildRequestHeaders: ({ apiKey: requestApiKey, discoveryApiKey }) =>
            buildMagpieHeaders({ apiKey: requestApiKey, discoveryApiKey, includePrices: this.includePrices }),
        });
        const models = projectCatalog(rows, { includePrices: this.includePrices });
        const fetchedAt = this.now();
        entry.at = fetchedAt;
        entry.retryAt = 0;
        entry.error = undefined;
        entry.value = {
          models,
          baseUrl,
          fetchedAt,
          stale: false,
          priced: models.filter((model) => model.params?.magpie?.priced).length,
          revision: createHash("sha256").update(JSON.stringify(models)).digest("hex"),
          warnings: [...new Set(models.flatMap((model) => model.params?.magpie?.warnings ?? []))],
        };
        return entry.value;
      } catch (error) {
        const status = error?.status;
        const authFailure = [401, 403].includes(status);
        if (authFailure) entry.value = undefined;
        // Error bodies and URLs can contain deployment details. Expose only a
        // bounded diagnostic and let logs carry the operator-facing detail.
        const safe = new Error(`Magpie discovery failed${status ? ` (HTTP ${status})` : " (network or invalid catalog)"}`);
        safe.status = status;
        entry.error = safe;
        entry.retryAt = this.now() + Math.min(this.ttlMs, 10000);
        if (!authFailure && entry.value && this.now() - entry.at <= this.ttlMs + this.staleMs) {
          this.warn(`${safe.message}; temporarily using the last successful catalog`);
          return { ...entry.value, stale: true };
        }
        throw safe;
      } finally {
        entry.pending = undefined;
      }
    })();
    return waitForCatalog(entry.pending, signal);
  }
}
