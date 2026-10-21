# AGENTS.md — 插件开发规范（隔离开发流程）

本仓库是 OpenClaw provider 插件（`magpie`）。开发机上可能同时运行生产 Gateway（默认 profile、端口 18789、状态目录 `~/.openclaw`）。本规范要求开发、调试、验证全程不碰生产实例。

## 红线

1. 禁止裸跑 `openclaw` 做插件安装/启停/卸载/Gateway 变更。手动操作走 `scripts/dev.sh`（强制 `--profile dev`）。
2. 生产实例中的 magpie 只允许 ClawHub/npm 安装，绝不用 `--link` 指向开发仓库。
3. 禁止对默认 profile 执行 `plugins install --link`、`plugins disable`、`gateway stop/restart`。
4. 凭据（Magpie key、Gateway token）不进仓库、文档、测试 fixture 或终端输出。
5. 自动化测试必须在临时 `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` 和临时端口中运行，不依赖常驻 dev/prod Gateway。

## 双实例隔离

| | 生产（默认 profile） | 开发（`--profile dev`） |
| --- | --- | --- |
| 端口 | 18789 | 19001 |
| 状态目录 | `~/.openclaw` | `~/.openclaw-dev` |
| 插件来源 | ClawHub/npm | `--link` 本仓库 |

```bash
scripts/dev.sh setup
scripts/dev.sh install
scripts/dev.sh start
scripts/dev.sh inspect
scripts/dev.sh call models.list
scripts/dev.sh stop
```

`scripts/dev-live.mjs` 是另一种更彻底的隔离：临时 state + 临时端口 + 真实 Magpie，不写 `~/.openclaw-dev`：

```bash
MAGPIE_BASE_URL=http://127.0.0.1:3425/v1 MAGPIE_API_KEY=... node scripts/dev-live.mjs
```

## 关键经验：启动激活

`openclaw.plugin.json` 必须保留：

```json
"activation": { "onStartup": true }
```

原因：当 `models.providers.magpie.api` 是核心 API 名称（如 `openai-completions`）时，OpenClaw 可能认为不需要运行时插件，于是延迟加载。延迟加载不会启动 `registerService`，后台目录刷新会静默失效。`test/manifest.test.js` 和 `test/gateway.integration.js` 都覆盖这一点。

## 版本兼容

宿主版本用**带下限的范围**声明，一个插件版本覆盖一整条宿主线：

```json
"peerDependencies": { "openclaw": ">=2026.10.0 <2027" },
"openclaw": {
  "compat": { "pluginApi": ">=2026.10.0 <2027", "minGatewayVersion": "2026.10.0" },
  "build": { "openclawVersion": "2026.10.5", "pluginSdkVersion": "2026.10.5" }
}
```

- `peerDependencies.openclaw` = 支持的宿主范围；`openclaw.compat.pluginApi` 必须写同一个范围（宿主的安装/加载门禁按它判断）。
- `openclaw.compat.minGatewayVersion` 取该范围的下限，不要写范围。
- `openclaw.build.*` 写**实际验证过的宿主版本**（ClawHub 的 builtWith/sdk 元数据），必须是具体版本且落在范围内；不需要为了宿主小版本升级而发新插件版本。
- 这套规则由 `scripts/host-compat.mjs` 统一校验，`npm run test:ci` 和 `test/manifest.test.js` 都会跑；`src/sync.js` 的 `MIN_OPENCLAW_VERSION` 必须等于下限。

当前 OpenClaw `>=2026.10.0 <2027`（验证于 `2026.10.5`），Node.js `>=24.16.0 <25 || >=26.1.0`。

适配新的宿主线（例如 2027）时改这几处范围、重跑 host/gateway 测试，再 bump 插件版本。不要为旧宿主保留第二套代码路径。

## 测试约定

- `npm test`：纯逻辑，无凭据。
- `npm run test:host`：真实 SDK/CLI，临时 state，mock Magpie。
- `npm run test:gateway`：隔离 Gateway，验证热发布、删除、空目录。
- `npm run test:live`：显式 opt-in，读取真实 Magpie 目录；设置 `MAGPIE_LIVE_CASES` 才会发推理请求。
- `npm run test:ci`：完整本地门禁。

测试不得修改生产配置；mock 服务使用测试 key；真实 key 只从环境变量读取。

## 分支与发布

建议 `dev` 分支开发，`main` 发布；发布前跑 `npm run test:ci`，并确认：

- `index.js`、`src/`、`openclaw.plugin.json` 在 npm 包内。
- `test/`、临时 state、真实 key、`node_modules` 不在包内。
- `activation.onStartup` 仍在。
- 版本号已 bump。
