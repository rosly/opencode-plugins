# openrouter-params

OpenRouter parameter-control plugin for OpenCode. It injects OpenRouter request options — supplier routing, latency, throughput, quantization, cost, data-policy preferences, reasoning, model fallbacks, and more — into every model request without editing OpenCode.

## Goal

OpenRouter load-balances requests across suppliers by price by default. This plugin gives you per-request control over which suppliers receive a request and how they are ranked, plus the wider OpenRouter request surface, without modifying or rebuilding OpenCode. Preferences live in a plain JSON file, so changing them is an edit to a config file, not to code.

The plugin changes **only** OpenRouter's request options. Everything else stays with OpenCode: prompt construction, model selection, generation, retries, caching, and output handling.

## How it works

The plugin registers the session `context`, `title`, `compaction`, and `generate` hooks and reads preferences from `~/.config/opencode/openrouter-params.json`. For each request on the `openrouter` provider, it resolves the matching preferences in realtime and deep-merges them into `event.options`.

OpenCode forwards any `options` key that is not a generation setting as a **provider option**. The OpenRouter route lifts those keys into the Chat Completions request body verbatim, so the plugin never rewrites raw HTTP.

### Technical decisions

- **Semantic passthrough, not HTTP rewriting.** The `context`/`title`/`compaction`/`generate` hooks expose `event.options`, which OpenCode already routes into provider options for the selected protocol. This is cleaner and less fragile than editing the final wire body.
- **JSON config file.** Preferences are data, not code. The file is read once at plugin setup; restart the service (or reload plugins) after editing it.
- **Full OpenRouter surface per entry.** Each entry holds the `provider` routing object plus the top-level OpenRouter body fields (`reasoning`, `models`, `plugins`, `usage`, `web_search_options`, `user`, `debug`, and unknown passthrough keys).
- **Top-to-bottom, deep-merge precedence.** Matching runs in the order entries appear in the `model` map; later matches overwrite earlier ones per-key. Nested objects merge field-by-field, scalars and arrays replace.
- **All request kinds.** The same policy is applied to the agent loop and to auxiliary requests (title, compaction, generate). A future task will add per-kind filtering; see below.
- **Provider-scoped.** The merge only applies when `event.model.providerID === "openrouter"`, so requests to other providers are never touched.
- **Missing file means no change.** If the config file is absent, empty, or invalid JSON, requests are left untouched.
- **Tracing is off by default.** A single `TRACE` flag in the source enables observation logging to `/tmp/opencode/openrouter-params/`.

## Files

```text
openrouter-params.ts                    the plugin
config/openrouter-params.json           empty config (install this)
config/openrouter-params-example.json   fuller example (see below)
```

## Installation

1. Copy the plugin into the OpenCode plugin directory:

   ```sh
   mkdir -p ~/.config/opencode/plugins
   cp openrouter-params.ts ~/.config/opencode/plugins/
   ```

2. Copy the empty config to your OpenCode config directory and edit it:

   ```sh
   mkdir -p ~/.config/opencode
   cp config/openrouter-params.json ~/.config/opencode/openrouter-params.json
   ```

   The shipped config is empty (`{"model": {}}`), so the plugin applies no
   overrides until you add entries. A fuller example is in
   `config/openrouter-params-example.json`.

3. OpenCode reloads plugins from watched config directories automatically. If it does not pick up the change, restart the service:

   ```sh
   opencode service restart
   ```

## Configuration

The config file is a JSON object with a single top-level `model` map. Each key is a **matcher**, and each value is an **override set** (OpenRouter options) that applies to the models the key matches.

```jsonc
{
  "model": {
    "*":                 { /* baseline overrides */ },
    "openai/*":          { /* all OpenAI-hosted models */ },
    "openai/gpt-5*, openai/gpt-5-mini*": { /* two models share one set */ },
    "anthropic/claude-sonnet-4-5#high": { /* a single model variant */ }
  }
}
```

### Matchers

A key is one pattern, a comma-separated list of patterns, or a literal slug. All of these forms are supported:

