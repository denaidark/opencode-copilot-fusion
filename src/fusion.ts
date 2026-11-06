export const PROVIDER_ID = "copilot-fusion-direct"
export const MODEL_ID = "fusion"
export const DEFAULT_UPSTREAM = "https://api.githubcopilot.com"
export const DEFAULT_TIER = "balance"
// Igor-authorized 2026-11-06 probe: selected mai-code-1.1-flash catalog and
// /responses both report 128000. Parameter acceptance is not sustained-output evidence.
export const FUSION_OUTPUT_LIMIT = 128_000
// Preserve the existing conservative input window; reserve output separately so
// increasing the output cap cannot make OpenCode compact every turn.
export const FUSION_INPUT_LIMIT = 48_000

export class FusionError extends Error {}

export interface ModelSelection {
  id: string
  supported_endpoints?: string[]
  vision?: boolean
}

export interface InputAnalysis {
  prompt: string
  hasImage: boolean
}

const scanContent = (content: unknown, text?: string[]): boolean => {
  if (typeof content === "string") {
    text?.push(content)
    return false
  }
  if (!Array.isArray(content)) throw new FusionError("Expected text or image content parts")
  let hasImage = false
  for (const part of content) {
    if (!isRecord(part)) throw new FusionError("Expected text or image content parts")
    if (part.type === "input_text" || part.type === "text") {
      if (typeof part.text !== "string") throw new FusionError("Expected text content")
      text?.push(part.text)
      continue
    }
    if (part.type === "input_image") {
      if (typeof part.image_url !== "string" || !part.image_url) throw new FusionError("Expected an image URL")
      hasImage = true
      continue
    }
    throw new FusionError("This adapter supports text and image input only")
  }
  return hasImage
}

export interface FusionRoute {
  session_token: string
  selected_model: ModelSelection
  expires_at: number
  fallback?: boolean
}

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface RouterOptions {
  token: string
  upstream?: string
  tier?: string
  timeoutMs?: number
  maxRoutes?: number
  fetchImpl?: FetchImpl
  now?: () => number
}

export interface ProviderInfo {
  id: string
  name: string
  activation: "auto" | "enabled" | "disabled"
  package: string
  settings: Record<string, unknown>
}

export interface ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  package: string
  capabilities: { tools: boolean; input: string[]; output: string[] }
  variants: unknown[]
  time: { released: number }
  cost: unknown[]
  status: "active"
  enabled: boolean
  limit: { context: number; input: number; output: number }
}

export interface ProviderEditor {
  get(providerID: string): { provider: ProviderInfo; models: ReadonlyMap<string, ModelInfo> } | undefined
  add(input: { info: ProviderInfo; models: readonly ModelInfo[] }): void
  update(providerID: string, update: (provider: ProviderInfo) => void): void
  readonly models: { set(providerID: string, models: readonly ModelInfo[]): void }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function extractInput(body: unknown): InputAnalysis {
  if (!isRecord(body)) throw new FusionError("Expected a Responses request object")
  if (typeof body.input === "string") return { prompt: body.input, hasImage: false }
  if (!Array.isArray(body.input)) throw new FusionError("Expected text or a Responses input array")
  let prompt: string | undefined
  let hasImage = false
  for (const item of body.input) {
    if (!isRecord(item)) continue
    if (item.role === "user") {
      const text: string[] = []
      hasImage = scanContent(item.content, text) || hasImage
      prompt = text.length > 0 ? text.join("\n") : undefined
      continue
    }
    if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && Array.isArray(item.output)) {
      hasImage = scanContent(item.output) || hasImage
    }
  }
  if (prompt === undefined) {
    if (!hasImage) throw new FusionError("A user prompt is required to anchor Fusion routing")
    prompt = "Describe the attached image."
  }
  return { prompt, hasImage }
}

export function extractPrompt(body: unknown): string {
  return extractInput(body).prompt
}

export function prepareResponsesBody(body: Record<string, unknown>, route: FusionRoute): Record<string, unknown> {
  const include = Array.isArray(body.include)
    ? body.include.filter((value): value is string => typeof value === "string")
    : []
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content")
  const { temperature: _temperature, ...rest } = body
  return { ...rest, model: route.selected_model.id, store: false, include }
}

export function routeKey(sessionID: string): string {
  return sessionID
}

export class FusionRouter {
  readonly upstream: string
  readonly tier: string
  readonly timeoutMs: number
  readonly maxRoutes: number
  readonly fetchImpl: FetchImpl
  readonly now: () => number
  readonly routes = new Map<string, FusionRoute>()
  private token: string
  private readonly inflight = new Map<string, Promise<FusionRoute>>()
  private used = new WeakSet<FusionRoute>()

