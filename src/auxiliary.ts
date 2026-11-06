// Auxiliary calls retain the Fusion hook identity (and runner retry budget), but
// use the same non-Fusion free model as the runner's fallback chain. Console
// supports every text model through its Responses API as well as its native wire:
// https://opencode.ai/v2/docs/console/models/
import { FusionError } from "./fusion"

export const DEFAULT_AUXILIARY_UPSTREAM = "https://opencode.ai/inference/openai/v1"
export const DEFAULT_AUXILIARY_MODEL = "deepseek-v4.1-flash-free"
export const AUXILIARY_OUTPUT_LIMIT = 8_000
export type RequestKind = "primary" | "title" | "generate" | "compaction"
export const isAuxiliary = (kind?: RequestKind) => kind === "title" || kind === "generate" || kind === "compaction"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const textOnly = (parts: unknown) => Array.isArray(parts)
  ? parts.filter(part => record(part) && (part.type === "input_text" || part.type === "output_text"))
  : parts

export function buildAuxiliaryRequest(
  original: Request,
  body: Record<string, unknown>,
  options: { upstream: string; model: string; kind?: RequestKind; apiKey?: string },
): Request {
  // Do not transfer provider-specific encrypted reasoning or images to the
  // text-only auxiliary model. Keep conversation text and tool history intact.
  const input = Array.isArray(body.input) ? body.input.filter(item => record(item) && item.type !== "reasoning").map(item => {
    if (!record(item)) return item
    if ("content" in item) return { ...item, content: textOnly(item.content) }
    if (Array.isArray(item.output)) return { ...item, output: textOnly(item.output) }
    return item
  }) : body.input
  if (typeof input !== "string" && !Array.isArray(input)) throw new FusionError("Auxiliary request has no text input")
  const requested = typeof body.max_output_tokens === "number" ? body.max_output_tokens : AUXILIARY_OUTPUT_LIMIT
  const cap = options.kind === "title" ? 512 : AUXILIARY_OUTPUT_LIMIT
  // Never copy authorization, cookies, or Copilot headers onto another origin.
  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${options.apiKey ?? "public"}` })
  // This really is OpenCode; preserve its original client identity. Do not invent
  // a User-Agent when called outside OpenCode, or forward arbitrary headers.
  for (const key of ["user-agent", "x-opencode-client"]) {
    const value = original.headers.get(key)
    if (value) headers.set(key, value)
  }
  return new Request(`${options.upstream.replace(/\/+$/, "")}/responses`, {
    method: "POST", headers,
    body: JSON.stringify({
      model: options.model, input, instructions: body.instructions, stream: body.stream ?? true,
      store: false, max_output_tokens: Math.max(1, Math.min(requested, cap)),
    }),
    signal: original.signal,
  })
}
