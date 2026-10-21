# Testing

The suite is split into pure logic, host integration, Gateway integration, and opt-in live discovery. Default tests use no real credentials and do not call paid models.

## Matrix

| Suite | What it proves |
| --- | --- |
| `npm test` | URL/header rules, projection and price tiers, cache/cancellation, thinking/payloads, sync validation, service cancellation/reload lifetime, dev-script isolation with mocks, manifest activation |
| `npm run test:host` | Real SDK discovery and cost calculation at price boundaries, Responses/Chat SSE, effort fields, managed `npm-pack:` install, CLI catalog/sync, one-shot host model run |
| `npm run test:gateway` | Additions/removals/context/empty catalog, endpoint/key hot reload, explicit model overrides, plugin-settings replacement with subsequent periodic refresh, no plugin config writes or Gateway restart |
| `npm run test:live` | Real Magpie `/v1/models` shape and projection; optional tiny inference cases |

## Isolation

`test/isolated-host-env.js` runs before any host SDK import. It:

- Creates a temporary `OPENCLAW_STATE_DIR` and empty `OPENCLAW_CONFIG_PATH`.
- Clears inherited OpenClaw/legacy profile, path and service selectors before setting isolated paths.
- Deletes inherited API keys/tokens so ambient credentials cannot activate unrelated providers.
- Points `XDG_CACHE_HOME` and `npm_config_cache` at temporary directories.

Host tests use their own mock Magpie HTTP/SSE server and test credentials. Gateway tests allocate a free loopback port, write a temporary config with a test token, install the plugin with `npm-pack:`, spawn `gateway run`, call public `models.list` RPC, and stop the process.

No suite starts, stops, or modifies a persistent dev or production Gateway.

## Coverage details

### Pure logic

- Endpoint normalization preserves reverse-proxy prefixes and rejects credentials/query/fragment.
- `data[]`, `models[]`, and top-level arrays.
- Codex Responses mapping, Grok missing output, Cline Chat mapping, text-only inputs, unknown context/output.
- Thinking models with no levels and non-reasoning models.
- Image/video exclusion, duplicate/invalid IDs, invalid limits.
- Base and tiered price conversion, including base/threshold boundaries, multiple half-open ranges, partial cache-rate inheritance, and explicit zero.
- `X-Magpie-Prices`, `User-Agent: openclaw` and Bearer header construction, including the `sendUserAgent` opt-out.
- Cache coalescing, caller-local cancellation (including the initiating caller), independent shared timeout, genuine failure backoff, TTL, stale bounds, 401/403 invalidation, credential isolation, force.
- Explicit model overrides and nested Magpie params; caller cancellation is forwarded through pending host authentication before catalog fetch.
- Thinking profile defaults, nearest-effort selection, exact wire override, payload dialect.
- Prepared catalog completeness, retained removals, explicit models, stale refusal.
- Serialized publication, fingerprint retry, config-change publication.
- Service immediate start, reschedule after settle, abort/stop/join, no queued or late-discovery publication after cancellation, fresh host background admission for every complete sync promise, replacement rejection and recovery, drain of admitted publication, config subscriptions and restart with committed config.
- Dev wrapper isolates CLI/help/editor/service calls; hostile inherited selectors, target/profile flags, and dev state/config symlinks fail closed. Uses mock executables and temporary HOME only.
- Manifest `activation.onStartup` regression.

### Host integration

- Real `fetchLiveProviderModelRows` sends the key, price and `openclaw` User-Agent headers.
- Public SDK `calculateCost` uses base rates below a threshold, tier rates at/above it, and inherited partial-tier cache rates.
- Responses model uses `/v1/responses` and `reasoning.effort`.
- Chat model uses `/v1/chat/completions` and `reasoning_effort`.
- Model without levels sends no effort field.
- Isolated CLI install reports `status: loaded`, discovers two models, syncs, lists them, then updates to a different set and removes the old one.
- Host `infer model run` through `magpie/model-a` uses the per-model Responses route and `high` effort even when the provider config says `openai-completions`.
- The main config file is byte-for-byte unchanged after discovery/sync.

### Gateway integration

- Initial catalog is visible through `models.list`.
- Plugin runtime inspection reports loaded and `npm-pack` install.
- Changing server rows to `model-b` + `model-c` publishes without restart and updates context.
- Empty rows publish an empty catalog.
- Endpoint/key hot changes switch to a new route/key; a later server-row change proves the periodic service uses committed config.
- A model-only explicit context override republishes an unchanged upstream revision.
- Plugin `refreshSeconds` hot changes replace the plugin instance; a later server-row change proves the replacement's periodic service is active.
- Gateway stays running; config is byte-for-byte unchanged except for deliberate writes by the test.

## Live tests

`npm run test:live` requires `MAGPIE_BASE_URL` and `MAGPIE_API_KEY`. It asserts every discovered row has an ID, positive context, input list, and a known transport. It prints a bounded summary. Without `MAGPIE_LIVE_CASES`, it does not send inference. With cases, it sends one small prompt per case and reports wire effort/usage without credentials or raw upstream bodies.

## Limits

Tests do not prove:

- Every Magpie model or future catalog shape.
- Maximum-context stress behavior.
- Every account quota/key restriction.
- Native Codex harness features.
- Image/video generation.
- Long-running multi-agent sessions.

They do prove the metadata projection, both transport dialects, startup activation, managed installation, and host-owned hot publication on the target host.
