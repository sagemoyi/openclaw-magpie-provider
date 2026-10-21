# Architecture and compatibility

This document describes the data sources, host integration boundaries, and maintenance constraints. See the [README](../README.zh-CN.md) for setup and [Testing](TESTING.md) for validation.

## Scope

The plugin connects Magpie model availability and capabilities to OpenClaw. The host owns credential storage, inference transport, session execution, and prepared catalog publication.

Only public OpenClaw plugin SDK interfaces are used. Two host capabilities are version-coupled and validated against a supported host:

- `fetchLiveProviderModelRows` (`openclaw/plugin-sdk/provider-catalog-live-runtime`)
- `loadPreparedModelCatalog` (`openclaw/plugin-sdk/agent-runtime`)

The plugin does not patch OpenClaw, import build-hashed private modules, or modify Magpie.

## Data sources

| Source | Purpose | Boundary |
| --- | --- | --- |
| `GET /v1/models` | Availability, ownership, capabilities | Defines the discoverable text model set |
| `X-Magpie-Prices: 1` request header | Per-million-token prices | Optional; Magpie may withhold prices for remote clients |
| `User-Agent: openclaw` request header | Client identification | Sent by default; `sendUserAgent: false` removes it |
| `native_endpoints` | Per-model transport | Responses when native; otherwise Completions; Anthropic Messages when native |
| Explicit provider/model config | Deployment overrides | Standard `models.providers.magpie.models[]` |

`/v1/models` returns `{ data: [...] }` with `id`, `display_name`, `owned_by`, `context_window`, `max_input_tokens`, `max_output_tokens`, `modalities.input`, `native_endpoints`, `reasoning`, `supported_reasoning_levels`, `reasoning_levels`, and optional `service_tiers` / `magpie_price`.

Rows marked `kind: "image"` or `kind: "video"` are excluded. The text catalog does not request `X-Magpie-Drawers`, so image generators do not appear by default.

## Modules

| Module | Responsibility |
| --- | --- |
| `index.js` | Provider, auth, live catalog, service, CLI registration |
| `src/catalog.js` | URL validation, discovery headers, projection, pricing, cache, diagnostics |
| `src/provider.js` | Dynamic resolution, thinking profiles, payload adaptation, explicit overrides |
| `src/sync.js` | Host prepared-catalog publication and validation |
| `src/lifecycle.js` | Serialized synchronization and background service lifetime |
| `src/auth.js` | Model-access policy patch for the interactive login flow |
| `scripts/dev-live.mjs` | Isolated real-Magpie Gateway smoke test |

## OpenClaw integration

`registerProvider` supplies authentication, `catalog.run`, dynamic model hooks, thinking profiles, and stream wrappers. `registerModelCatalogProvider` supplies live control-plane rows. `registerService` runs the periodic discovery/publication loop.

`catalog.run` returns a provider configuration with a baseline `api: "openai-completions"` and per-model `api` values. The host's prepared model runtime honors the per-model route even when the provider config names a core API; the isolated host test exercises this with `magpie/model-a` on `/v1/responses`.

### Startup activation

The manifest sets:

```json
"activation": { "onStartup": true, "onProviders": ["magpie"] }
```

This is not cosmetic. OpenClaw's startup planner may skip a provider plugin when `models.providers.<id>.api` names a core API and the configured model can be built without runtime plugin code. A lazily loaded plugin never runs `registerService`, so the background refresh would silently stop. The manifest and isolated Gateway tests both guard this.

## Capability projection

- **Context**: `context_window`, then `max_input_tokens`, then `context_length`, then 128,000.
- **Output**: `max_output_tokens`, capped at the context window; 65,535 fallback with a warning.
- **Input**: text/image; `pdf`/`file` → `document`; audio/video dropped with a warning.
- **Reasoning**: `reasoning` is authoritative. `supported_reasoning_levels` (objects or strings) or `reasoning_levels` supply discrete efforts. `ultra` stays in diagnostics but is not exposed as a thinking level because Magpie normalizes it to `max`.
- **Transport**: `/v1/responses` → `openai-responses`; else `/v1/messages` → `anthropic-messages`; else `openai-completions`.
- **Prices**: `magpie_price` rates are USD per million tokens. An explicit base range covers `[0, firstAbove)`, then `tiers[].above` becomes a half-open OpenClaw range; multiple tiers are bound by the next tier's `above`, with the last tier open-ended. Omitted/invalid tier rates inherit normalized base rates, including cache read/write; explicit zero remains zero.
- **Cost fallback**: zero means unknown, not free.

