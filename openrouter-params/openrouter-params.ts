// Copyright (c) 2026 Radoslaw Biernacki <radoslaw.biernacki@gmail.com>
// SPDX-License-Identifier: MIT
//
// OpenRouter parameter-control plugin for OpenCode.
//
// It reads preferences from a JSON file and injects them as OpenRouter options
// on every model request the session issues. Preferences cover the full
// OpenRouter request surface: the `provider` routing object (which suppliers
// receive a request and how they are ranked), `reasoning`, `models` fallbacks,
// `plugins`, `usage`, `web_search_options`, and any other passthrough key
// OpenRouter accepts in the Chat Completions body. `provider` is one sibling
// among the rest and is kept as-is (OpenRouter requires those fields nested
// under `provider`).
//
// Config layout. The file holds a single top-level `model` map. Each key is a
// matcher (prefix wildcard `anthropic/*`, full glob with `*`/`?`, a
// comma-separated list of patterns, or a literal slug including an optional
// variant `id#variant`), and each value is an override set applied to every
// model the key matches. Entries are processed top-to-bottom; every match is
// deep-merged over the accumulated result so later matches overwrite earlier
// ones per-key. `"*"` has no special meaning — its position in the map decides
// whether it acts as a baseline (first) or an always-on fallback (last).
//
// Mechanism. The session `context` hook exposes `event.options`. OpenCode
// splits that object: keys that are generation settings become generation
// options, and every other key becomes a provider option forwarded to the
// selected protocol. For the OpenRouter route these keys are lifted into the
// Chat Completions request body verbatim (see `bodyOptions` in
// packages/ai/src/providers/openrouter.ts). No raw HTTP rewriting is required.
//
// Each request kind a session issues runs its own hook. `context` covers the
// agent loop; `title`, `compaction`, and `generate` cover the auxiliary
// requests. All four share the `options` passthrough, so the same merge is
// applied to every kind unless filtered.
//
// Debugging capture (only when TRACE is true). The plugin also registers the
// native `http.request` and `http.response` hooks to observe the final outgoing
// body and the response outcome. Each request writes a single self-contained
// JSON line to /tmp/opencode/openrouter-params/index.jsonl, correlating the
// request body with the response body by hashing the outgoing body. Large
// fields (conversation/tool content) are replaced with "filtered" so the line
// stays readable. The response stream is tee'd so OpenCode still receives it
// untouched.
//
// Policy file: ~/.config/opencode/openrouter-params.json
// Example:
//   {
//     "model": {
//       "*": { "provider": { "allow_fallbacks": true } },
//       "openai/*": { "provider": { "sort": "throughput" } },
//       "openai/gpt-5, openai/gpt-5-mini": { "provider": { "quantizations": ["fp8"] } }
//     }
//   }
//
// If the file is missing, empty, or unreadable, requests are left untouched.
//
// Observation log: /tmp/opencode/openrouter-params/index.jsonl

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

const POLICY_FILE = join(homedir(), ".config", "opencode", "openrouter-params.json")
const LOG_DIR = "/tmp/opencode/openrouter-params"
const LOG_FILE = join(LOG_DIR, "index.jsonl")

// Observation logging is disabled by default so the plugin writes no files
// during normal use. Set TRACE to true to capture request/response records to
// LOG_FILE when debugging which options were injected and how OpenRouter routed
// each request.
const TRACE = false

// Request kinds that the session emits. Each maps to a distinct hook name, but
// every one carries the same `options` passthrough object.
const HOOK_NAMES = ["context", "title", "compaction", "generate"] as const

// Fields whose serialized JSON exceeds this many bytes are replaced with
// FILTERED in the trace, so conversation and tool content stay out of the log.
const MAX_FIELD_BYTES = 4096
const FILTERED = "filtered"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Replace the value of any top-level field larger than MAX_FIELD_BYTES with
// FILTERED, keeping the key so the trace still shows which fields were present.
// Applied to both the outgoing request body and the response chunk.
function withFiltered(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    let size = 0
    try {
      size = JSON.stringify(value).length
    } catch {
      size = Number.MAX_SAFE_INTEGER
    }
    out[key] = size > MAX_FIELD_BYTES ? FILTERED : value
  }
  return out
}

