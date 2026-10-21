import { CatalogClient, EFFORTS, PROVIDER, THINKING_LEVELS, normalizeBaseUrl } from "./catalog.js";

const toLevel = (effort) => THINKING_LEVELS[effort] ?? effort;
const toEffort = (level) => {
  if (typeof level !== "string") return undefined;
  const normalized = level.trim().toLowerCase();
  if (normalized === "off") return "none";
  if (normalized === "adaptive") return "auto";
  return normalized;
};

/** OpenClaw thinking profile for one resolved Magpie model. */
export function thinkingProfile(model) {
  if (model?.reasoning === false) return { levels: [{ id: "off" }], defaultLevel: "off" };
  const supported = model?.compat?.supportedReasoningEfforts ?? [];
  const levels = [];
  for (const effort of supported) {
    const id = toLevel(effort);
    if (!levels.some((level) => level.id === id)) {
      levels.push(id === "adaptive" ? { id, label: "provider default" } : { id });
    }
  }
  if (!levels.length) {
    // A model that thinks but exposes no discrete controls still accepts a
    // request with no effort field. "adaptive" honestly represents that.
    return { levels: [{ id: "adaptive", label: "provider default" }], defaultLevel: "adaptive" };
  }
  const preferred = toLevel(model?.params?.magpie?.defaultEffort);
  return {
    levels,
    defaultLevel: levels.some((level) => level.id === preferred) ? preferred : levels[0].id,
  };
}

/** Choose the Magpie effort for the selected OpenClaw thinking level. */
export function selectEffort(model, requested, exact) {
  const supported = model?.compat?.supportedReasoningEfforts ?? [];
  if (!model?.reasoning || model?.compat?.supportsReasoningEffort === false) {
    if (exact !== undefined) throw new Error("magpieReasoningEffort conflicts with disabled reasoning controls");
    return undefined;
  }
  if (exact !== undefined) {
    if (typeof exact !== "string" || !exact.trim()) throw new Error("magpieReasoningEffort must be a non-empty string");
    const normalized = exact.trim().toLowerCase();
    if (supported.includes(normalized)) return normalized;
    // Magpie accepts ultra as a wire override and normalizes it to max.
    if (normalized === "ultra" && model?.params?.magpie?.nativeReasoningEfforts?.includes("ultra")) return "ultra";
    throw new Error("magpieReasoningEffort is not advertised by the selected Magpie model");
  }

  const wanted = requested === "ultra" ? "max" : toEffort(requested);
  if (wanted === undefined) {
    const fallback = model?.params?.magpie?.defaultEffort;
    return supported.includes(fallback) ? fallback : supported.find((effort) => effort !== "none");
  }
  if (supported.includes(wanted)) return wanted;
  if (wanted === "none") return supported.includes("none") ? "none" : undefined;
  if (wanted === "auto") return supported.includes("auto") ? "auto" : undefined;

  const rank = EFFORTS.indexOf(wanted);
  if (rank >= 0) {
    const usable = supported.filter((effort) => EFFORTS.includes(effort) && effort !== "none");
    // Match Magpie's own nearest-effort behavior: nearest rank, ties go up.
    const nearest = usable
      .map((effort) => ({ effort, distance: Math.abs(EFFORTS.indexOf(effort) - rank) }))
      .sort((a, b) => a.distance - b.distance || EFFORTS.indexOf(b.effort) - EFFORTS.indexOf(a.effort))[0];
    if (nearest) return nearest.effort;
  }

  const fallback = model?.params?.magpie?.defaultEffort;
  return supported.includes(fallback) ? fallback : supported.find((effort) => effort !== "none");
}

/** Patch the final request payload without replacing other host-owned fields. */
export function patchPayload(payload, api, effort) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Magpie transport produced an invalid payload");
  }
  if (api === "openai-responses") {
    if (effort === undefined) {
      if (payload.reasoning && typeof payload.reasoning === "object") {
        delete payload.reasoning.effort;
        if (!Object.keys(payload.reasoning).length) delete payload.reasoning;
      } else {
        delete payload.reasoning;
      }
    } else {
      payload.reasoning = { ...(payload.reasoning ?? {}), effort };
    }
  } else if (api === "openai-completions") {
    if (effort === undefined) delete payload.reasoning_effort;
    else payload.reasoning_effort = effort;
  }
  // Anthropic Messages uses a thinking budget, not an effort label. Leave
  // that payload to the host unless a future Magpie model needs an adapter.
  return payload;
}