  constructor(options: RouterOptions) {
    this.token = options.token
    this.upstream = (options.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, "")
    this.tier = options.tier ?? DEFAULT_TIER
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxRoutes = options.maxRoutes ?? 256
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now() / 1000)
  }

  setToken(token: string) {
    if (this.token !== token) this.clear()
    this.token = token
  }

  clear() {
    this.routes.clear()
    // Detached /auto calls may finish, but cannot repopulate this cache.
    this.inflight.clear()
    this.used = new WeakSet()
  }

  invalidateSession(sessionID: string) {
    this.routes.delete(routeKey(sessionID))
    this.inflight.delete(routeKey(sessionID))
  }

  /** Claim the anchor exactly once, including callers joining the same /auto flight. */
  reuse(route: FusionRoute): boolean {
    const reused = this.used.has(route)
    this.used.add(route)
    return reused
  }

  async route(sessionID: string, prompt: string, hasImage = false): Promise<FusionRoute> {
    const key = routeKey(sessionID)
    this.prune()
    const pending = this.inflight.get(key)
    if (pending) {
      const selected = await pending
      // An image arriving during a text-only flight must not inherit a non-vision pick.
      return hasImage && selected.selected_model.vision !== true
        ? this.route(sessionID, prompt, true)
        : selected
    }
    const cached = this.routes.get(key)
    const compatible = !hasImage || cached?.selected_model.vision === true
    if (cached && compatible && cached.expires_at > this.now() + 30) return cached

    const promise = this.select(sessionID, prompt, hasImage, compatible ? cached : undefined).then(route => {
      if (this.inflight.get(key) === promise) {
        if (this.routes.size >= this.maxRoutes && !this.routes.has(key)) {
          const oldest = this.routes.keys().next().value
          if (oldest !== undefined) this.routes.delete(oldest)
        }
        this.routes.set(key, route)
      }
      return route
    }).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key)
    })
    this.inflight.set(key, promise)
    return promise
  }

  private async select(sessionID: string, prompt: string, hasImage: boolean, previous?: FusionRoute): Promise<FusionRoute> {
    const response = await this.fetchImpl(`${this.upstream}/auto`, {
      method: "POST",
      headers: this.headers(sessionID),
      body: JSON.stringify({
        prompt,
        has_image: hasImage,
        multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 },
        tier: this.tier,
        hydra_rl_multi_turn: {},
        fusion: true,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      // A short transient failure while refreshing must not break a still-valid conversation.
      // Never reuse expired, explicitly invalidated, or non-vision routes for image input.
      if ((response.status === 429 || response.status >= 500) && previous && previous.expires_at > this.now()) {
        await response.body?.cancel().catch(() => {})
        return previous
      }
      await response.body?.cancel().catch(() => {})
      throw new FusionError(`Copilot /auto returned HTTP ${response.status}`)
    }
    const value = await response.json().catch(() => {
      throw new FusionError("Copilot /auto returned invalid JSON")
    })
    if (!isRecord(value) || !isRecord(value.selected_model)) {
      throw new FusionError("Fusion returned no selected model")
    }
    const selected = value.selected_model
    const route: FusionRoute = {
      session_token: typeof value.session_token === "string" ? value.session_token : "",
      selected_model: {
        id: typeof selected.id === "string" ? selected.id : "",
        supported_endpoints: Array.isArray(selected.supported_endpoints)
          ? selected.supported_endpoints.filter((item): item is string => typeof item === "string")
          : [],
        vision:
          selected.vision === true ||
          (isRecord(selected.capabilities) &&
            isRecord(selected.capabilities.supports) &&
            selected.capabilities.supports.vision === true),
      },
      expires_at: typeof value.expires_at === "number" ? value.expires_at : 0,
      fallback: value.fallback === true,
    }
    if (!route.session_token || !route.selected_model.id) {
      throw new FusionError("Fusion returned no session token or model")
    }
    if (route.fallback || route.selected_model.id.startsWith("gpt-4.1")) {
      throw new FusionError("Refuse fallback or GPT-4.1 route")
    }
    if (!route.selected_model.supported_endpoints?.includes("/responses")) {
      throw new FusionError("Selected Fusion model does not support Responses; no fallback")
    }
    if (hasImage && route.selected_model.vision !== true) {
      throw new FusionError("Selected Fusion model does not support image input")
    }
    if (route.expires_at <= this.now() + 30) {
      throw new FusionError("Fusion returned no valid expiry")
    }
    return route
  }

  private prune() {
    const threshold = this.now()
    for (const [key, route] of this.routes) if (route.expires_at <= threshold) this.routes.delete(key)
  }

  private headers(sessionID: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Copilot-Integration-Id": "copilot-developer-cli",
      "User-Agent": "opencode-copilot-fusion/0.1",
      "X-GitHub-Api-Version": "2026-08-01",
      "OpenAI-Intent": "conversation-agent",
      "X-Initiator": "user",
      "X-Interaction-Id": sessionID,
      "X-Client-Session-Id": sessionID,
    }
  }
}