- **Prefix wildcard** — `anthropic/*` matches every Anthropic-hosted model.
- **Full glob** — `*` and `?` anywhere, e.g. `anthropic/claude-?-5*`.
- **Comma-separated list** — `"openai/gpt-5*, openai/gpt-5-mini*"`. Order within a list is irrelevant; if any pattern matches, the entry applies once.
- **Literal slug** — including an explicit variant, e.g. `openai/gpt-5#high`.

### Matching and precedence

- The match target is the full slug including variant: `id#variant`. OpenCode always supplies a variant — `default` when none is selected — so a base model's slug is always `id#default`, never the bare `id`. A key that is a bare base id (for example `openai/gpt-5`) therefore matches **nothing**. Append `*` to match the model across all variants: `openai/gpt-5*`. A key that names a specific variant (for example `openai/gpt-5#high`) matches **only that variant**.
- Entries are processed **top-to-bottom** in file order. Every entry whose key matches contributes its override set, **deep-merged** over the accumulated result. A later match overwrites an earlier one per-key.
- `"*"` has no special precedence — it is an ordinary entry. Place it first for a baseline, or last as an "always apply" fallback.

Deep merge means nested objects (for example `preferred_max_latency`, `max_price`) merge field-by-field, while scalars and arrays replace wholesale.

### Field reference

Each override set maps to OpenRouter's Chat Completions request body. `provider` is one sibling among the rest; the other fields sit at the same level in both the config and the sent body.

| Config key | Sent as | Notes |
| - | - | - |
| `provider` | `provider` (object) | Routing/supplier control. OpenRouter requires these fields nested under `provider`. |
| `reasoning` | `reasoning` (object) | Reasoning behavior (`enabled`, `effort`, `max_tokens`, `exclude`). |
| `models` | `models` (array) | Model fallback chain. |
| `plugins` | `plugins` (array) | e.g. `response-healing`, `auto-router`. |
| `usage` | `usage` (object) | `{ "include": true \| false }`. |
| `web_search_options` | `web_search_options` (object) | Native web-search config. |
| `user` | `user` (string) | Telemetry id. |
| `debug` | `debug` (object) | e.g. `{ "echo_upstream_body": true }`. |
| anything else | passed through top-level | e.g. `max_tokens`, `response_format`. |

#### `provider` fields

| Field | Type | Description |
| - | - | - |
| `order` | string[] | Provider slugs to try in order, e.g. `["anthropic", "openai"]`. Disables load-balancing. |
| `allow_fallbacks` | boolean | Whether to fall back when a named provider is unavailable (default `true`). |
| `only` | string[] | Exclusive allow-list of provider slugs. |
| `ignore` | string[] | Provider slugs to skip. |
| `require_parameters` | boolean | Only route to providers supporting all request parameters. |
| `data_collection` | `"allow"` \| `"deny"` | Filter by provider data policy. |
| `zdr` | boolean | Restrict to Zero Data Retention endpoints only. |
| `enforce_distillable_text` | boolean | Restrict to models allowing text distillation. |
| `quantizations` | string[] | Quantization filter, e.g. `["int4", "int8"]`. |
| `sort` | string \| object | `"price"` / `"throughput"` / `"latency"`, or `{ "by": "...", "partition": "model" \| "none" }`. Disables load-balancing. |
| `preferred_min_throughput` | number \| object | Preferred min tokens/sec, or `{ "p50": ..., "p90": ... }`. |
| `preferred_max_latency` | number \| object | Preferred max latency seconds, or `{ "p50": ..., "p90": ... }`. |
| `max_price` | object | Hard price ceiling: `{ "prompt": ..., "completion": ..., "image": ..., "audio": ..., "request": ... }`. |

See the OpenRouter provider-routing guide for full semantics: <https://openrouter.ai/docs/features/provider-routing>.

### Routing and price gotchas

`sort: "price"` does **not** mean "cheapest output tokens." OpenRouter decides the route *before* it generates anything, so the completion length is unknown at routing time. The only cost it can compute up front is the **input** side (prompt tokens, plus cache-read tokens where they apply). In practice `sort: "price"` therefore ranks endpoints by their **input price** (`prompt` rate), not their output price.

