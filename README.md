# OpenClaw Magpie Provider

English | [简体中文](README.zh-CN.md)

An [OpenClaw](https://github.com/openclaw/openclaw) provider plugin that discovers models from [Magpie](https://github.com/yetone/magpie), maps their capabilities and prices, and keeps OpenClaw's catalog fresh.

Provider ID: `magpie`. Built on the public provider plugin SDK; no OpenClaw or Magpie core changes required.

## What it does

- Discovers Magpie's current text models from `GET /v1/models`; no hand-maintained model array.
- Maps `context_window`, `max_output_tokens`, `modalities.input`, `reasoning_levels`, and `native_endpoints`.
- Requests `X-Magpie-Prices: 1` and maps `magpie_price` to OpenClaw `cost` and tiered pricing.
- Routes each model to OpenAI Responses or Chat Completions based on its native endpoint.
- Refreshes the catalog every 60 seconds through the host-owned prepared catalog; no config writes, no Gateway restart.
- Adds `openclaw magpie catalog` and `openclaw magpie sync` diagnostics.

## Requirements

- OpenClaw `2026.10.3`, Node.js `>=24.16.0 <25 || >=26.1.0`. This release targets that exact host.
- A reachable Magpie gateway, such as `http://127.0.0.1:3425/v1`, and a gateway key.

## Install

```bash
openclaw plugins install --link /path/to/openclaw-magpie-provider
```

If you use `plugins.allow`, add `magpie` without replacing existing entries, and enable it:

```json
{
  "plugins": {
    "allow": ["magpie"],
    "entries": {
      "magpie": { "enabled": true }
    }
  }
}
```

The manifest sets `activation.onStartup: true`. This is required: when `models.providers.magpie.api` names a core API, OpenClaw may otherwise load the provider lazily and never start the background catalog service.

## Configure

Keep `models: []` so the plugin owns discovery:

```json
{
  "models": {
    "providers": {
      "magpie": {
        "baseUrl": "http://127.0.0.1:3425/v1",
        "apiKey": "${MAGPIE_API_KEY}",
        "models": []
      }
    }
  },
  "agents": {
    "defaults": {
      "models": { "magpie/*": {} },
      "modelPolicy": { "allow": ["magpie/*"] }
    }
  }
}
```

`models.providers.magpie.api` may be omitted. The plugin selects a transport per model; keeping `openai-completions` still preserves per-model Responses routing (verified on the real host), but omitting it avoids ambiguity.

Restart the Gateway once to load the plugin. Later catalog changes refresh automatically.

## Use

```bash
openclaw models list --all --provider magpie
openclaw models set magpie/codex/gpt-6.1-sol
openclaw magpie catalog
openclaw magpie sync
```

Model IDs keep Magpie's `provider/model` form, for example `magpie/codex/gpt-6.1-sol` or `magpie/cline/cline-pass/deepseek-v4-pro`. OpenClaw splits a ref at the first `/`, so nested IDs are valid; quote them in the shell.

Interactive setup:

```bash
openclaw models auth login --provider magpie --method api-key
```

## Metadata mapping

| Magpie | OpenClaw | Rule |
| --- | --- | --- |
| `id` | `id` | Preserved verbatim |
| `display_name` | `name` | Falls back to `id` |
| `context_window` / `max_input_tokens` | `contextWindow` | Prompt limit; `context_length` is not treated as a total window |
| `max_output_tokens` | `maxTokens` | Conservative 65,535 fallback with a warning when absent |
| `modalities.input` | `input` | `text`/`image`/`pdf`→`document`; audio/video dropped with a warning |
| `reasoning` | `reasoning` | Preserved even without discrete levels |
| `supported_reasoning_levels[].effort` | `compat.supportedReasoningEfforts` | Filtered to OpenClaw levels |
| `native_endpoints` | per-model `api` | Responses / Anthropic Messages / Completions |
| `magpie_price` | `cost` + `cost.tieredPricing` | Only when Magpie returns it |
| `service_tiers` | diagnostics | Fast mode is not mapped yet |
| `kind: image/video` | skipped | Kept out of the text catalog |

Notes:

- `ultra` is not exposed as a normal thinking level. Magpie normalizes it to `max`, and OpenClaw's `/think ultra` is an orchestration mode.
- A thinking model with no advertised levels gets an `adaptive` profile and sends no effort field.
- Prices are USD per million tokens; Magpie tier boundaries become OpenClaw half-open `range` tiers.

## Refresh and failure behavior

Configure under `plugins.entries.magpie.config`:

| Setting | Default | Range | Description |
| --- | --- | --- | --- |
| `refreshSeconds` | 60 | 10–86400 | Background interval and cache TTL |
| `staleSeconds` | 300 | 0–86400 | Extra time a successful snapshot may be used after transient failures |
| `timeoutMs` | 10000 | 100–60000 | Per-request discovery timeout |
| `includePrices` | true | Boolean | Send `X-Magpie-Prices: 1` |

- 401/403 invalidates the cache immediately; no stale fallback.
- Network/5xx/invalid responses may use a bounded stale snapshot without extending its lifetime.
- A valid empty catalog publishes empty; malformed or duplicate rows fail the snapshot instead of deleting models.
- Request-time discovery rejects removed models.
- Synchronization is serialized; stopped or superseded services cannot publish.

## Limitations

- Text models only; Magpie image/video generators are excluded.
- `magpie/codex/*` uses OpenClaw's standard Responses transport, not the native Codex harness. Native Codex compaction, subagents, and Fast mode need a separate harness integration.
- Prices appear only when Magpie publishes `magpie_price`; otherwise cost is unknown-zero.
- Validated against OpenClaw `2026.10.3` only; re-run host and Gateway tests after a host upgrade.
- `service_tiers` and Magpie-native web search are not mapped yet.

## Develop and test

```bash
npm test
npm run check
npm run test:host        # real SDK + CLI, isolated temp state
npm run test:gateway     # isolated Gateway auto-publication
npm run test:live        # real Magpie discovery; needs MAGPIE_BASE_URL/MAGPIE_API_KEY
```

Manual isolated dev profile:

```bash
scripts/dev.sh setup
scripts/dev.sh install
scripts/dev.sh start
scripts/dev.sh inspect
scripts/dev.sh stop
```

One-shot real Magpie smoke test (temporary state, never the default profile):

```bash
MAGPIE_BASE_URL=http://127.0.0.1:3425/v1 MAGPIE_API_KEY=... node scripts/dev-live.mjs
```

See [architecture](docs/ARCHITECTURE.md), [development](docs/DEVELOPMENT.md), and [testing](docs/TESTING.md).

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
