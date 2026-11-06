import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import {
  DEFAULT_TIER,
  DEFAULT_UPSTREAM,
  FusionRouter,
  FUSION_OUTPUT_LIMIT,
  MODEL_ID,
  PROVIDER_ID,
  buildUpstreamRequest,
  extractInput,
  normalizeHttpResponse,
  prepareResponsesBody,
  upsertProvider,
  type ProviderEditor,
} from "./src/fusion"

import { prepareAuxiliaryBody, auxiliaryKind, auxiliarySession, isAuxiliary, type RequestKind } from "./src/auxiliary"

type ProviderRef = { providerID: string }
type RequestEvent = { kind?: RequestKind; sessionID: string; model: ProviderRef; request: Request }
type ResponseEvent = { kind?: RequestKind; sessionID: string; model: ProviderRef; request: Request; response: Response }
type HookOptions = { providerID?: string }

type Context = {
  readonly options: Readonly<Record<string, unknown>>
  readonly location: { readonly directory: string }
  readonly provider: { transform(editor: (value: ProviderEditor) => void): Promise<unknown>; reload?(): Promise<void> }
  readonly session: {
    hook(name: "compaction", callback: (event: { sessionID: string; model: ProviderRef }) => Promise<void> | void, options?: HookOptions): Promise<unknown>
    hook(name: "http.request", callback: (event: RequestEvent) => Promise<void> | void, options?: HookOptions): Promise<unknown>
    hook(name: "http.response", callback: (event: ResponseEvent) => Promise<void> | void, options?: HookOptions): Promise<unknown>
  }
}

const stringOption = (options: Readonly<Record<string, unknown>>, key: string) => {
  const value = options[key]
  return typeof value === "string" && value ? value : undefined
}

const numberOption = (options: Readonly<Record<string, unknown>>, key: string) => {
  const value = options[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const plugin = {
  id: PROVIDER_ID,
  setup: async (context: Context) => {
    const options = context.options ?? {}
    const upstream = stringOption(options, "upstream") ?? process.env.FUSION_UPSTREAM ?? DEFAULT_UPSTREAM
    const tier = stringOption(options, "tier") ?? process.env.FUSION_TIER ?? DEFAULT_TIER
    const timeoutMs = numberOption(options, "timeoutMs") ?? 120_000
    const configured = stringOption(options, "tokenFile") ?? process.env.FUSION_TOKEN_FILE
    const tokenFile = configured
      ? isAbsolute(configured)
        ? configured
        : resolve(context.location.directory, configured)
      : undefined
    const router = new FusionRouter({ token: "", upstream, tier, timeoutMs })
    const token = async () => {
      const environment = process.env.FUSION_ACCESS_TOKEN
      if (environment) return environment
      if (!tokenFile) throw new Error("Set tokenFile or FUSION_TOKEN_FILE for copilot-fusion-direct")
      const value: unknown = JSON.parse(await readFile(tokenFile, "utf8"))
      const root = typeof value === "object" && value !== null ? (value as { tokens?: unknown; access_token?: unknown }) : {}
      const tokens = typeof root.tokens === "object" && root.tokens !== null ? (root.tokens as { access_token?: unknown }) : undefined
      const access = (typeof tokens === "object" && tokens !== null ? tokens.access_token : undefined) ?? root.access_token
      if (typeof access !== "string" || !access) throw new Error("Token file has no tokens.access_token")
      return access
    }

    router.setToken(await token())
    let outputLimit = FUSION_OUTPUT_LIMIT
    await context.provider.transform((editor) => upsertProvider(editor, upstream, outputLimit))
    await context.session.hook("compaction", event => {
      if (event.model.providerID === PROVIDER_ID) {
        router.invalidateSession(event.sessionID)
        router.invalidateSession(auxiliarySession(event.sessionID, "compaction"))
      }
    }, { providerID: PROVIDER_ID })
    await context.session.hook(
      "http.request",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return
        let body: unknown
        try {
          body = await event.request.clone().json()
        } catch {
          return
        }
        if (typeof body !== "object" || body === null || (body as { model?: unknown }).model !== MODEL_ID) return
        const auxiliary = isAuxiliary(event.kind)
        const kind = auxiliary ? auxiliaryKind(event.kind) : "primary"
        const sessionID = auxiliary ? auxiliarySession(event.sessionID, event.kind) : event.sessionID
        const requestBody = auxiliary ? prepareAuxiliaryBody(body as Record<string, unknown>, event.kind) : body as Record<string, unknown>
        let input
        try { input = extractInput(requestBody) } catch (error) {
          if (!auxiliary) throw error
          input = { prompt: typeof requestBody.instructions === "string" ? requestBody.instructions.slice(0, 8000) : "Summarize this conversation.", hasImage: false }
        }
        const currentToken = await token()
        router.setToken(currentToken)
        const route = await router.route(sessionID, input.prompt, input.hasImage, kind)
        const selectedOutputLimit = route.selected_model.limits!.max_output_tokens
        if (!auxiliary && outputLimit !== selectedOutputLimit) {
          outputLimit = selectedOutputLimit
          await context.provider.reload?.()
        }
        event.request = buildUpstreamRequest(
          event.request,
          prepareResponsesBody(requestBody, route),
          route,
          currentToken,
          upstream,
          sessionID,
          router.reuse(route),
          kind,
        )
      },
      { providerID: PROVIDER_ID },
    )
    await context.session.hook(
      "http.response",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return
        const sessionID = isAuxiliary(event.kind) ? auxiliarySession(event.sessionID, event.kind) : event.sessionID
        if (!event.response.ok) router.invalidateSession(sessionID)
        event.response = await normalizeHttpResponse(event.response, () => router.invalidateSession(sessionID))
      },
      { providerID: PROVIDER_ID },
    )
    return () => router.clear()
  },
}

export default plugin
