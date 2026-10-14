# provider-cost-tracer

Generic HTTP request/response logger for OpenCode. It captures every provider's
model traffic into one normalized JSON record per request, then exposes that
record through a tool, a slash command, and a bash script.

## What it captures

One JSON line per request in `/tmp/opencode/provider-cost-tracer/index.jsonl`:

| Field | Meaning |
| --- | --- |
| `providerID` | The OpenCode provider (`openrouter`, `openai`, …). |
| `model` | The requested model id. |
| `response.provider` | The upstream supplier (OpenRouter only; `null` for OpenAI). |
| `response.input_tokens` | Prompt tokens. |
| `response.output_tokens` | Completion tokens. |
| `response.cache_read_tokens` | Prompt tokens read from cache. |
| `response.cache_write_tokens` | Prompt tokens written to cache. |
| `response.cost` | Credit cost (OpenRouter only; `null` for OpenAI). |

OpenRouter and OpenAI share the `usage.prompt_tokens` / `usage.completion_tokens`
and `usage.prompt_tokens_details.cached_tokens` shape, so the logger normalizes
both into the same fields. `provider` and `cost` are OpenRouter-only.

## How it works

The plugin registers the native `http.request` and `http.response` hooks. On
every model request it captures the request metadata; on the response it tees
the stream, reads the final chunk (which carries the accumulated `usage`), and
writes one JSON line. The response stream is passed through to OpenCode
untouched.

It also registers a `provider_cost_trace` tool that reads the last N records.

## Installation

```sh
mkdir -p ~/.config/opencode/plugins ~/.config/opencode/commands ~/.config/opencode/tools
cp provider-cost-tracer.ts ~/.config/opencode/plugins/
cp config/opencode/commands/or-usage.md ~/.config/opencode/commands/
cp config/opencode/tools/provider-cost-tracer.sh ~/.config/opencode/tools/
chmod +x ~/.config/opencode/tools/provider-cost-tracer.sh
opencode service restart
```

## Usage

In the TUI, run `/or-usage` (asks the agent to call the `provider_cost_trace`
tool). From a terminal, run:

```sh
~/.config/opencode/tools/provider-cost-tracer.sh              # last 10 + cost/cache summary
~/.config/opencode/tools/provider-cost-tracer.sh 40           # last 40 + cost/cache summary
~/.config/opencode/tools/provider-cost-tracer.sh --total_cost # cost/cache by provider, whole log
~/.config/opencode/tools/provider-cost-tracer.sh --reset      # clear the log
```

The default output prints the last N records (aligned columns) followed by a
summary of cost, input/output tokens, and cache reuse over those N, grouped by
provider with a sub-row per model and a grand TOTAL. `--total_cost` instead
summarizes every entry in the log.

## Limitations

- OpenAI streaming only returns `usage` in the final chunk when the client
  requests `include_usage`. If OpenCode does not, OpenAI token/cache columns
  will be empty. OpenRouter always includes usage.
- Requests are captured for every provider, so cost is only populated where the
  provider returns it (OpenRouter).

## License

MIT. See [LICENSE](../LICENSE).