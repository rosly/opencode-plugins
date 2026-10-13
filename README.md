# opencode-plugins

Custom OpenCode plugins:

- **compaction-prompt** — replaces OpenCode's built-in session-compaction prompt with user-editable files. See [`compaction-prompt/README.md`](compaction-prompt/README.md).
- **openrouter-params** — injects an OpenRouter routing policy (supplier, latency, throughput, quantization, cost) into every model request. See [`openrouter-params/README.md`](openrouter-params/README.md).

## Layout

```text
compaction-prompt/
  compaction-prompt.ts           the plugin
  prompts/compaction_create.md   prompt for the first compaction
  prompts/compaction_update.md   prompt for subsequent compactions
openrouter-params/
  openrouter-params.ts           the plugin
  config/openrouter-params.json  sample routing policy
  README.md
```

## License

MIT. See [LICENSE](LICENSE).