This matters because suppliers deliberately set a very low `prompt` price to win `sort: "price"` routing, while charging the highest `completion` price in the pool. Workloads that are prompt-heavy (short generations, large shared context, heavy tool calls) are genuinely served cheapest by those suppliers; workloads that are output-heavy are *not*, and the "cheapest" route will still bill you the highest output rate.

**Our worked example** (`deepseek/deepseek-v4-pro-0813`), taken from the live endpoints API. Endpoint `prompt` vs `completion` rates, USD per 1M tokens:

| Endpoint | prompt $/M | completion $/M |
| - | - | - |
| Wafer | **0.25** (cheapest input) | **5.00** (highest output) |
| DeepSeek | 0.66 | 1.98 |
| StreamLake | 0.66 | 1.98 |
| Sail Research (fp4) | 0.48 | 1.98 |

A clean ~8.7k-token prompt with a ~60-token reply costs `8707×prompt + 60×completion`. For Wafer that is `8707×0.25e-6 + 60×5.00e-6 ≈ $0.0025`, for DeepSeek `8707×0.66e-6 + 60×1.98e-6 ≈ $0.0059`. Because the prompt dominates, **Wafer really is the cheapest route** — and `sort: "price"` correctly sends the request there. The "$1.98 DeepSeek vs $5 Wafer" comparison is only valid for completion *tokens*, which are a small share of this request.

The consequence for configuration:

- **For prompt-heavy traffic**, `sort: "price"` works as intended; add `max_price.completion` as a ceiling if you want to cap the output rate while still routing cheaply up front.
- **For output-heavy traffic**, `sort: "price"` cannot pick a low output rate. Use `max_price.completion` to *exclude* high-output endpoints (unlike the soft `preferred_*` thresholds, `max_price` prevents the request from running when no endpoint qualifies), or pin providers explicitly with `only` / `order`.

There is no `sort` value for output price; the closest control is a hard ceiling, e.g.:

```jsonc
"deepseek/deepseek-v4-pro-0813*": {
  "provider": {
    "sort": "price",
    "max_price": { "completion": "1.98", "prompt": "0.66" }
  }
}
```

### Where the real prices live

The OpenRouter **model page does not show the per-endpoint price breakdown** it uses for routing. It renders a single headline price and throughput/latency percentiles; the actual decision data (per-endpoint `prompt`, `completion`, `input_cache_read`, and time-of-week `overrides`) is behind an API endpoint. The model page also does not reveal the time-tiered `overrides` that many official endpoints carry (see below), so its displayed number is frequently not the price your request is quoted.

Fetch the authoritative per-endpoint prices with:

```bash
curl https://openrouter.ai/api/v1/models/MODEL_ID/endpoints
```

For this example:

```bash
curl https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-pro-0813/endpoints
```

The response lists one entry per endpoint with `pricing` (`prompt`, `completion`, `input_cache_read`, `discount`) and a nested `overrides` array. Proof — the `DeepSeek` endpoint's completion price is **time-tiered**, not the flat $1.98 the page implies:

```json
{
  "provider_name": "DeepSeek",
  "quantization": "unknown",
  "pricing": {
    "prompt": "0.00000066",
    "completion": "0.00000198",
    "input_cache_read": "0.000000022",
    "overrides": [
      { "utc_days": ["saturday", "sunday"], "completion": "0.00000198" },
      { "utc_start": 0,   "utc_end": 100,  "utc_days": ["monday", "tuesday", "wednesday", "thursday", "friday"], "completion": "0.00000198" },
      { "utc_start": 100, "utc_end": 400,  "utc_days": ["monday", "tuesday", "wednesday", "thursday", "friday"], "completion": "0.00000396" },
      { "utc_start": 400, "utc_end": 600,  "utc_days": ["monday", "tuesday", "wednesday", "thursday", "friday"], "completion": "0.00000198" },
      { "utc_start": 600, "utc_end": 1000, "utc_days": ["monday", "tuesday", "wednesday", "thursday", "friday"], "completion": "0.00000396" },
      { "utc_start": 1000, "utc_end": 0,   "utc_days": ["monday", "tuesday", "wednesday", "thursday", "friday"], "completion": "0.00000198" }
    ]
  }
}
```

