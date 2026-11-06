import { describe, expect, test } from "bun:test"
import {
  FusionRouter,
  FUSION_OUTPUT_LIMIT,
  MODEL_ID,
  PROVIDER_ID,
  buildUpstreamRequest,
  createStableSseStream,
  extractInput,
  extractPrompt,
  modelInfo,
  normalizeSseFrame,
  prepareResponsesBody,
  providerInfo,
  routeKey,
  stableEvent,
  upsertProvider,
  type FetchImpl,
  type FusionRoute,
  type IdSlot,
  type ModelInfo,
  type ProviderEditor,
  type ProviderInfo,
} from "../src/fusion"

const route = (model = "selected-model", expires = 2_000): FusionRoute => ({
  session_token: "session-token",
  selected_model: { id: model, supported_endpoints: ["/responses"], vision: true, limits: { max_output_tokens: 128_000 } },
  expires_at: expires,
})

const router = (fetchImpl: FetchImpl, now = () => 1_000) =>
  new FusionRouter({ token: "oauth-token", fetchImpl, now, timeoutMs: 1_000 })

describe("Fusion routing", () => {
  test("sends a Standard anchor and stays sticky across session prompts", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const instance = router(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify(route()))
    })
    const first = await instance.route("session-a", "Build app")
    const second = await instance.route("session-a", "Build app")
    await instance.route("session-a", "New prompt")
    await instance.route("session-b", "Build app")

    expect(first).toEqual(second)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe("https://api.githubcopilot.com/auto")
    expect(calls[0].init.body).toBe(JSON.stringify({
      prompt: "Build app",
      has_image: false,
      multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 },
      tier: "balance",
      hydra_rl_multi_turn: {},
      fusion: true,
    }))
    expect(calls[0].init.headers).toEqual({
      Authorization: "Bearer oauth-token",
      "Content-Type": "application/json",
      Accept: "application/json",
      "Copilot-Integration-Id": "copilot-developer-cli",
      "User-Agent": "opencode-copilot-fusion/0.1",
      "X-GitHub-Api-Version": "2026-08-01",
      "OpenAI-Intent": "conversation-agent",
      "X-Initiator": "user",
      "X-Interaction-Id": "session-a",
      "X-Client-Session-Id": "session-a",
    })
  })

  test("rejects fallback, GPT-4.1, unsupported endpoints and expiry", async () => {
    for (const value of [
      { ...route("fallback-model"), fallback: true },
      route("gpt-4.1"),
      { ...route(), selected_model: { id: "selected-model", supported_endpoints: ["/chat/completions"] } },
      route("selected-model", 1_020),
    ]) {
      const instance = router(async () => new Response(JSON.stringify(value)))
      await expect(instance.route("session", "hi")).rejects.toThrow()
    }
  })

  test("rejects malformed and failed routing responses", async () => {
    for (const response of [
      new Response("not-json", { status: 200 }),
      new Response(JSON.stringify({ selected_model: { id: "m" } })),
      new Response("upstream-secret", { status: 403 }),
    ]) {
      const instance = router(async () => response)
      await expect(instance.route("session", "hi")).rejects.toThrow()
    }
  })

  test("computes a stable route key", () => {
    expect(routeKey("a")).toBe(routeKey("a"))
    expect(routeKey("a")).not.toBe(routeKey("b"))
  })

  test("routes image requests with has_image and rejects non-vision routes", async () => {
    const calls: Array<{ init: RequestInit }> = []
    const instance = router(async (_url, init) => {
      calls.push({ init: init ?? {} })
      return new Response(JSON.stringify(route()))
    })
    await instance.route("session", "Read image", true)
    expect(JSON.parse(String(calls[0].init.body)).has_image).toBe(true)

    const noVision = router(async () => new Response(JSON.stringify({
      ...route(),
      selected_model: { id: "text-only", supported_endpoints: ["/responses"], vision: false },
    })))
    await expect(noVision.route("session", "Read image", true)).rejects.toThrow("image input")
  })
  test("single-flights parallel prompts and claims only one user anchor", async () => {
    let calls = 0
    const instance = router(async () => {
      calls++
      await Bun.sleep(10)
      return Response.json(route())
    })
    const values = await Promise.all(Array.from({ length: 10 }, (_, n) => instance.route("same", `prompt ${n}`)))
    expect(calls).toBe(1)
    expect(values.every(value => value === values[0])).toBe(true)
    expect(values.map(value => instance.reuse(value))).toEqual([false, ...Array(9).fill(true)])
  })

  test("reroutes after compaction, failure invalidation, expiry and credential rotation", async () => {
    let now = 1000, calls = 0
    const instance = router(async () => { calls++; return Response.json(route(`model-${calls}`, now + 100)) }, () => now)
    await instance.route("s", "one")
    instance.invalidateSession("s")
    await instance.route("s", "two")
    expect(calls).toBe(2)
    now += 101
    await instance.route("s", "three")
    expect(calls).toBe(3)
    instance.setToken("new-token")
    await instance.route("s", "four")
    expect(calls).toBe(4)
  })

  test("soft-fails /auto 429 and 5xx only while the last good route remains valid", async () => {
    for (const status of [429, 500, 502, 503]) {
      let now = 1000, calls = 0
      const instance = router(async () => ++calls === 1 ? Response.json(route("good", 1100)) : new Response("failed", { status }), () => now)
      const first = await instance.route("s", "one")
      now = 1080 // refresh window, but token still valid
      expect(await instance.route("s", "two")).toBe(first)
      now = 1101
      await expect(instance.route("s", "three")).rejects.toThrow(`HTTP ${status}`)
    }
  })

  test("never masks auth failures and never reuses non-vision routes for image input", async () => {
    let status = 200, now = 1000
    const instance = router(async () => status === 200 ? Response.json({ ...route("text", 1100), selected_model: { id: "text", supported_endpoints: ["/responses"], vision: false, limits: { max_output_tokens: 16384 } } }) : new Response("failed", { status }), () => now)
    await instance.route("s", "one")
    status = 429
    await expect(instance.route("s", "image", true)).rejects.toThrow("HTTP 429")
    now = 1080; status = 403
    await expect(instance.route("s", "two")).rejects.toThrow("HTTP 403")
  })

  test("image input joining a text-only flight reroutes safely", async () => {
    let calls = 0
    const instance = router(async (_url, init) => {
      calls++
      await Bun.sleep(5)
      const vision = JSON.parse(String(init?.body)).has_image
      return Response.json({ ...route(), selected_model: { id: vision ? "vision" : "text", supported_endpoints: ["/responses"], vision, limits: { max_output_tokens: 16384 } } })
    })
    const [plain, image] = await Promise.all([instance.route("s", "hi"), instance.route("s", "photo", true)])
    expect(plain.selected_model.id).toBe("text")
    expect(image.selected_model.id).toBe("vision")
    expect(calls).toBe(2)
  })

  test("invalidating an inflight route cannot repopulate the cache", async () => {
    let finish!: () => void
    const instance = router(async () => { await new Promise<void>(resolve => { finish = resolve }); return Response.json(route()) })
    const pending = instance.route("s", "hi")
    instance.invalidateSession("s")
    finish()
    await pending
    expect(instance.routes.size).toBe(0)
  })

  test("looks up each selected model's own catalog cap through the configured pool upstream", async () => {
    const calls: string[] = []
    const instance = new FusionRouter({ token: "fsp_r_local", upstream: "https://pool.test/api/fusion-pool", now: () => 1000, fetchImpl: async (url, init) => {
      calls.push(String(url))
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fsp_r_local")
      if (String(url).endsWith("/models")) return Response.json({ data: [
        { id: "luna-synthetic", capabilities: { limits: { max_output_tokens: 16384 } } },
        { id: "mai-synthetic", capabilities: { limits: { max_output_tokens: 128000 } } },
      ] })
      const prompt = JSON.parse(String(init?.body)).prompt
      const selected = route(prompt === "small" ? "luna-synthetic" : "mai-synthetic")
      delete selected.selected_model.limits
      return Response.json(selected)
    } })
    const small = await instance.route("small-session", "small"), big = await instance.route("big-session", "big")
    expect(prepareResponsesBody({ max_output_tokens: 128000 }, small).max_output_tokens).toBe(16384)
    expect(prepareResponsesBody({}, big).max_output_tokens).toBe(128000)
    expect(prepareResponsesBody({ max_output_tokens: FUSION_OUTPUT_LIMIT }, big).max_output_tokens).toBe(64000)
    expect(prepareResponsesBody({ max_output_tokens: 1024 }, small).max_output_tokens).toBe(1024)
    expect(modelInfo(small.selected_model.limits!.max_output_tokens).limit.output).toBe(16384)
    expect(calls.filter(url => url.endsWith("/models"))).toHaveLength(1)
    expect(calls.every(url => url.startsWith("https://pool.test/api/fusion-pool/"))).toBe(true)
  })

  test("uses the approved 64000 fallback only when the selected model catalog cap is unavailable", async () => {
    const missing = route("unknown"); delete missing.selected_model.limits
    for (const catalog of [Response.json({ data: [] }), new Response("not exposed", { status: 404 })]) {
      const instance = router(async url => String(url).endsWith("/models") ? catalog : Response.json(missing))
      const selected = await instance.route("s", "hi")
      expect(selected.selected_model.limits?.max_output_tokens).toBe(64000)
      expect(selected.selected_model.output_limit_source).toBe("fallback")
    }
    expect(() => prepareResponsesBody({}, missing)).toThrow("refusing unbounded generation")
  })

  test("respects inline selected-model catalog limits below the fallback", async () => {
    const selected = route("small"); selected.selected_model.limits = { max_output_tokens: 4096 }
    const instance = router(async () => Response.json(selected))
    const result = await instance.route("s", "hi")
    expect(prepareResponsesBody({ max_output_tokens: 64000 }, result).max_output_tokens).toBe(4096)
    expect(result.selected_model.output_limit_source).toBe("model-catalog")
  })

  test("shares one catalog request across concurrent independent sessions", async () => {
    let catalogCalls = 0
    const instance = router(async url => {
      if (String(url).endsWith("/models")) { catalogCalls++; await Bun.sleep(5); return Response.json({ data: [{ id: "m", capabilities: { limits: { max_output_tokens: 4096 } } }] }) }
      const selected = route("m"); delete selected.selected_model.limits; return Response.json(selected)
    })
    const values = await Promise.all([instance.route("one", "hi"), instance.route("two", "hi")])
    expect(catalogCalls).toBe(1)
    expect(values.every(value => value.selected_model.limits?.max_output_tokens === 4096)).toBe(true)
  })

  test("bounds the route cache", async () => {
    const instance = new FusionRouter({ token: "test", maxRoutes: 2, now: () => 1000, fetchImpl: async () => Response.json(route()) })
    await instance.route("a", "hi"); await instance.route("b", "hi"); await instance.route("c", "hi")
    expect([...instance.routes.keys()]).toEqual(["b", "c"])
  })

})