// Deep-merge `overrides` onto `base`, returning a new object. Scalar values and
// arrays are replaced, and plain-object values are merged recursively, so a
// later entry only overrides the nested fields it mentions.
function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value)
    } else {
      result[key] = value
    }
  }
  return result
}

// Compile a glob pattern (supporting `*` and `?`) into a RegExp anchored to
// the whole input. Every other character matches literally.
function globToRegExp(pattern: string): RegExp {
  let source = ""
  for (const char of pattern) {
    if (char === "*") source += ".*"
    else if (char === "?") source += "."
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

const compilePattern = (pattern: string): RegExp => globToRegExp(pattern.trim())

// A key is one pattern or a comma-separated list of patterns. Order within a
// list is irrelevant; the entry applies once if any pattern matches.
function keyMatches(key: string, slug: string): boolean {
  return key
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .some((pattern) => compilePattern(pattern).test(slug))
}

// Read the `model` map out of the parsed config. Entry order is preserved via
// an array of [key, value] pairs so top-to-bottom precedence is deterministic
// regardless of how object key order is treated elsewhere.
function policyOf(parsed: unknown): ReadonlyArray<readonly [string, Record<string, unknown>]> {
  if (!isRecord(parsed) || !isRecord(parsed.model)) return []
  return Object.entries(parsed.model).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
  )
}

const hashBody = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16)

// Shared shape for the model ref carried by every hook event.
interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

// The partial record captured at `http.request`, keyed by body hash so the
// `http.response` hook can join the outcome onto the same line.
interface PendingRequest {
  ts: string
  sessionID: string
  agent?: string
  model: ModelRef
  kind?: string
  matchedKeys: string[]
  merged: boolean
  url: string
  body: Record<string, unknown>
  bodyLength: number
}

