# OpenClaw Magpie Provider

[English](README.md) | 简体中文

一个 [OpenClaw](https://github.com/openclaw/openclaw) provider 插件：从 [Magpie](https://github.com/yetone/magpie) 的 `GET /v1/models` 读取模型、上下文、输出上限、输入模态、推理档位和价格，并让 OpenClaw 的模型目录自动刷新。

Provider ID：`magpie`。只使用 OpenClaw 的 provider 插件接口，不需要改 OpenClaw 或 Magpie 源码。

## 它做什么

- 自动发现 Magpie 当前可用的文本模型，不需要手写 `models` 数组。
- 映射 `context_window`、`max_output_tokens`、`modalities.input`、`reasoning_levels`、`native_endpoints`。
- 通过 `X-Magpie-Prices: 1` 读取 `magpie_price`，映射为 OpenClaw 的 `cost` 和分档计价。
- 按模型的 `native_endpoints` 选择 `openai-responses` 或 `openai-completions`；没有原生端点时回退 Chat Completions。
- Gateway 启动后每 60 秒检查一次目录；变化时通过宿主发布，不写 `openclaw.json`，不需要重启 Gateway。
- 提供 `openclaw magpie catalog` 和 `openclaw magpie sync` 诊断命令。

## 要求

- OpenClaw `2026.10.3`，Node.js `>=24.16.0 <25 || >=26.1.0`。本版本按精确宿主版本验证。
- 可访问的 Magpie Gateway，例如 `http://127.0.0.1:3425/v1`，以及可用的 Magpie gateway key。

## 安装

从源码目录安装到当前 OpenClaw：

```bash
openclaw plugins install --link /path/to/openclaw-magpie-provider
```

如果使用了 `plugins.allow`，必须把 `magpie` 加进去，并启用插件；保留已有的 allow 项：

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

插件清单声明了 `activation.onStartup: true`。这一点很关键：否则当 `models.providers.magpie.api` 是核心 API 名称时，OpenClaw 可能延迟加载 provider 插件，后台目录服务就不会启动。

## 配置

推荐保留 `models: []`，让插件发现模型；不要写入静态模型列表：

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

`models.providers.magpie.api` 可以省略；插件会按每个模型的 `native_endpoints` 选择协议。保留 `openai-completions` 也不影响逐模型的 Responses 路由（已用真实宿主验证），但省略更不容易产生歧义。

`apiKey` 建议使用环境变量或 SecretRef，不要把真实 key 提交到仓库。

安装后重启一次 Gateway 让插件加载；之后模型变化由插件后台刷新，不需要重启。

## 使用

```bash
openclaw models list --all --provider magpie
openclaw models set magpie/codex/gpt-6.1-sol
openclaw magpie catalog
openclaw magpie sync
```

模型 ID 原样保留 Magpie 的 `provider/model` 形式，例如：

- `magpie/codex/gpt-6.1-sol`
- `magpie/grok/grok-4.7`
- `magpie/cline/cline-pass/deepseek-v4-pro`

OpenClaw 按第一个 `/` 解析 provider/model，所以模型 ID 里再带 `/` 是合法的；CLI 里建议加引号。

也可以用交互式登录写入端点和凭据：

```bash
openclaw models auth login --provider magpie --method api-key
```

## 元数据映射

| Magpie | OpenClaw | 规则 |
| --- | --- | --- |
| `id` | `id` | 原样保留 |
| `display_name` | `name` | 缺失时回退 `id` |
| `context_window` / `max_input_tokens` | `contextWindow` | 这是 prompt 上限；不用 `context_length` 当总窗口 |
| `max_output_tokens` | `maxTokens` | 缺失时保守回退 65,535，并记录 warning |
| `modalities.input` | `input` | `text`/`image`/`pdf`→`document`；audio/video 丢弃并 warning |
| `reasoning` | `reasoning` | 即使没有离散档位也保留 |
| `supported_reasoning_levels[].effort` | `compat.supportedReasoningEfforts` | 过滤到 OpenClaw 认识的档位 |
| `native_endpoints` | 逐模型 `api` | `/v1/responses`→Responses；`/v1/messages`→Anthropic；否则 Completions |
| `magpie_price` | `cost` + `cost.tieredPricing` | 仅当请求带 `X-Magpie-Prices: 1` 且 Magpie 返回时 |
| `service_tiers` | 诊断字段 | 暂不映射 Fast 模式 |
| `kind: image/video` | 跳过 | 文本目录不混入图片/视频模型 |

注意：

- `ultra` 不作为独立 thinking level 暴露。Magpie 会把它归一成 `max`，OpenClaw 的 `/think ultra` 本身也是编排模式。
- 模型没有离散档位时，thinking profile 显示 `adaptive`（provider default），请求不发送 effort 字段，让 Magpie 用模型默认值。
- 价格是每百万 token 的美元价；分档价格按 OpenClaw 的半开区间 `range` 转换。

## 刷新与失败行为

插件配置在 `plugins.entries.magpie.config`：

| 设置 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `refreshSeconds` | 60 | 10–86400 | 后台目录刷新间隔和缓存 TTL |
| `staleSeconds` | 300 | 0–86400 | 临时失败时允许使用上次成功快照的额外时间 |
| `timeoutMs` | 10000 | 100–60000 | 单次目录请求超时 |
| `includePrices` | true | Boolean | 是否发送 `X-Magpie-Prices: 1` |

行为：

- 目录变化时通过宿主发布；不写主配置，不做合成配置代际。
- 401/403 立即失效缓存，不拿旧目录硬撑。
- 网络/5xx/非法响应可在 stale 窗口内使用旧快照，不延长原快照寿命。
- 合法空目录按空目录发布（模型确实被移除）；非法/重复 ID 让快照失败，不能把坏响应当成删除。
- 请求时重新检查模型是否仍在目录中；已移除模型明确拒绝。
- 后台同步串行化；旧任务不能覆盖新任务；服务停止/插件重载会取消并等待在途任务。

## 限制

- 只注册文本模型；Magpie 的图片/视频生成模型不会进入文本目录。
- `magpie/codex/*` 走 OpenClaw 的标准 Responses transport，不等同于原生 Codex harness；Codex 原生压缩、子代理和 Fast 模式需要另做 harness 集成。
- 价格依赖 Magpie 本机/共享 key 场景返回 `magpie_price`；拿不到时成本显示为未知零价。
- 插件只针对 OpenClaw `2026.10.3` 验证；升级宿主后需要重新跑 host/gateway 测试。
- `service_tiers`、Magpie 原生 web search 暂未映射。

## 开发与测试

```bash
npm test                 # 纯逻辑
npm run check            # 语法
npm run test:host        # 真实 OpenClaw SDK + CLI，隔离临时目录
npm run test:gateway     # 隔离 Gateway，验证自动发布
npm run test:live        # 读取真实 Magpie 目录（需 MAGPIE_BASE_URL/MAGPIE_API_KEY）
```

手工隔离开发：

```bash
scripts/dev.sh setup
scripts/dev.sh install
scripts/dev.sh start
scripts/dev.sh inspect
scripts/dev.sh call models.list
scripts/dev.sh stop
```

或者一次性真实 Magpie dev 冒烟（临时 state，不碰生产）：

```bash
MAGPIE_BASE_URL=http://127.0.0.1:3425/v1 MAGPIE_API_KEY=... node scripts/dev-live.mjs
```

详见 [架构](docs/ARCHITECTURE.md)、[开发](docs/DEVELOPMENT.md)、[测试](docs/TESTING.md)。

## License

MIT。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
