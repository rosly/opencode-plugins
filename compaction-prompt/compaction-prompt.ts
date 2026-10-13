// Copyright (c) 2026 Radoslaw Biernacki <radoslaw.biernacki@gmail.com>
// SPDX-License-Identifier: MIT
//
// Compaction prompt replacement plugin for OpenCode.
//
// It registers the session "http.request" hook, acts only on compaction
// requests, locates the built-in compaction instruction, and replaces it with
// the contents of a user-editable prompt file.
//
// Prompt files:
//   ~/.config/opencode/prompts/compaction_create.md  (first compaction)
//   ~/.config/opencode/prompts/compaction_update.md  (subsequent compactions)
//
// If the matching file is missing or unreadable, the request is left untouched.
//
// Two OpenAI wire formats are handled:
//   - Chat Completions: body.messages[], item.content is a string.
//   - Responses:        body.input[],    item.content is an array of parts.
//
// Selection rule: scan the message array from the end and pick the first user
// message whose text both starts with a create/update marker and ends with the
// end marker. This excludes conversation history that merely quotes the prompt
// and also finds the prompt on a validation-retry request.
//
// Observation log: /tmp/opencode/compaction-prompt/<timestamp>-<sessionID>.json
//                  /tmp/opencode/compaction-prompt/index.jsonl

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const PROMPT_DIR = join(homedir(), ".config", "opencode", "prompts")
const LOG_DIR = "/tmp/opencode/compaction-prompt"

// Observation logging is disabled by default so the plugin writes no files
// during normal use. Set TRACE to true to write captures to LOG_DIR when
// debugging the selection or replacement logic.
const TRACE = false

const CREATE_MARKER =
  "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work."
const UPDATE_MARKER = "Update the existing checkpoint in the conversation above into one consolidated summary."
const END_MARKER = "Do not include a preamble, explanation, or other commentary."

type Selection = {
  format: "chat" | "responses"
  arrayPath: "messages" | "input"
  index: number
  partIndex: number | null
  variant: "create" | "update"
  text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function variantOf(value: string): "create" | "update" | undefined {
  if (value.startsWith(CREATE_MARKER)) return "create"
  if (value.startsWith(UPDATE_MARKER)) return "update"
  return undefined
}

function selectPrompt(parsed: unknown): Selection | undefined {
  if (!isRecord(parsed)) return undefined

  const arrays: Array<{ format: "chat" | "responses"; key: "messages" | "input" }> = []
  if (Array.isArray(parsed.messages)) arrays.push({ format: "chat", key: "messages" })
  if (Array.isArray(parsed.input)) arrays.push({ format: "responses", key: "input" })

  for (const { format, key } of arrays) {
    const items = parsed[key] as unknown[]
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]
      if (!isRecord(item) || item.role !== "user") continue

      if (format === "chat") {
        if (typeof item.content !== "string") continue
        const variant = variantOf(item.content)
        if (variant === undefined || !item.content.endsWith(END_MARKER)) continue
        return { format, arrayPath: key, index, partIndex: null, variant, text: item.content }
      }

      if (item.type !== "message" || !Array.isArray(item.content)) continue
      const parts = item.content
      const text = parts
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("")
      const variant = variantOf(text)
      if (variant === undefined || !text.endsWith(END_MARKER)) continue
      const partIndex = parts.findIndex(
        (part) => isRecord(part) && typeof part.text === "string" && variantOf(part.text) !== undefined,
      )
      return { format, arrayPath: key, index, partIndex: partIndex >= 0 ? partIndex : null, variant, text }
    }
  }
  return undefined
}

function applyReplacement(parsed: unknown, selection: Selection, replacement: string): boolean {
  if (!isRecord(parsed)) return false
  const items = parsed[selection.arrayPath]
  if (!Array.isArray(items)) return false
  const item = items[selection.index]
  if (!isRecord(item)) return false

  if (selection.format === "chat") {
    item.content = replacement
    return true
  }

  if (!Array.isArray(item.content) || selection.partIndex === null) return false
  const part = item.content[selection.partIndex]
  if (!isRecord(part) || typeof part.text !== "string") return false
  part.text = replacement
  return true
}

export default {
  id: "compaction-prompt",
  async setup(ctx: {
    session: {
      hook: (
        name: "http.request",
        callback: (event: {
          sessionID: string
          agent: string
          model: { providerID: string; id: string; variant?: string }
          kind: string
          request: Request
        }) => Promise<void> | void,
      ) => Promise<unknown>
    }
  }) {
    if (TRACE) await mkdir(LOG_DIR, { recursive: true })

    await ctx.session.hook("http.request", async (event) => {
      if (event.kind !== "compaction") return

      const timestamp = new Date().toISOString()
      const body = await event.request.clone().text()

      const record: Record<string, unknown> = {
        timestamp,
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        url: event.request.url,
        bodyLength: body.length,
        selection: null,
        promptFile: null,
        fileFound: false,
        modified: false,
        originalText: null,
        replacementText: null,
        error: null,
      }

      try {
        const parsed = JSON.parse(body)
        const selection = selectPrompt(parsed)
        if (selection === undefined) {
          record.error = "compaction prompt not found"
        } else {
          record.selection = {
            format: selection.format,
            arrayPath: selection.arrayPath,
            index: selection.index,
            partIndex: selection.partIndex,
            variant: selection.variant,
            textLength: selection.text.length,
          }
          record.originalText = selection.text

          const promptFile = join(PROMPT_DIR, `compaction_${selection.variant}.md`)
          record.promptFile = promptFile

          let replacement: string | undefined
          try {
            replacement = await readFile(promptFile, "utf8")
            record.fileFound = true
          } catch (error) {
            record.error = `prompt file unavailable: ${error instanceof Error ? error.message : String(error)}`
          }

          if (replacement !== undefined) {
            record.replacementText = replacement
            if (applyReplacement(parsed, selection, replacement)) {
              const headers = new Headers(event.request.headers)
              headers.delete("content-length")
              event.request = new Request(event.request.url, {
                method: event.request.method,
                headers,
                body: JSON.stringify(parsed),
              })
              record.modified = true
            } else {
              record.error = "replacement target could not be applied"
            }
          }
        }
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error)
      }

      if (TRACE) {
        const file = join(LOG_DIR, `${Date.now()}-${event.sessionID}.json`)
        await writeFile(file, JSON.stringify(record, null, 2))
        await appendFile(
          join(LOG_DIR, "index.jsonl"),
          JSON.stringify({
            timestamp,
            sessionID: event.sessionID,
            model: event.model,
            variant: record.selection === null ? null : (record.selection as { variant: string }).variant,
            promptFile: record.promptFile,
            fileFound: record.fileFound,
            modified: record.modified,
            error: record.error,
            file,
          }) + "\n",
        )
      }
    })
  },
}