export function buildUpstreamRequest(
  original: Request,
  body: Record<string, unknown>,
  route: FusionRoute,
  token: string,
  upstream: string,
  sessionID: string,
  reused: boolean,
): Request {
  const headers = new Headers(original.headers)
  headers.delete("authorization")
  headers.delete("x-api-key")
  headers.delete("content-length")
  headers.delete("copilot-session-token")
  headers.set("authorization", `Bearer ${token}`)
  headers.set("content-type", "application/json")
  headers.set("accept", "application/json")
  headers.set("copilot-session-token", route.session_token)
  headers.set("copilot-integration-id", "copilot-developer-cli")
  headers.set("x-github-api-version", "2026-08-01")
  headers.set("openai-intent", "conversation-agent")
  headers.set("x-initiator", reused ? "agent" : "user")
  headers.set("x-interaction-id", sessionID)
  headers.set("x-client-session-id", sessionID)
  return new Request(new URL("/responses", upstream), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: original.signal,
  })
}

export interface IdSlot {
  id?: string
  call_id?: string
}

export function stableEvent(event: Record<string, unknown>, slots: Map<number, IdSlot>): Record<string, unknown> {
  const outputIndex = event.output_index
  if (typeof outputIndex === "number") {
    const slot = slots.get(outputIndex) ?? {}
    const item = event.item
    if (isRecord(item)) {
      if (typeof item.id === "string") item.id = (slot.id ??= item.id)
      if (typeof item.call_id === "string") item.call_id = (slot.call_id ??= item.call_id)
    }
    if (typeof event.item_id === "string") event.item_id = (slot.id ??= event.item_id)
    slots.set(outputIndex, slot)
  }
  const response = event.response
  if (isRecord(response) && Array.isArray(response.output)) {
    response.output.forEach((item, index) => {
      if (!isRecord(item)) return
      const slot = slots.get(index) ?? {}
      if (typeof item.id === "string") item.id = (slot.id ??= item.id)
      if (typeof item.call_id === "string") item.call_id = (slot.call_id ??= item.call_id)
      slots.set(index, slot)
    })
  }
  return event
}

export function normalizeSseFrame(lines: string[], slots: Map<number, IdSlot>, onFailure?: () => void): string {
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
  if (!data || data === "[DONE]") return lines.join("\n")
  let event: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(data)
    if (!isRecord(parsed)) return lines.join("\n")
    event = stableEvent(parsed, slots)
    if (event.type === "error" || event.type === "response.failed") onFailure?.()
  } catch {
    return lines.join("\n")
  }
  return [...lines.filter((line) => !line.startsWith("data:")), `data: ${JSON.stringify(event)}`].join("\n")
}

export function createStableSseStream(body: ReadableStream<Uint8Array>, onFailure?: () => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const slots = new Map<number, IdSlot>()
  let buffer = ""
  let frame: string[] = []
  const emit = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (frame.length === 0) return
    controller.enqueue(encoder.encode(`${normalizeSseFrame(frame, slots, onFailure)}\n\n`))
    frame = []
  }
  const line = (value: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (value.endsWith("\r")) value = value.slice(0, -1)
    if (value === "") return emit(controller)
    frame.push(value)
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        let newline = buffer.indexOf("\n")
        while (newline !== -1) {
          line(buffer.slice(0, newline), controller)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
        }
      },
      flush(controller) {
        buffer += decoder.decode()
        if (buffer) line(buffer, controller)
        emit(controller)
      },
    }),
  )
}

export async function normalizeHttpResponse(response: Response, onFailure?: () => void): Promise<Response> {
  if (!response.ok || response.status === 204 || response.status === 304 || !response.body) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    headers.set("cache-control", "no-cache")
    return new Response(createStableSseStream(response.body, onFailure), { status: response.status, headers })
  }
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return response
  const text = await response.clone().text()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return response
  }
  if (isRecord(value)) {
    stableEvent({ response: value }, new Map())
    if (value.status === "failed" || value.error) onFailure?.()
  }
  return new Response(JSON.stringify(value), { status: response.status, headers })
}

export function providerInfo(upstream = DEFAULT_UPSTREAM): ProviderInfo {
  return {
    id: PROVIDER_ID,
    name: "Copilot Fusion Direct",
    activation: "enabled",
    package: "@opencode/ai/providers/openai/responses",
    settings: { baseURL: upstream, apiKey: "opencode-fusion" },
  }
}

export function modelInfo(): ModelInfo {
  return {
    id: MODEL_ID,
    modelID: MODEL_ID,
    providerID: PROVIDER_ID,
    name: "Fusion Standard",
    package: "@opencode/ai/providers/openai/responses",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: FUSION_INPUT_LIMIT + FUSION_OUTPUT_LIMIT, input: FUSION_INPUT_LIMIT, output: FUSION_OUTPUT_LIMIT },
  }
}

export function upsertProvider(editor: ProviderEditor, upstream = DEFAULT_UPSTREAM) {
  if (editor.get(PROVIDER_ID)) {
    editor.update(PROVIDER_ID, (provider) => {
      provider.name = "Copilot Fusion Direct"
      provider.activation = "enabled"
      provider.package = "@opencode/ai/providers/openai/responses"
      provider.settings = { ...provider.settings, baseURL: upstream, apiKey: "opencode-fusion" }
    })
    editor.models.set(PROVIDER_ID, [modelInfo()])
    return
  }
  editor.add({ info: providerInfo(upstream), models: [modelInfo()] })
}
