// Copyright (c) 2026 Radoslaw Biernacki <radoslaw.biernacki@gmail.com>
// SPDX-License-Identifier: MIT
//
// provider-cost-tracer — generic request/response logger for OpenCode.
//
// Registers the native `http.request`/`http.response` hooks and the
// experimental `experimental.ws.*` hooks, and writes one normalized JSON record
// per model request to a JSONL file. Each record captures provider, model,
// input/output tokens, cache reuse, and cost. HTTP providers (OpenRouter,
// OpenAI-compatible) are observed over HTTP; OpenAI/xAI/Azure Responses are
// observed over their per-session WebSocket via its terminal
// `response.completed` frame. It also registers a `provider_cost_trace` tool
// that reads the log back so an agent (or the /or-usage command) can report it.
//
// Log: /tmp/opencode/provider-cost-tracer/index.jsonl

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"

const LOG_DIR = "/tmp/opencode/provider-cost-tracer"
const LOG_FILE = join(LOG_DIR, "index.jsonl")
const DEFAULT_LIMIT = 10

// Opt-in verbose evidence log (`debug.jsonl`). Off during normal use.
const DEBUG = false
const DEBUG_LOG = join(LOG_DIR, "debug.jsonl")
const MAX_FRAME_BYTES = 4096

const truncate = (text: string): string =>
  text.length > MAX_FRAME_BYTES ? text.slice(0, MAX_FRAME_BYTES) + `…(+${text.length - MAX_FRAME_BYTES})` : text

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null
}

// Normalize one response body into the flat fields we report. Chat Completions
// (OpenRouter and openai-compatible routes) and the Responses API (direct
// OpenAI) report tokens under different keys, so read either shape. `provider`
// and `cost` are OpenRouter-only.
function normalize(body: Record<string, unknown>) {
  const usage = isRecord(body.usage) ? body.usage : {}
  const details =
    isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details
    : isRecord(usage.input_tokens_details) ? usage.input_tokens_details
    : {}
  return {
    provider: typeof body.provider === "string" ? body.provider : null,
    model: typeof body.model === "string" ? body.model : null,
    input_tokens: asNumber(usage.prompt_tokens) ?? asNumber(usage.input_tokens),
    output_tokens: asNumber(usage.completion_tokens) ?? asNumber(usage.output_tokens),
    cache_read_tokens: asNumber(details.cached_tokens),
    cache_write_tokens: asNumber(details.cache_write_tokens),
    cost: asNumber(usage.cost),
  }
}

// Extract the final object from a streamed response body. Chat Completions
// carry the accumulated `usage` in the last SSE `data:` chunk; the Responses
// API carries it inside the final `response.completed` event's `response`
// sub-object. Falls back to parsing the whole body as JSON for non-streaming.
function responseObject(text: string): Record<string, unknown> {
  let last: Record<string, unknown> = {}
  let sawData = false
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    sawData = true
    const payload = trimmed.slice(5).trim()
    if (payload === "[DONE]") continue
    try {
      const obj = JSON.parse(payload)
      if (isRecord(obj)) last = obj
    } catch {
      // ignore malformed chunk
    }
  }
  if (sawData) {
    // The Responses API stream ends with a `response.completed` event whose
    // `response` sub-object carries the accumulated `usage`; Chat Completions
    // streams flat chunks instead. Unwrap the former so both reach `normalize`
    // as the same flat shape.
    return last.type === "response.completed" && isRecord(last.response)
      ? last.response
      : last
  }
  try {
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch {
    // not JSON
  }
  return {}
}

const hashBody = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16)

interface PendingRequest {
  ts: string
  sessionID?: string
  agent?: string
  kind?: string
  providerID?: string
  model?: string
  url: string
  bodyLength: number
}

function readModel(event: { model?: unknown }): { providerID: string; id: string } | undefined {
  const m = event.model
  if (isRecord(m) && typeof m.providerID === "string" && typeof m.id === "string") {
    return { providerID: m.providerID, id: m.id }
  }
  return undefined
}