export default {
  id: "openrouter-params",
  async setup(ctx: {
    session: {
      hook: (
        name: (typeof HOOK_NAMES)[number] | "http.request" | "http.response",
        callback: (event: any) => Promise<void> | void,
      ) => Promise<unknown>
    }
  }) {
    if (TRACE) await mkdir(LOG_DIR, { recursive: true })

    let policy: ReadonlyArray<readonly [string, Record<string, unknown>]> = []
    try {
      policy = policyOf(JSON.parse(await readFile(POLICY_FILE, "utf8")))
    } catch {
      // Missing, empty, or invalid policy file: leave requests untouched.
      policy = []
    }

    // In-memory join between the outgoing request and its response, keyed by a
    // hash of the request body. Only populated when TRACE is true.
    const pending = new Map<string, PendingRequest>()

    const resolveOverrides = (model: ModelRef): { matchedKeys: string[]; resolved: Record<string, unknown> } => {
      const slug = model.variant ? `${model.id}#${model.variant}` : model.id
      let resolved: Record<string, unknown> = {}
      const matchedKeys: string[] = []
      for (const [key, overrides] of policy) {
        if (!keyMatches(key, slug)) continue
        resolved = deepMerge(resolved, overrides)
        matchedKeys.push(key)
      }
      return { matchedKeys, resolved }
    }

    const appendLog = async (record: unknown): Promise<void> => {
      await appendFile(LOG_FILE, JSON.stringify(record) + "\n")
    }

    // Application hook: inject routing options into the model request.
    const apply = async (event: {
      sessionID: string
      agent?: string
      model: ModelRef
      kind?: string
      options: Record<string, unknown>
    }) => {
      if (event.model.providerID !== "openrouter") return

      const { matchedKeys, resolved } = resolveOverrides(event.model)
      if (Object.keys(resolved).length > 0) {
        event.options = deepMerge(event.options, resolved)
      }
      // matchedKeys are needed later; stash them on the request body hash so the
      // native-request capture can report them. We re-resolve in http.request
      // from the final body below, so nothing else is carried here.
    }

    if (TRACE) {
      // Native outgoing request: capture the final lowered body.
      await ctx.session.hook("http.request", async (event) => {
        if (event.model?.providerID !== "openrouter") return
        const ts = new Date().toISOString()
        const body = await event.request.clone().text()
        const key = hashBody(body)
        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(body)
        } catch {
          // Non-JSON body; record what we can.
        }
        const { matchedKeys, resolved } = resolveOverrides(event.model)
        const model = event.model as ModelRef
        const kind = event.kind
        const sessionID = event.sessionID as string
        const agent = event.agent as string | undefined
        pending.set(key, {
          ts,
          sessionID,
          agent,
          model,
          kind,
          matchedKeys,
          merged: Object.keys(resolved).length > 0,
          url: event.request.url,
          body: withFiltered(parsed),
          bodyLength: body.length,
        })
      })

      // Native response: tee the stream, read usage/provider from the final
      // chunk, and write one consolidated line.
      await ctx.session.hook("http.response", async (event) => {
        if (event.model?.providerID !== "openrouter") return
        const started = Date.now()
        const requestBody = await event.request.clone().text()
        const key = hashBody(requestBody)
        const pendingReq = pending.get(key)
        pending.delete(key)

        const base = pendingReq ?? {
          ts: new Date().toISOString(),
          sessionID: event.sessionID,
          agent: event.agent,
          model: event.model,
          kind: event.kind,
          matchedKeys: [],
          merged: false,
          url: event.request.url,
          body: {},
          bodyLength: requestBody.length,
        }

        const record: Record<string, unknown> = {
          ts: base.ts,
          sessionID: base.sessionID,
          agent: base.agent,
          model: base.model,
          kind: base.kind ?? null,
          matchedKeys: base.matchedKeys,
          merged: base.merged,
          request: {
            url: base.url,
            body: base.body,
            bodyLength: base.bodyLength,
          },
          response: { status: event.response.status },
          error: null,
        }

        try {
          const stream = event.response.body
          if (stream === null) {
            record.response = {
              status: event.response.status,
              body: {},
              elapsedMs: Date.now() - started,
            }
            await appendLog(record)
          } else {
            const [left, right] = stream.tee()
            // Pass one branch onward untouched for OpenCode.
            event.response = new Response(left, {
              status: event.response.status,
              headers: event.response.headers,
            })
            // Accumulate the other branch in the background.
            void (async () => {
              const text = await new Response(right).text()
              ;(record.response as Record<string, unknown>) = {
                status: event.response.status,
                body: withFiltered(responseObject(text)),
                elapsedMs: Date.now() - started,
              }
              await appendLog(record)
            })().catch((error) => {
              ;(record.response as Record<string, unknown>) = {
                status: event.response.status,
                error: error instanceof Error ? error.message : String(error),
                elapsedMs: Date.now() - started,
              }
              return appendLog(record)
            })
          }
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error)
          await appendLog(record)
        }
      })
    }

    for (const name of HOOK_NAMES) {
      await ctx.session.hook(name, apply)
    }
  },
}

// Extract the final object from a streamed Chat Completions response body.
// OpenRouter streams server-sent events whose `data:` lines carry one JSON
// object per chunk; the last object (with a finish_reason) holds the chosen
// `provider` and the accumulated `usage`. Falls back to parsing the whole body
// as JSON for non-streaming (e.g. error) responses.
function responseObject(text: string): Record<string, unknown> {
  let last: Record<string, unknown> = {}
  let sawData = false
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    sawData = true
    const payload = trimmed.slice(5).trim()
    if (payload === "[DONE]") continue
    let obj: unknown
    try {
      obj = JSON.parse(payload)
    } catch {
      continue
    }
    if (isRecord(obj)) last = obj
  }
  if (sawData) return last
  try {
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch {
    // not JSON
  }
  return {}
}