`utc_start`/`utc_end` are tenths-of-an-hour into the day, so the `$3.96` completion rate applies during weekday peak hours and `$1.98` off-peak and on weekends. All prices are **per token**; multiply by 1,000,000 for the per-million rate. The `quantization` field is what your `quantizations` routing filter matches against — note the official DeepSeek endpoint reports `"unknown"`, and the cheap `fp4` endpoints (e.g. Sail Research) are a distinct tag your filter may be excluding.

### Choosing providers: a worked process

Here is the end-to-end process we used to pick the cheapest and fastest suppliers for `deepseek/deepseek-v4.1-flash`, and how it defeats the input-price trick described above.

**Step 1 — pull the endpoint data and rank by output price.** The endpoints API is the source of truth for `prompt`/`completion`/`input_cache_read` rates per supplier, so we query it and sort by the `completion` (output) price we actually care about, not the `prompt` (input) price that `sort: "price"` would rank on:

```bash
curl https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints
```

**Step 2 — filter to a quantization tag and note the provider slugs.** We keep only `quantization: "fp8"` / `"unknown"` entries, then record the `tag` slug of each supplier we want to allow. The `tag` field carries the routing slug (e.g. `streamlake/fp8`, `coreweave/fp8`, `inference-net/fp8`); the base slug before the `/` is what goes into `only`. The cheap-output endpoints ranked this way for flash were:

```text
deepinfra, streamlake, relace, deepseek, coreweave,
inference-net, digitalocean, baidu, gmicloud, atlas-cloud
```

Listing these slugs in `only` is the step that overcomes the trick — a supplier that wins `sort: "price"` on a low input price (and hides a high output price) never enters the pool, because the pool is fixed by `only` from the output-price ranking we computed ourselves.

**Step 3 — rank by throughput and gate on a TPS floor.** With the supplier set fixed, we stop caring about price entirely and sort by speed, plus a minimum quality-of-service floor on throughput:

```jsonc
"deepseek/deepseek-v4.1-flash*": {
  "provider": {
    "preferred_min_throughput": { "p75": 100 },
    "only": [
      "deepinfra", "streamlake", "relace", "deepseek", "coreweave",
      "inference-net", "digitalocean", "baidu", "gmicloud", "atlas-cloud"
    ],
    "allow_fallbacks": false
  }
}
```

`sort` is deliberately omitted here — it is inherited from a shared baseline entry (`"*": { "provider": { "sort": "throughput" } }`) that sorts every request by throughput, so per-model entries only need to add their `only` set, the `preferred_min_throughput: { "p75": 100 }` floor, and `allow_fallbacks: false`.

The general recipe is therefore: **query the endpoints API → rank by output price → pin the winners with `only` → apply `sort` (`price` for output-heavy, `throughput`/`latency` for speed) → gate quality with `preferred_min_throughput`/`preferred_max_latency` → `allow_fallbacks: false` to keep the boundary hard.**

### Full example

A copy-able version of this example is at `config/openrouter-params-example.json`:

```jsonc
{
  "model": {
    // Baseline: applies to every model that is not matched more specifically.
    "*": {
      "provider": {
        "order": ["anthropic", "openai"],      // who gets the request, in preference order
        "allow_fallbacks": true,               // fall back if a named provider is down
        "sort": "latency",                     // rank suppliers by lowest latency
        "preferred_max_latency": { "p90": 3 }, // prefer endpoints <3s latency at p90
        "quantizations": ["int8"]              // only int8-quantized endpoints
      },
      "reasoning": {                            // OpenRouter `reasoning` body field
        "enabled": true,
        "effort": "high",
        "max_tokens": 2000
      },
      "usage": { "include": true },             // OpenRouter `usage` body field
      "web_search_options": {                   // OpenRouter `web_search_options` body field
        "max_results": 5,
        "engine": "native"
      }
    },

    // One override shared by several models via a comma-separated key.
    "openai/gpt-5*, openai/gpt-5-mini*": {
      "provider": {
        "sort": "throughput"                    // override `sort`; keeps the rest of `provider`
      },
      "models": [                               // OpenRouter `models` fallback chain
        "google/gemini-3.1-pro",
        "anthropic/claude-sonnet-4-5"
      ]
    },

    // A single model, matching only the named variant.
    "anthropic/claude-sonnet-4-5#high": {
      "provider": {
        "data_collection": "deny",              // only providers that don't store data
        "zdr": true,                            // only Zero Data Retention endpoints
        "max_price": { "completion": "15", "prompt": "3" } // hard price ceiling
      },
      "plugins": [                              // OpenRouter `plugins` body field
        { "id": "response-healing" }
      ]
    }
  }
}
```

Cross-model routing with `partition: "none"` combines a `models` fallback chain with a `provider.sort` across all candidate models:

```jsonc
"openai/gpt-5*": {
  "models": [ "openai/gpt-5", "google/gemini-3.1-pro" ],
  "provider": { "sort": { "by": "throughput", "partition": "none" } }
}
```

## Debugging

Set `TRACE` to `true` in `openrouter-params.ts`:

```ts
const TRACE = true
```

With tracing enabled, the plugin registers the native `http.request` and `http.response` hooks and writes **one JSON line per request** to `/tmp/opencode/openrouter-params/index.jsonl`. Each line correlates the outgoing request body with the response body (HTTP status, chosen provider, usage, elapsed time). Correlation is by a hash of the outgoing body, and the response stream is tee'd so OpenCode consumes it untouched. Any field larger than 4 KB (conversation and tool content) is replaced with `"filtered"` to keep lines readable.

```json
{
  "ts": "2026-10-13T17:54:22.248Z",
  "sessionID": "ses_…",
  "agent": "build",
  "kind": null,
  "model": { "id": "deepseek/deepseek-v4.1-flash", "providerID": "openrouter", "variant": "focused" },
  "matchedKeys": ["*", "deepseek/*"],
  "merged": true,
  "request": {
    "url": "https://openrouter.ai/api/v1/chat/completions",
    "body": {
      "model": "deepseek/deepseek-v4.1-flash",
      "messages": "filtered",
      "tools": "filtered",
      "provider": { "sort": "throughput", "preferred_min_throughput": { "p90": 100 }, "preferred_max_latency": { "p90": 3 } },
      "max_tokens": 10000,
      "temperature": 0.7
    },
    "bodyLength": 123456
  },
  "response": {
    "status": 200,
    "body": {
      "id": "gen-…",
      "model": "deepseek/deepseek-v4.1-flash",
      "choices": "filtered",
      "usage": { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 },
      "provider": "together"
    },
    "elapsedMs": 1234
  },
  "error": null
}
```

`request.body` and `response.body` hold every field of the request/response, so any parameter is captured without code changes. `response.body.provider` is OpenRouter's chosen upstream supplier and `response.body.usage` the token accounting (both on the final streamed chunk). When no downstream body is present (e.g. a non-streaming or error path), `response.body` is `{}` and `error` carries the reason.

With `TRACE` false, none of the `http.*` hooks are registered and no file is written — runtime overhead is zero.

## Limitations and future work

- **Per-kind filtering is future work.** The policy currently applies uniformly to `context`, `title`, `compaction`, and `generate`. A `"kinds"` allow-list (e.g. to keep cheap title requests price-first) is planned but not yet implemented.
- **OpenCode type lag.** OpenCode's own OpenRouter provider type does not yet declare `enforce_distillable_text`, the object form of `sort`, or `preferred_min_throughput`/`preferred_max_latency`. They still reach OpenRouter because the plugin forwards the options verbatim, but OpenCode's config surface has not caught up.

## License

MIT. See [LICENSE](../LICENSE).