export default {
  id: "provider-cost-tracer",
  async setup(ctx: {
    session: { hook: (name: string, callback: (event: any) => void | Promise<void>) => Promise<unknown> }
    tool: { transform: (callback: (editor: any) => void) => Promise<unknown> }
  }) {
    await mkdir(LOG_DIR, { recursive: true })

    const pending = new Map<string, PendingRequest>()

    const write = (record: Record<string, unknown>): Promise<void> => appendFile(LOG_FILE, JSON.stringify(record) + "\n")

    const debug = (record: Record<string, unknown>): Promise<void> =>
      DEBUG ? appendFile(DEBUG_LOG, JSON.stringify(record) + "\n") : Promise.resolve()

    const summarizeModel = (value: unknown): Record<string, unknown> | null => {
      if (!isRecord(value)) return null
      return {
        providerID: typeof value.providerID === "string" ? value.providerID : null,
        id: typeof value.id === "string" ? value.id : null,
        variant: typeof value.variant === "string" ? value.variant : null,
        keys: Object.keys(value),
      }
    }

    await ctx.session.hook("http.request", async (event) => {
      const model = readModel(event)
      if (DEBUG) {
        await debug({
          hook: "http.request",
          ts: new Date().toISOString(),
          sessionID: event.sessionID ?? null,
          agent: event.agent ?? null,
          kind: event.kind ?? null,
          model: summarizeModel(event.model),
          providerID: model?.providerID ?? null,
          modelID: model?.id ?? null,
          url: typeof event.request?.url === "string" ? event.request.url : null,
          eventKeys: Object.keys(event),
        })
      }
      if (!model) return
      const body = await event.request.clone().text()
      pending.set(hashBody(body), {
        ts: new Date().toISOString(),
        sessionID: event.sessionID,
        agent: event.agent,
        kind: event.kind,
        providerID: model.providerID,
        model: model.id,
        url: event.request.url,
        bodyLength: body.length,
      })
    })

    await ctx.session.hook("http.response", async (event) => {
      const started = Date.now()
      if (DEBUG) {
        await debug({
          hook: "http.response",
          ts: new Date().toISOString(),
          sessionID: event.sessionID ?? null,
          kind: event.kind ?? null,
          model: summarizeModel(event.model),
          url: typeof event.request?.url === "string" ? event.request.url : null,
          status: event.response?.status ?? null,
        })
      }
      const requestBody = await event.request.clone().text()
      const key = hashBody(requestBody)
      const req = pending.get(key)
      pending.delete(key)
      const model = readModel(event)

      const base = {
        ts: req?.ts ?? new Date().toISOString(),
        sessionID: event.sessionID ?? req?.sessionID,
        agent: event.agent ?? req?.agent,
        kind: event.kind ?? req?.kind ?? null,
        providerID: model?.providerID ?? req?.providerID ?? null,
        model: model?.id ?? req?.model ?? null,
        request: {
          url: req?.url ?? event.request.url,
          bodyLength: req?.bodyLength ?? requestBody.length,
        },
      }

      const writeRecord = (body: Record<string, unknown>, error: string | null): Promise<void> =>
        write({
          ...base,
          response: { status: event.response.status, ...normalize(body) },
          elapsedMs: Date.now() - started,
          error,
        })

      try {
        if (event.response.body === null) {
          await writeRecord({}, null)
          return
        }
        const [left, right] = event.response.body.tee()
        event.response = new Response(left, {
          status: event.response.status,
          headers: event.response.headers,
        })
        void (async () => {
          const text = await new Response(right).text()
          await writeRecord(responseObject(text), null)
        })().catch((error) => writeRecord({}, error instanceof Error ? error.message : String(error)))
      } catch (error) {
        await writeRecord({}, error instanceof Error ? error.message : String(error))
      }
    })

    // WebSocket capture. OpenAI (ChatGPT/Codex), xAI, and some Azure Responses
    // models stream over a per-session WebSocket that the `http.request` /
    // `http.response` hooks never observe. Capture the terminal
    // `response.completed` frame and emit the same normalized record the HTTP
    // path does, so the transport stays on WebSocket.
    const registerWsHook = async (name: string, callback: (event: any) => Promise<void>) => {
      try {
        await ctx.session.hook(name, callback)
      } catch (error) {
        await debug({
          hook: name,
          ts: new Date().toISOString(),
          registrationError: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // sessionID -> WebSocket endpoint URL, captured at handshake and reused to
    // annotate each completed turn's record.
    const wsSessions = new Map<string, string | undefined>()

    await registerWsHook("experimental.ws.handshake", async (event) => {
      if (typeof event.sessionID === "string") {
        wsSessions.set(event.sessionID, typeof event.url === "string" ? event.url : undefined)
      }
      await debug({
        hook: "ws.handshake",
        ts: new Date().toISOString(),
        sessionID: event.sessionID ?? null,
        agent: event.agent ?? null,
        kind: event.kind ?? null,
        model: summarizeModel(event.model),
        url: typeof event.url === "string" ? event.url : null,
        headerKeys: isRecord(event.headers) ? Object.keys(event.headers) : null,
        eventKeys: Object.keys(event),
      })
    })

    await registerWsHook("experimental.ws.send", async (event) => {
      const frame = typeof event.frame === "string" ? event.frame : JSON.stringify(event.frame ?? null)
      await debug({
        hook: "ws.send",
        ts: new Date().toISOString(),
        sessionID: event.sessionID ?? null,
        kind: event.kind ?? null,
        model: summarizeModel(event.model),
        eventKeys: Object.keys(event),
        frame: truncate(frame),
      })
    })

    await registerWsHook("experimental.ws.receive", async (event) => {
      const raw = typeof event.frame === "string" ? event.frame : JSON.stringify(event.frame ?? null)
      let parsed: Record<string, unknown> | null = null
      try {
        const obj = JSON.parse(raw)
        parsed = isRecord(obj) ? obj : null
      } catch {
        // truncated or non-JSON frame
      }
      const base = {
        hook: "ws.receive",
        ts: new Date().toISOString(),
        sessionID: event.sessionID ?? null,
        kind: event.kind ?? null,
        model: summarizeModel(event.model),
        frameType: parsed !== null && typeof parsed.type === "string" ? parsed.type : null,
      }
      if (parsed === null) {
        await debug({ ...base, raw: truncate(raw) })
        return
      }
      const resp = isRecord(parsed.response) ? parsed.response : {}
      await debug({
        ...base,
        keys: Object.keys(parsed),
        responseKeys: isRecord(parsed.response) ? Object.keys(parsed.response) : null,
        responseId: typeof resp.id === "string" ? resp.id : null,
        responseStatus: typeof resp.status === "string" ? resp.status : null,
        responseModel: typeof resp.model === "string" ? resp.model : null,
        usage: isRecord(resp.usage) ? resp.usage : null,
        timing: parsed.type === "responsesapi.websocket_timing" ? parsed : null,
      })

      if (parsed.type !== "response.completed") return
      const model = readModel(event)
      const created = asNumber(resp.created_at)
      const completed = asNumber(resp.completed_at)
      await write({
        ts: new Date().toISOString(),
        sessionID: event.sessionID ?? null,
        agent: event.agent ?? null,
        kind: event.kind ?? null,
        providerID: model?.providerID ?? null,
        model: model?.id ?? (typeof resp.model === "string" ? resp.model : null),
        request: {
          url: typeof event.sessionID === "string" ? (wsSessions.get(event.sessionID) ?? null) : null,
          bodyLength: null,
        },
        response: { status: resp.status === "completed" ? 200 : null, ...normalize(resp) },
        elapsedMs: created !== null && completed !== null ? (completed - created) * 1000 : null,
        error: null,
      })
    })

    const readRecords = async (limit: number): Promise<string> => {
      let lines: string[] = []
      try {
        lines = (await readFile(LOG_FILE, "utf8")).trim().split("\n").filter((l) => l.length > 0)
      } catch {
        return "No trace log found. A provider request has not been made since the plugin was enabled."
      }
      const rows = lines.slice(-limit).reverse().flatMap((line) => {
        let o: unknown
        try {
          o = JSON.parse(line)
        } catch {
          return []
        }
        if (!isRecord(o)) return []
        const resp = isRecord(o.response) ? o.response : {}
        return [{
          ts: typeof o.ts === "string" ? o.ts : "",
          model: typeof o.model === "string" ? o.model : "-",
          provider: typeof resp.provider === "string" ? resp.provider : (typeof o.providerID === "string" ? o.providerID : "-"),
          in: asNumber(resp.input_tokens) ?? 0,
          out: asNumber(resp.output_tokens) ?? 0,
          cache: asNumber(resp.cache_read_tokens) ?? 0,
          cost: asNumber(resp.cost),
        }]
      })
      if (rows.length === 0) return "No trace records yet."
      return rows.map((r) =>
        `${r.ts}  ${r.model}  ${r.provider}  in=${r.in} out=${r.out} cache=${r.cache}  cost=${r.cost ?? "-"}`
      ).join("\n")
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "provider_cost_trace",
        description: "Show the most recent provider requests: provider, model, input/output tokens, cache reuse, and cost.",
        input: {
          type: "object",
          properties: { limit: { type: "integer" } },
          additionalProperties: false,
        },
        execute: async (input: { limit?: number }) => {
          const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LIMIT
          return { content: await readRecords(limit) }
        },
      })
    })
  },
}