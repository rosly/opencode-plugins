// Copyright (c) 2026 Radoslaw Biernacki <radoslaw.biernacki@gmail.com>
// SPDX-License-Identifier: MIT
//
// provider-cost-tracer — generic HTTP request/response logger for OpenCode.
//
// Registers the native `http.request` and `http.response` hooks (provider
// agnostic) and writes one normalized JSON record per model request to a JSONL
// file. Each record captures provider, model, input/output tokens, cache reuse,
// and cost. Compatible with OpenRouter and OpenAI for now; other response
// shapes can be added by extending `normalize`. It also registers a
// `provider_cost_trace` tool that reads the log back so an agent (or the
// /or-usage command) can report it.
//
// Log: /tmp/opencode/provider-cost-tracer/index.jsonl

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"

const LOG_DIR = "/tmp/opencode/provider-cost-tracer"
const LOG_FILE = join(LOG_DIR, "index.jsonl")
const DEFAULT_LIMIT = 10

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null
}

// Normalize a Chat Completions response chunk into the flat fields we report.
// OpenRouter and OpenAI share prompt_tokens/completion_tokens and
// prompt_tokens_details.cached_tokens; provider and cost are OpenRouter-only.
function normalize(body: Record<string, unknown>) {
  const usage = isRecord(body.usage) ? body.usage : {}
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  return {
    provider: typeof body.provider === "string" ? body.provider : null,
    model: typeof body.model === "string" ? body.model : null,
    input_tokens: asNumber(usage.prompt_tokens),
    output_tokens: asNumber(usage.completion_tokens),
    cache_read_tokens: asNumber(promptDetails.cached_tokens),
    cache_write_tokens: asNumber(promptDetails.cache_write_tokens),
    cost: asNumber(usage.cost),
  }
}

// Extract the final object from a streamed Chat Completions response body (the
// last SSE `data:` chunk carries the accumulated usage), falling back to
// parsing the whole body as JSON for non-streaming responses.
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
  if (sawData) return last
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

    await ctx.session.hook("http.request", async (event) => {
      const model = readModel(event)
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