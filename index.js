import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createMagpieProvider, mergeExplicit } from "./src/provider.js";
import { PROVIDER, normalizeBaseUrl } from "./src/catalog.js";
import { buildAuthModelAccessPatch } from "./src/auth.js";
import { materializeCatalog } from "./src/sync.js";
import { createCatalogSynchronizer, createCatalogService } from "./src/lifecycle.js";

export default definePluginEntry({
  id: PROVIDER,
  name: "OpenClaw Magpie Provider",
  description: "Discover Magpie models, capabilities, and prices without hand-maintained model lists",
  register(api) {
    const magpie = createMagpieProvider({
      config: api.config,
      logger: api.logger ?? { warn() {} },
      fetchRows: fetchLiveProviderModelRows,
      resolveAuth: resolveApiKeyForProvider,
      isApiKeyMarker: isNonSecretApiKeyMarker,
      replayHooks: buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    });

    magpie.provider.auth = [{
      id: "api-key",
      label: "Magpie endpoint and API key",
      kind: "api_key",
      async run(ctx) {
        const baseUrl = normalizeBaseUrl(await ctx.prompter.text({
          message: "Magpie endpoint",
          initialValue: ctx.config.models?.providers?.[PROVIDER]?.baseUrl ?? "http://127.0.0.1:3425/v1",
          validate(value) {
            try {
              normalizeBaseUrl(value);
            } catch (error) {
              return error.message;
            }
            return undefined;
          },
        }));
        const key = (await ctx.prompter.text({
          message: "Magpie API key",
          sensitive: true,
          validate: (value) => value.trim() ? undefined : "API key is required",
        })).trim();
        const providerConfig = {
          ...ctx.config.models?.providers?.[PROVIDER],
          baseUrl,
          models: ctx.config.models?.providers?.[PROVIDER]?.models ?? [],
        };
        const config = {
          ...ctx.config,
          models: {
            ...ctx.config.models,
            providers: {
              ...ctx.config.models?.providers,
              [PROVIDER]: providerConfig,
            },
          },
        };
        const catalog = await magpie.discover({ ...ctx, config }, { apiKey: key, force: true });
        if (!catalog) throw new Error("Magpie did not return a model catalog");
        return {
          profiles: [{
            profileId: `${PROVIDER}:default`,
            credential: { type: "api_key", provider: PROVIDER, key },
          }],
          configPatch: {
            models: { providers: { [PROVIDER]: { baseUrl, models: providerConfig.models } } },
            agents: buildAuthModelAccessPatch(ctx.config),
          },
          notes: [
            `Discovered ${catalog.models.length} text models. Select one with openclaw models set magpie/<model-id>.`,
          ],
        };
      },
    }];

    api.registerProvider(magpie.provider);

    api.registerModelCatalogProvider({
      provider: PROVIDER,
      kinds: ["text"],
      staticCatalog: () => [],
      async liveCatalog(ctx) {
        const snapshot = await magpie.discover(ctx);
        return snapshot?.models.map((row) => {
          const model = mergeExplicit(row, ctx.config);
          return { kind: "text", provider: PROVIDER, model: model.id, label: model.name, source: "live" };
        }) ?? [];
      },
    });

    const sync = createCatalogSynchronizer({
      discover: magpie.discover,
      config: api.config,
      publish: async (config, snapshot, ctx) => materializeCatalog(
        config,
        snapshot,
        await import("openclaw/plugin-sdk/agent-runtime"),
        ctx,
      ),
    });
    api.registerService(createCatalogService({
      sync,
      intervalMs: magpie.client.ttlMs,
      runInBackgroundContext: api.lifecycle?.runInBackgroundContext,
    }));

    api.registerCli(({ program, config }) => {
      const command = program.command("magpie").description("Magpie model discovery diagnostics");
      command.command("catalog")
        .description("Fetch the live catalog, including metadata sources and limitations")
        .action(async () => {
          const result = await magpie.discover({ config }, { force: true });
          if (!result) throw new Error("Configure models.providers.magpie.baseUrl and Magpie credentials first");
          // Only publish diagnostic fields, excluding endpoint and auth state.
          const { models, fetchedAt, stale, revision, priced, warnings } = result;
          console.log(JSON.stringify({ models, fetchedAt, stale, revision, priced, warnings }, null, 2));
        });
      command.command("sync")
        .description("Refresh OpenClaw model catalog state without editing configuration")
        .action(async () => console.log(JSON.stringify(await sync({ config }, true), null, 2)));
    }, { commands: ["magpie"] });
  },
});
