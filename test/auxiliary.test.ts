import { describe, expect, test } from "bun:test"
import { buildAuxiliaryRequest, DEFAULT_AUXILIARY_MODEL, isAuxiliary } from "../src/auxiliary"

const original = () => new Request("http://localhost/api/fusion-pool/responses", {
  method: "POST", headers: { authorization: "Bearer fsp_r_run", "copilot-session-token": "fsp_s_session", cookie: "private", "user-agent": "opencode/2.2.5", "x-opencode-client": "cli", "x-api-key": "private" }, body: "{}",
})

describe("non-Fusion auxiliary transport", () => {
  test("recognizes every auxiliary kind but not primary or unknown requests", () => {
    expect(["title", "generate", "compaction"].every(kind => isAuxiliary(kind as "title"))).toBe(true)
    expect(isAuxiliary("primary")).toBe(false)
    expect(isAuxiliary()).toBe(false)
  })
  test("preserves summary text and tool history without leaking pool credentials or encrypted state", async () => {
    const req = buildAuxiliaryRequest(original(), {
      instructions: "Summarize", input: [
        { role: "user", content: [{ type: "input_text", text: "Build a game" }, { type: "input_image", image_url: "private-image" }] },
        { type: "reasoning", encrypted_content: "private-state" },
        { type: "function_call", name: "write", arguments: '{"path":"index.html"}' },
        { type: "function_call_output", call_id: "one", output: "Wrote game" },
        { role: "assistant", content: [{ type: "output_text", text: "Done" }] },
      ], max_output_tokens: 8000, temperature: 0.5,
    }, { upstream: "https://opencode.ai/inference/openai/v1/", model: DEFAULT_AUXILIARY_MODEL, kind: "compaction" })
    expect(req.url).toBe("https://opencode.ai/inference/openai/v1/responses")
    const keys: string[] = []; req.headers.forEach((_value, key) => keys.push(key))
    expect(keys.sort()).toEqual(["authorization", "content-type", "user-agent", "x-opencode-client"])
    expect(req.headers.get("authorization")).toBe("Bearer public")
    const body = await req.json()
    expect(body.model).toBe("deepseek-v4.1-flash-free")
    expect(body.stream).toBe(true)
    expect(JSON.stringify(body.input)).toContain("Wrote game")
    expect(JSON.stringify(body)).not.toMatch(/private|fsp_|temperature/)
  })
  test("caps titles and preserves abort signals", async () => {
    const controller = new AbortController()
    const req = buildAuxiliaryRequest(new Request(original(), { signal: controller.signal }), { input: "title", max_output_tokens: 10000 }, { upstream: "https://cheap.test/v1", model: "free", kind: "title" })
    expect((await req.json()).max_output_tokens).toBe(512)
    controller.abort()
    expect(req.signal.aborted).toBe(true)
  })
  test("does not invent a client identity and supports an explicit separate auxiliary key", async () => {
    const req = buildAuxiliaryRequest(new Request("https://pool.test/responses"), { input: "summary", stream: false }, { upstream: "https://cheap.test/v1", model: "free", apiKey: "auxiliary-only" })
    expect(req.headers.has("user-agent")).toBe(false)
    expect(req.headers.get("authorization")).toBe("Bearer auxiliary-only")
    expect((await req.json()).stream).toBe(false)
    expect(() => buildAuxiliaryRequest(original(), {}, { upstream: "https://cheap.test/v1", model: "free" })).toThrow("no text input")
  })
})
