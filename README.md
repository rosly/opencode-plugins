# opencode-plugins

Custom OpenCode plugins:
- **compaction-prompt**: replaces OpenCode's built-in session-compaction prompt with user-editable files.

## Goal

OpenCode compacts a long session by summarizing older conversation with a built-in prompt. That prompt is compiled into the OpenCode binary and cannot be changed through configuration. This plugin lets you define your own compaction prompt, stored as plain Markdown files, without modifying or rebuilding OpenCode.

The plugin changes **only the prompt text**. Everything else stays with OpenCode: when compaction runs, which history is summarized, which recent context is retained, model selection, generation, retries, output validation, and checkpoint storage.

## How it works

The plugin registers the session `http.request` hook and acts only on requests where `event.kind === "compaction"`. It reads the outgoing request body, finds the built-in compaction instruction, replaces it with the contents of the matching prompt file, and hands the modified request back to OpenCode.

### Technical decisions

- **Plugin, not a patched binary.** The installed OpenCode release is used as-is. The plugin is loaded from `~/.config/opencode/plugins/`.
- **Interception at the HTTP layer.** The high-level `compaction` hook runs *before* OpenCode appends its summary prompt, and exposes no field to replace that prompt. The `http.request` hook sees the final request, so the prompt can be swapped there.
- **Two OpenAI wire formats are handled.** OpenCode lowers requests to the provider protocol, and the prompt lands in different places:
  - **Chat Completions** (`messages[]`, `content` is a string) — e.g. DeepSeek, Ollama.
  - **Responses** (`input[]`, `content` is an array of parts) — e.g. OpenAI `gpt-6-astra`.
- **Strict selection rule.** The message array is scanned from the end for the first entry that is a `user` message whose text both **starts with** a create/update marker and **ends with** the end marker. This excludes conversation history that merely quotes the prompt text, and it also finds the prompt on a validation-retry request (where the prompt is second-to-last).
- **Fragment replacement.** The text from the beginning marker through the end marker is replaced. For the built-in prompt this fragment is the entire message text.
- **Missing file means no change.** If the matching prompt file is absent or unreadable, the request is left untouched.
- **Tracing is off by default.** A single `TRACE` flag in the source enables observation logging to `/tmp/opencode/compaction-prompt/`. Normal use writes no files.

### Markers

The plugin recognizes the built-in prompt by these exact strings:

- Create beginning: `You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.`
- Update beginning: `Update the existing checkpoint in the conversation above into one consolidated summary.`
- End (both): `Do not include a preamble, explanation, or other commentary.`

### Validation constraint

OpenCode requires the generated summary to contain at least one recognized template heading, such as `## Objective`. If it does not, OpenCode retries once and then fails the compaction. Custom prompts must keep at least one such heading.

## Files

```text
compaction-prompt.ts              the plugin
prompts/compaction_create.md      prompt for the first compaction
prompts/compaction_update.md      prompt for subsequent compactions
```

## Installation

1. Copy the plugin into the OpenCode plugin directory:

   ```sh
   mkdir -p ~/.config/opencode/plugins
   cp compaction-prompt.ts ~/.config/opencode/plugins/
   ```

2. Copy the prompt files into the OpenCode prompt directory:

   ```sh
   mkdir -p ~/.config/opencode/prompts
   cp prompts/compaction_create.md ~/.config/opencode/prompts/
   cp prompts/compaction_update.md ~/.config/opencode/prompts/
   ```

3. OpenCode reloads plugins from watched config directories automatically. If it does not pick up the change, restart the service:

   ```sh
   opencode service restart
   ```

## Configuration

Edit the prompt files in place; they are read on each compaction, so changes apply to the next one.

- `~/.config/opencode/prompts/compaction_create.md` — used when there is no previous checkpoint.
- `~/.config/opencode/prompts/compaction_update.md` — used when updating an existing checkpoint.

Keep the two files' templates consistent if you want a custom section to survive both first and subsequent compactions.

## Debugging

Set `TRACE` to `true` in `compaction-prompt.ts`:

```ts
const TRACE = false
```

With tracing enabled, each compaction request writes a JSON capture to `/tmp/opencode/compaction-prompt/` containing the selection (format, array path, index, part index, variant), the prompt file used, whether it was found, whether the request was modified, the original and replacement text, and any error. An `index.jsonl` summarizes each capture.

## Limitations

- The plugin targets the OpenAI Chat Completions and OpenAI Responses wire formats. Other protocols (Anthropic Messages, Gemini) are not handled.
- The selection rule depends on the built-in prompt's exact beginning and end markers. If OpenCode changes that wording, the markers must be updated.
- The plugin replaces the prompt only; it does not change when compaction runs or how history is selected.

## License

MIT. See [LICENSE](LICENSE).