/** Merge explicit provider/model configuration over live metadata. */
export function mergeExplicit(model, config) {
  const provider = config?.models?.providers?.[PROVIDER];
  const explicit = provider?.models?.find((entry) => entry?.id === model.id);
  const explicitMagpie = explicit?.params?.magpie;
  const merged = {
    ...model,
    ...explicit,
    api: explicit?.api ?? model.api,
    compat: { ...model.compat, ...explicit?.compat },
    params: {
      ...model.params,
      ...explicit?.params,
      ...(explicitMagpie ? { magpie: { ...model.params?.magpie, ...explicitMagpie } } : {}),
    },
    cost: { ...model.cost, ...explicit?.cost },
  };
  if (merged.reasoning === false) {
    merged.compat.supportsReasoningEffort = false;
    merged.compat.supportedReasoningEfforts = [];
  }
  return merged;
}

export function createMagpieProvider({
  fetchRows,
  resolveAuth,
  config = {},
  logger = { warn() {} },
  now,
  replayHooks = {},
  isApiKeyMarker,
}) {
  const settings = config.plugins?.entries?.[PROVIDER]?.config ?? {};
  const client = new CatalogClient({
    fetchRows,
    now,
    ttlMs: (settings.refreshSeconds ?? 60) * 1000,
    staleMs: (settings.staleSeconds ?? 300) * 1000,
    timeoutMs: settings.timeoutMs ?? 10000,
    includePrices: settings.includePrices ?? true,
    sendUserAgent: settings.sendUserAgent ?? true,
    warn: (message) => logger.warn(message),
  });
  const bindings = new Map();
  const scope = (ctx, baseUrl) => JSON.stringify([
    ctx.agentDir ?? "",
    ctx.workspaceDir ?? "",
    ctx.authProfileId ?? "",
    baseUrl,
  ]);

  const endpoint = (ctx) => normalizeBaseUrl(
    (ctx.config ?? config)?.models?.providers?.[PROVIDER]?.baseUrl,
  );

  function remember(ctx, baseUrl, apiKey) {
    const key = scope(ctx, baseUrl);
    if (bindings.size >= 16 && !bindings.has(key)) bindings.delete(bindings.keys().next().value);
    bindings.set(key, client.key(baseUrl, apiKey));
  }

  async function discover(ctx = {}, { force = false, apiKey } = {}) {
    ctx.signal?.throwIfAborted();
    if (ctx.providerIds && !ctx.providerIds.includes(PROVIDER)) return null;
    const cfg = ctx.config ?? config;
    if (!cfg?.models?.providers?.[PROVIDER]?.baseUrl) return null;
    const baseUrl = endpoint(ctx);
    let persistedKey;

    if (!apiKey) {
      const resolver = ctx.resolveProviderAuth ?? ctx.resolveProviderApiKey;
      if (resolver) {
        const auth = resolver(PROVIDER);
        if (auth?.preparationFailed) {
          bindings.delete(scope(ctx, baseUrl));
          throw new Error("Magpie credential preparation failed; check OpenClaw provider authentication");
        }
        persistedKey = auth?.apiKey;
        apiKey = auth?.discoveryApiKey;
        if (!apiKey && auth?.apiKey) {
          if (!isApiKeyMarker || isApiKeyMarker(auth.apiKey)) {
            bindings.delete(scope(ctx, baseUrl));
            throw new Error("Magpie discovery requires resolved credentials, not an auth marker");
          }
          apiKey = auth.apiKey;
        }
      } else if (typeof resolveAuth === "function") {
        apiKey = (await resolveAuth({
          provider: PROVIDER,
          cfg,
          agentDir: ctx.agentDir,
          workspaceDir: ctx.workspaceDir,
          profileId: ctx.authProfileId,
          signal: ctx.signal,
        }))?.apiKey;
        persistedKey = apiKey;
      }
    }

    ctx.signal?.throwIfAborted();
    if (!apiKey) {
      bindings.delete(scope(ctx, baseUrl));
      return null;
    }
    if (isApiKeyMarker?.(apiKey)) {
      bindings.delete(scope(ctx, baseUrl));
      throw new Error("Magpie discovery requires resolved credentials, not an auth marker");
    }

    remember(ctx, baseUrl, apiKey);
    const value = await client.get({ baseUrl, apiKey, force, signal: ctx.signal });
    return { ...value, persistedKey: persistedKey ?? apiKey };
  }

  function current(ctx) {
    let baseUrl;
    try {
      baseUrl = endpoint(ctx);
    } catch {
      return undefined;
    }
    const binding = bindings.get(scope(ctx, baseUrl));
    return binding ? client.peekByKey(binding) : undefined;
  }

  function runtimeModel(model, ctx, baseUrl) {
    return { ...mergeExplicit(model, ctx.config ?? config), provider: PROVIDER, baseUrl };
  }

  function wrap(ctx) {
    if (!ctx.streamFn) return undefined;
    return async (model, messages, options = {}) => {
      const snapshot = await discover({ ...ctx, signal: options.signal }, { apiKey: options.apiKey });
      if (!snapshot) throw new Error("Magpie is not configured; set models.providers.magpie.baseUrl and credentials");
      const row = snapshot.models.find((entry) => entry.id === model.id);
      if (!row) throw new Error(`Model is no longer advertised by Magpie: ${model.id}`);
      const resolved = runtimeModel(row, ctx, snapshot.baseUrl);
      const exact = ctx.extraParams?.magpieReasoningEffort ?? resolved.params?.magpieReasoningEffort;
      const effort = selectEffort(resolved, ctx.thinkingLevel ?? options.reasoning, exact);
      return ctx.streamFn({ ...model, ...resolved }, messages, {
        ...options,
        onPayload: async (payload, wireModel) => {
          const previous = await options.onPayload?.(payload, wireModel);
          return patchPayload(previous ?? payload, resolved.api, effort);
        },
      });
    };
  }

  const provider = {
    id: PROVIDER,
    label: "Magpie",
    envVars: ["MAGPIE_API_KEY"],
    auth: [],
    ...replayHooks,
    catalog: {
      order: "simple",
      async run(ctx) {
        const snapshot = await discover(ctx);
        if (!snapshot) return null;
        return {
          provider: {
            baseUrl: snapshot.baseUrl,
            apiKey: snapshot.persistedKey,
            api: "openai-completions",
            models: snapshot.models,
          },
        };
      },
    },
    staticCatalog: {
      order: "simple",
      async run() {
        return null;
      },
    },
    async prepareDynamicModel(ctx) {
      const snapshot = await discover(ctx);
      const row = snapshot?.models.find((entry) => entry.id === ctx.modelId);
      return row ? runtimeModel(row, ctx, snapshot.baseUrl) : undefined;
    },
    resolveDynamicModel(ctx) {
      const snapshot = current(ctx);
      const row = snapshot?.models.find((entry) => entry.id === ctx.modelId);
      return row ? runtimeModel(row, ctx, snapshot.baseUrl) : undefined;
    },
    normalizeResolvedModel(ctx) {
      const snapshot = current(ctx);
      const row = snapshot?.models.find((entry) => entry.id === ctx.modelId);
      return row ? { ...ctx.model, ...runtimeModel(row, ctx, snapshot.baseUrl) } : undefined;
    },
    resolveThinkingProfile(ctx) {
      // This hook has no agent/endpoint/auth scope. Only host-supplied facts
      // are safe here; do not read the process-wide cache for a selected model.
      if (ctx.reasoning === false || Array.isArray(ctx.compat?.supportedReasoningEfforts)) {
        return thinkingProfile(ctx);
      }
      return undefined;
    },
    wrapStreamFn: wrap,
    wrapSimpleCompletionStreamFn: wrap,
    buildUnknownModelHint() {
      return " Run `openclaw magpie catalog`; Magpie availability can change with account health and quotas.";
    },
  };

  return { provider, client, discover, current };
}
