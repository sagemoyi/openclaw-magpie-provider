# Development and testing

The default suites need no Magpie credentials and never touch a persistent dev or production Gateway. Live discovery is opt-in and needs a real endpoint.

## Environment

- Node.js `>=24.16.0 <25 || >=26.1.0`.
- An `openclaw` executable and a resolvable `openclaw` peer SDK at the exact target version.

The tests import `openclaw/plugin-sdk/*`, so a local peer is required. Install it without changing package metadata:

```bash
npm install --no-save --package-lock=false openclaw@2026.10.5
```

For a quick local checkout of an existing install, a symlink works too:

```bash
mkdir -p node_modules/.bin
ln -s /path/to/openclaw node_modules/openclaw
ln -s ../openclaw/openclaw.mjs node_modules/.bin/openclaw
```

## Commands

| Command | Scope | Credentials |
| --- | --- | --- |
| `npm test` | Pure logic, cache, projection, lifecycle, manifest | No |
| `npm run check` | Entry and module syntax | No |
| `npm run test:host` | Real SDK, CLI, mock HTTP/SSE, managed npm-pack install | No |
| `npm run test:gateway` | Isolated Gateway, automatic catalog publication | No |
| `npm run test:live` | Real Magpie catalog discovery | Yes; read-only unless cases are set |
| `npm run test:ci` | Full local gate (diff, syntax, unit, host, gateway) | No |

Host and Gateway suites create temporary state/config, free ports, mock Magpie servers, and their own Gateway processes. They do not read or write `~/.openclaw` or `~/.openclaw-dev`. They also set `XDG_CACHE_HOME` and `npm_config_cache` to temporary directories so a read-only home cache cannot break host startup or `npm pack`.

## Isolated dev profile

`scripts/dev.sh` fixes `--profile dev`, state/config under `$HOME/.openclaw-dev`, port 19001, and the loopback Gateway URL. It clears inherited host profile/path/service selectors and rejects flags that could override the profile, container, URL, port, config, or other target paths. Even capability probes use this isolated environment:

```bash
scripts/dev.sh setup      # once per machine
scripts/dev.sh install    # --link this checkout
scripts/dev.sh start
scripts/dev.sh inspect
scripts/dev.sh call models.list
scripts/dev.sh logs
scripts/dev.sh stop
scripts/dev.sh pack-verify
```

`pack-verify` switches the dev install to a tarball; run `scripts/dev.sh install && scripts/dev.sh restart` to return to the linked checkout.

The plugin declares `activation.onStartup: true`; keep it. Without it, a provider-level `api` that names a core API can make OpenClaw load the plugin lazily, and plugin services do not start on a lazy load.

## One-shot live dev smoke

This is the most isolated way to test against the real Magpie. It creates a temporary state directory and Gateway, links the checkout, calls `models.list`, then stops and removes everything:

```bash
export MAGPIE_BASE_URL='http://127.0.0.1:3425/v1'
export MAGPIE_API_KEY='...'
node scripts/dev-live.mjs
# keep artifacts for inspection:
MAGPIE_KEEP_STATE=1 node scripts/dev-live.mjs
```

It never uses the default profile. Do not paste the key into source, docs, or issue reports.

## Live catalog test

```bash
export MAGPIE_BASE_URL='http://127.0.0.1:3425/v1'
export MAGPIE_API_KEY='...'
npm run test:live
```

By default this only reads `/v1/models` (no inference). To send tiny inference requests, set explicit cases:

```bash
export MAGPIE_LIVE_CASES='[{"id":"codex/gpt-6.1-sol","level":"high"},{"id":"cline/cline-pass/deepseek-v4-pro","level":"max"}]'
npm run test:live
```

The script prints protocol, wire effort, stop reason, and usage. It does not print credentials or raw upstream error bodies. It may consume quota when cases are set.

## Before a release

```bash
npm run test:ci
npm pack --dry-run
```

Check that the package includes `index.js`, `src/`, `openclaw.plugin.json`, README/docs, and license files; it must exclude `test/`, temporary state, credentials, and `node_modules`. Verify that `activation.onStartup` is still present and that the version was bumped.

## Troubleshooting

- **Models appear but never refresh**: verify `activation.onStartup: true`; check `openclaw plugins inspect magpie --runtime --json` and Gateway logs for `magpie-catalog`.
- **Plugin not loaded**: `plugins.allow` is an explicit allowlist. Add `magpie` and set `plugins.entries.magpie.enabled: true`.
- **Host CLI fails with `XDG_CACHE_HOME` permissions**: use the test suites or point `XDG_CACHE_HOME` at a writable temporary directory. This is a host/sandbox issue, not a plugin error.
- **401/403**: Magpie requires a key even on a Docker-published loopback port, because the peer is the bridge, not loopback. Supply the gateway key.
- **Price missing**: Magpie may withhold `magpie_price` for remote clients or unpriced models. Zero cost means unknown.
