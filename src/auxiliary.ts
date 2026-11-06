// Side requests use the same authorized Fusion transport, never a free provider.
import { FusionError } from "./fusion"
export const AUXILIARY_OUTPUT_LIMIT = 8_000
export type RequestKind = "primary" | "title" | "generate" | "compaction" | "small_model" | "summary" | "summarize"
export const isAuxiliary = (kind?: RequestKind) => !!kind && kind !== "primary"
export const auxiliaryKind = (kind?: RequestKind) => kind === "title" || kind === "compaction" ? kind : "generate"
export const auxiliarySession = (sessionID: string, kind?: RequestKind) => `${sessionID}.aux.${auxiliaryKind(kind)}`
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const textOnly = (parts: unknown) => Array.isArray(parts) ? parts.filter(p => record(p) && (p.type === "input_text" || p.type === "output_text")) : parts
export function prepareAuxiliaryBody(body: Record<string, unknown>, kind?: RequestKind): Record<string, unknown> {
  // A separate contributor cannot consume the primary donor's encrypted reasoning.
  const input = Array.isArray(body.input) ? body.input.filter(i => record(i) && i.type !== "reasoning").map(i => {
    if ("content" in i) return { ...i, content: textOnly(i.content) }
    if (Array.isArray(i.output)) return { ...i, output: textOnly(i.output) }
    return i
  }) : body.input
  if (typeof input !== "string" && !Array.isArray(input)) throw new FusionError("Auxiliary request has no text input")
  const requested = typeof body.max_output_tokens === "number" && Number.isFinite(body.max_output_tokens) ? body.max_output_tokens : AUXILIARY_OUTPUT_LIMIT
  return { input, instructions: body.instructions, stream: body.stream ?? true, store: false,
    max_output_tokens: Math.max(1, Math.min(requested, kind === "title" ? 512 : AUXILIARY_OUTPUT_LIMIT)), reasoning: { effort: "low" } }
}
