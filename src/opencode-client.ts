import type { PluginInput } from "@opencode-ai/plugin"
import type { CurationClient, CurationSession } from "./curation-service-types"

type Client = PluginInput["client"]

export class OpenCodeCurationClientError extends Error {
  readonly name = "OpenCodeCurationClientError"
  constructor(readonly operation: string, readonly detail: string) {
    super(`${operation} failed: ${detail}`)
  }
}

function detail(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function requireData<T>(operation: string, response: { readonly data: T | undefined; readonly error?: unknown }): T {
  if (response.data !== undefined) return response.data
  throw new OpenCodeCurationClientError(operation, detail(response.error))
}

function modelParts(model: string): { readonly providerID: string; readonly modelID: string } {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) throw new OpenCodeCurationClientError("model", "expected provider/model")
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
}

function session(value: CurationSession): CurationSession {
  return value.parentID === undefined ? { id: value.id, title: value.title } : { id: value.id, parentID: value.parentID, title: value.title }
}

export function createOpenCodeCurationClient(client: Client, directory: string): CurationClient {
  return {
    getSession: async (sessionID) => {
      const response = await client.session.get({ path: { id: sessionID }, query: { directory } })
      return response.data === undefined ? undefined : session(response.data)
    },
    createSession: async (parentID, title) => {
      const response = await client.session.create({ body: { parentID, title }, query: { directory } })
      return session(requireData("session.create", response))
    },
    promptAsync: async (sessionID, model, tools, text) => {
      const response = await client.session.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: { model: modelParts(model), agent: "memory-curator", tools: { ...tools }, parts: [{ type: "text", text }] },
      })
      if (response.error !== undefined) throw new OpenCodeCurationClientError("session.promptAsync", detail(response.error))
    },
    finalAssistant: async (sessionID) => {
      const response = await client.session.messages({ path: { id: sessionID }, query: { directory } })
      const messages = requireData("session.messages", response)
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.info.role !== "assistant") continue
        if (message.info.error !== undefined) return { error: `${message.info.error.name}: ${detail(message.info.error.data)}` }
        const text = message.parts.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("")
        return { text }
      }
      return {}
    },
    abort: async (sessionID) => {
      const response = await client.session.abort({ path: { id: sessionID }, query: { directory } })
      requireData("session.abort", response)
    },
    notify: async (message) => {
      const response = await client.tui.showToast({ body: { title: "Memory curation", message, variant: "info", duration: 8000 }, query: { directory } })
      requireData("tui.showToast", response)
    },
  }
}
