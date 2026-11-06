import { describe, expect, test } from "bun:test"
import plugin from "../index"
import { PROVIDER_ID } from "../src/fusion"

type RequestEvent = { kind: "primary" | "title" | "generate" | "compaction"; sessionID: string; model: { providerID: string }; request: Request }
// Exercise the public plugin lifecycle, not just the standalone helper functions.
describe("plugin request lifecycle", () => {
  test("bypasses all auxiliaries, keeps their policy identity, and invalidates primary routes on failure/compaction", async () => {
    const previousToken = process.env.FUSION_ACCESS_TOKEN, previousFetch = globalThis.fetch
    process.env.FUSION_ACCESS_TOKEN = "local_synthetic_run_capability"
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return Response.json({ session_token: "local_synthetic_session", selected_model: { id: "chosen", supported_endpoints: ["/responses"], vision: true }, expires_at: Date.now() / 1000 + 600 })
    }) as unknown as typeof fetch
    const hooks: Record<string, (event: any) => Promise<void> | void> = {}
    const context: Parameters<typeof plugin.setup>[0] = {
      options: { upstream: "http://pool.test/api/fusion-pool", auxiliaryUpstream: "http://cheap.test/v1" },
      location: { directory: "/tmp" },
      provider: { transform: async () => {} },
      session: { hook: async (name: string, callback: any) => { hooks[name] = callback } },
    }
    let cleanup: (() => void) | undefined
    const event = (kind: RequestEvent["kind"], prompt = "hi"): RequestEvent => ({
      kind, sessionID: "s", model: { providerID: PROVIDER_ID },
      request: new Request("http://pool.test/responses", { method: "POST", body: JSON.stringify({ model: "fusion", input: prompt, temperature: 0.5 }) }),
    })
    try {
      cleanup = await plugin.setup(context)
      for (const kind of ["title", "generate", "compaction"] as const) {
        const e = event(kind)
        const identity = e.model
        await hooks["http.request"](e)
        expect(e.request.url).toBe("http://cheap.test/v1/responses")
        expect(e.model).toBe(identity)
        expect(e.kind).toBe(kind)
        expect(e.request.headers.get("authorization")).toBe("Bearer public")
      }
      expect(calls).toBe(0)
      const first = event("primary"), second = event("primary", "different prompt")
      await Promise.all([hooks["http.request"](first), hooks["http.request"](second)])
      expect(calls).toBe(1)
      expect([first, second].map(e => e.request.headers.get("x-initiator")).sort()).toEqual(["agent", "user"])
      expect(first.request.headers.get("authorization")).toBe("Bearer local_synthetic_run_capability")
      expect(await first.request.clone().json()).not.toHaveProperty("temperature")
      await hooks.compaction(first)
      const afterCompaction = event("primary")
      await hooks["http.request"](afterCompaction)
      expect(calls).toBe(2)
      await hooks["http.response"]({ ...afterCompaction, response: Response.json({ error: "bad route" }, { status: 403 }) })
      await hooks["http.request"](event("primary"))
      expect(calls).toBe(3)
      // A cheap-model failure must not invalidate the primary route.
      const auxiliaryError = { ...event("compaction"), response: Response.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "2" } }) }
      await hooks["http.response"](auxiliaryError)
      expect(auxiliaryError.response.status).toBe(503)
      expect(auxiliaryError.response.headers.get("Retry-After")).toBe("2")
      await hooks["http.request"](event("primary"))
      expect(calls).toBe(3)
    } finally {
      cleanup?.()
      globalThis.fetch = previousFetch
      if (previousToken === undefined) delete process.env.FUSION_ACCESS_TOKEN
      else process.env.FUSION_ACCESS_TOKEN = previousToken
    }
  })
})