`params.magpie` retains the source, owner, default effort, native efforts, service tiers, pricing flag, and warnings for diagnostics. It is not an authorization signal.

## Cache and synchronization

`CatalogClient` keys entries by a SHA-256 hash of endpoint and credential and keeps at most 16 entries. Concurrent reads are coalesced. Successful snapshots are reused for `refreshSeconds`; `staleSeconds` bounds temporary fallback.

- 401/403 invalidates the snapshot and does not use stale data.
- Other failures may return the last successful snapshot marked `stale`; publishing refuses stale snapshots.
- Invalid rows or duplicate IDs fail projection. A previous good snapshot may still be used within the stale window; it is never published as fresh.
- A valid empty catalog is a real removal and is published as empty.

Publication is serialized by `createCatalogSynchronizer`. The fingerprint includes endpoint, catalog revision, agent scope, and a hash of the current config (never the serialized config itself). Failed publication does not advance the fingerprint, so the next interval retries.

The service owns a timer rather than the host scheduler. Every tick, including startup, runs the complete synchronization promise through the public `api.lifecycle.runInBackgroundContext` API. This gives asynchronous publication a fresh, live host invocation: plugin replacement can drain it or reject replacement-gate waits instead of deadlocking on an expired `start()` token. Each start has its own abort signal and generation. `stop()` cancels the timer and discovery wait, blocks queued/not-yet-admitted publication, then drains any host publication already admitted (the prepared-catalog API has no cancellation parameter). Shared discovery has its own timeout; cancelling a caller does not abort other consumers or introduce failure backoff.

The service subscribes through `reload.configPrefixes` to `models.providers.magpie`, `auth`, `agents`, and `secrets`. The host restarts it with committed config after relevant hot changes, rather than retaining the startup endpoint/key or explicit model overrides. Plugin setting changes already trigger plugin replacement.

`materializeCatalog` calls `loadPreparedModelCatalog({ readOnly: false, refreshFullCatalog: true })` and validates:

- Every snapshot model was published.
- No removed plugin model remained published, except explicit configured models.

The plugin never writes `openclaw.json`.

## Request-time behavior

`wrapStreamFn` rechecks the cached catalog before a request. A removed model fails with a clear error. `selectEffort` maps OpenClaw levels to Magpie efforts, chooses the nearest advertised level (ties go up), and omits the field for models without discrete controls.

Payload adaptation writes:

- `reasoning.effort` for Responses.
- `reasoning_effort` for Chat Completions.

It preserves unrelated `reasoning` fields and leaves Anthropic Messages payloads to the host.

## Compatibility

| Component | Target | Validation |
| --- | --- | --- |
| OpenClaw | `>=2026.10.0 <2027` | Real SDK, managed `npm-pack:` install, isolated CLI and Gateway (validated on `2026.10.5`) |
| Magpie | `0.1.1285` observed | Live `/v1/models` discovery and mock HTTP/SSE |
| Node.js | `>=24.16.0 <25 || >=26.1.0` | Matches target host |

The target host is not a promise of compatibility with every Magpie deployment, model, quota state, or maximum context. Magpie availability can change with account health and gateway keys.

## Private/version-coupled surfaces

`fetchLiveProviderModelRows` and `loadPreparedModelCatalog` are host-owned capabilities that may change between OpenClaw releases. This plugin declares one supported host range with a lower bound (`peerDependencies.openclaw`, mirrored by `openclaw.compat.pluginApi`), validates both surfaces against the range in isolated host/Gateway tests, and reports the host it was built with through `openclaw.build.*`.

## Non-goals

- Image/video generation model registration.
- Native Codex harness behavior (compaction, subagents, Fast mode).
- Magpie-native web search.
- Mapping `service_tiers` to Fast mode.
- Rewriting OpenClaw configuration.
