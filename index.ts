import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import {
  DEFAULT_TIER,
  DEFAULT_UPSTREAM,
  FusionRouter,
  MODEL_ID,
  PROVIDER_ID,
  buildUpstreamRequest,
  extractInput,
  normalizeHttpResponse,
  prepareResponsesBody,
  upsertProvider,
  type ProviderEditor,
} from "./src/fusion"

import { buildAuxiliaryRequest, DEFAULT_AUXILIARY_MODEL, DEFAULT_AUXILIARY_UPSTREAM, isAuxiliary, type RequestKind } from "./src/auxiliary"

type ProviderRef = { providerID: string }
type RequestEvent = { kind?: RequestKind; sessionID: string; model: ProviderRef; request: Request }
type ResponseEvent = { kind?: RequestKind; sessionID: string; model: ProviderRef; request: Request; response: Response }
type HookOptions = { providerID?: string }

type Context = {
  readonly options: Readonly<Record<string, unknown>>
  readonly location: { readonly directory: string }
  readonly provider: { transform(editor: (value: ProviderEditor) => void): Promise<unknown> }
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
    const auxiliaryUpstream = stringOption(options, "auxiliaryUpstream") ?? process.env.FUSION_AUXILIARY_UPSTREAM ?? DEFAULT_AUXILIARY_UPSTREAM
    const auxiliaryModel = stringOption(options, "auxiliaryModel") ?? process.env.FUSION_AUXILIARY_MODEL ?? DEFAULT_AUXILIARY_MODEL
    // Deliberately separate from FUSION_ACCESS_TOKEN (which may be a pool run credential).
    const auxiliaryApiKey = stringOption(options, "auxiliaryApiKey") ?? process.env.FUSION_AUXILIARY_API_KEY
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
    await context.provider.transform((editor) => upsertProvider(editor, upstream))
    await context.session.hook("compaction", event => {
      if (event.model.providerID === PROVIDER_ID) router.invalidateSession(event.sessionID)
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
        if (isAuxiliary(event.kind)) {
          event.request = buildAuxiliaryRequest(event.request, body as Record<string, unknown>, {
            upstream: auxiliaryUpstream, model: auxiliaryModel, apiKey: auxiliaryApiKey, kind: event.kind,
          })
          return
        }
        const input = extractInput(body)
        const currentToken = await token()
        router.setToken(currentToken)
        const route = await router.route(event.sessionID, input.prompt, input.hasImage)
        event.request = buildUpstreamRequest(
          event.request,
          prepareResponsesBody(body as Record<string, unknown>, route),
          route,
          currentToken,
          upstream,
          event.sessionID,
          router.reuse(route),
        )
      },
      { providerID: PROVIDER_ID },
    )
    await context.session.hook(
      "http.response",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return
        if (isAuxiliary(event.kind)) {
          event.response = await normalizeHttpResponse(event.response)
          return
        }
        if (!event.response.ok) router.invalidateSession(event.sessionID)
        event.response = await normalizeHttpResponse(event.response, () => router.invalidateSession(event.sessionID))
      },
      { providerID: PROVIDER_ID },
    )
    return () => router.clear()
  },
}

export default plugin