describe("request preparation", () => {
  test("extracts the latest user text and ignores tool output", () => {
    expect(extractPrompt({ input: [{ role: "user", content: [{ type: "input_text", text: "first" }] },
      { type: "function_call_output", output: "written" }] })).toBe("first")
    expect(extractPrompt({ input: "plain" })).toBe("plain")
    expect(() => extractPrompt({ input: [{ role: "user", content: [{ type: "input_image" }] }] })).toThrow()
  })

  test("accepts image and text content and detects images across the conversation", () => {
    expect(extractInput({ input: [
      { role: "user", content: [
        { type: "input_text", text: "Read this" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ] },
      { type: "function_call_output", output: "written" },
    ] })).toEqual({ prompt: "Read this", hasImage: true })
    expect(extractInput({ input: [{ role: "user", content: [
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ] }] })).toEqual({ prompt: "Describe the attached image.", hasImage: true })
    expect(extractInput({ input: [
      { role: "user", content: [{ type: "input_text", text: "see image" }] },
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    ] })).toEqual({ prompt: "Describe the attached image.", hasImage: true })
    expect(extractInput({ input: [
      { role: "user", content: [{ type: "input_text", text: "read the file" }] },
      { type: "function_call_output", output: [
        { type: "input_text", text: "Attached file: image.png" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ] },
    ] })).toEqual({ prompt: "read the file", hasImage: true })
  })

  test("preserves tools and adds encrypted reasoning", () => {
    const tools = [{ type: "function", name: "write" }]
    const prepared = prepareResponsesBody({ model: "fusion", input: "hi", tools, include: [], temperature: 0.4 }, route())
    expect(prepared.model).toBe("selected-model")
    expect(prepared.store).toBe(false)
    expect(prepared).not.toHaveProperty("temperature")
    expect(prepared.tools).toEqual(tools)
    expect(prepared.include).toEqual(["reasoning.encrypted_content"])
  })

  test("rewrites the request to /responses and retains OpenCode headers", () => {
    const original = new Request("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: { authorization: "Bearer placeholder", "x-opencode-session-id": "oc-session" },
      body: "{}",
    })
    const request = buildUpstreamRequest(original, { model: "selected-model" }, route(), "oauth-token",
      "https://api.githubcopilot.com", "oc-session", true)
    expect(request.url).toBe("https://api.githubcopilot.com/responses")
    expect(request.headers.get("authorization")).toBe("Bearer oauth-token")
    expect(request.headers.get("copilot-session-token")).toBe("session-token")
    expect(request.headers.get("x-initiator")).toBe("agent")
    expect(request.headers.get("x-opencode-session-id")).toBe("oc-session")
  })
})

describe("stream normalization", () => {
  test("uses the first ID for each output slot", () => {
    const slots = new Map<number, IdSlot>()
    const frames = [
      { output_index: 0, item: { id: "one", call_id: "call-1" } },
      { output_index: 0, item_id: "two" },
      { output_index: 0, item: { id: "three" } },
      { response: { output: [{ id: "four", call_id: "call-1" }] } },
    ]
    const values = frames.map((event) => stableEvent(structuredClone(event), slots))
    expect(values[0]).toMatchObject({ item: { id: "one" } })
    expect(values[1]).toMatchObject({ item_id: "one" })
    expect(values[2]).toMatchObject({ item: { id: "one" } })
    expect(values[3]).toMatchObject({ response: { output: [{ id: "one" }] } })
  })

  test("keeps SSE framing and non-data fields", () => {
    const slots = new Map<number, IdSlot>()
    const frame = ["event: response.output_item.added", 'data: {"output_index":0,"item":{"id":"one"}}']
    expect(normalizeSseFrame(frame, slots)).toContain("event: response.output_item.added")
    expect(normalizeSseFrame(["data: [DONE]"], slots)).toBe("data: [DONE]")
  })

  test("observes terminal streaming failures without changing their wire", () => {
    let failures = 0
    const frame = ['data: {"type":"response.failed","response":{"status":"failed"}}']
    expect(normalizeSseFrame(frame, new Map(), () => failures++)).toContain('"status":"failed"')
    expect(failures).toBe(1)
  })

  test("normalizes SSE across arbitrary chunk boundaries", async () => {
    const wire = [
      'event: response.output_item.added\ndata: {"output_index":0,"item":{"id":"one"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"output_index":0,"item_id":"two","delta":"{}"}\n\n',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"id":"three"}}\n\n',
      'data: [DONE]\n\n',
    ].join("")
    const bytes = new TextEncoder().encode(wire)
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 17))
        controller.enqueue(bytes.slice(17, 91))
        controller.enqueue(bytes.slice(91))
        controller.close()
      },
    })
    const output = await new Response(createStableSseStream(source)).text()
    expect(output).toContain('"item_id":"one"')
    expect(output).toContain('"id":"one"')
    expect(output).toContain("data: [DONE]")
  })
})

describe("provider registration", () => {
  test("adds a tools-capable Responses model", () => {
    const added: Array<{ info: ProviderInfo; models: readonly ModelInfo[] }> = []
    const editor: ProviderEditor = {
      get: () => undefined,
      add: (value) => added.push(value),
      update: () => {},
      models: { set: () => {} },
    }
    upsertProvider(editor)
    expect(added).toHaveLength(1)
    expect(added[0].info).toEqual(providerInfo())
    expect(added[0].models[0]).toEqual(modelInfo())
    expect(added[0].models[0].capabilities.tools).toBe(true)
    expect(added[0].models[0].capabilities.input).toContain("image")
    expect(added[0].models[0].id).toBe(MODEL_ID)
    expect(modelInfo().limit.output).toBe(FUSION_OUTPUT_LIMIT)
    expect(FUSION_OUTPUT_LIMIT).toBe(64_000)
    expect(modelInfo().limit.context).toBeGreaterThanOrEqual(modelInfo().limit.input + modelInfo().limit.output)
    expect(modelInfo().name).toBe("Fusion Standard")
    expect(added[0].info.id).toBe(PROVIDER_ID)
  })
})
