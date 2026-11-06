# OpenCode Copilot Fusion

Use GitHub Copilot Fusion from OpenCode V2 through the standard Responses protocol.

## Install from the Git tag

Add this to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "copilot-fusion-direct/fusion",
  "plugins": [
    "git+https://github.com/OMGDemoPlayground/opencode-copilot-fusion.git#v0.1.2"
  ]
}
```

Use `git+https` rather than the bare `github:` shorthand so installation does not require an SSH key.

## Install in OpenCode Desktop

- Edit `~/.config/opencode/opencode.json` and preserve existing settings.
- Add the Git tag spec and token-file option from the example above.
- Restart OpenCode Desktop after changing the config.
- Allow the first activation to finish while OpenCode downloads the Git package; a model-list command can time out before that download completes.
- Select `copilot-fusion-direct/fusion` and run a short request.

## Image input

- Attach PNG, JPEG, GIF, or WebP images to an OpenCode prompt, including multiple images in one prompt.
- Keep the model on `copilot-fusion-direct/fusion`; the plugin marks it image-capable.
- The plugin routes image requests with `has_image: true`, selects a vision-capable Fusion model, and returns the normal Responses stream.
- Reject image requests when Fusion selects a model without vision instead of silently dropping the image.
- Detect images returned by OpenCode tools such as `read` through `function_call_output` content.

## Provide the token

Set `FUSION_TOKEN_FILE` to a JSON file containing `tokens.access_token` or a top-level `access_token`:

```sh
FUSION_TOKEN_FILE=/absolute/path/to/tokens.json opencode
```

Alternatively, set `FUSION_ACCESS_TOKEN` directly. Do not commit either value.

## Select the model

Select `copilot-fusion-direct/fusion`, or keep it as the `model` in `opencode.json`. The plugin routes with Fusion Standard (`balance`) by default.

## How it works

- The plugin adds the `copilot-fusion-direct` provider and a tools-capable model named `fusion`.
- The first primary request calls `POST /auto` with `fusion: true` and `tier: balance`.
- The selected model and Fusion session token are sticky per conversation, including new user prompts. Concurrent requests share one `/auto` call; follow-ups use `X-Initiator: agent`.
- Compaction, credential rotation, failed inference, expiry, or an image requiring a vision-capable model reset the route. During refresh, `/auto` 429/5xx responses reuse the previous route only while it is still valid and compatible.
- Title, generate, and compaction requests never call `/auto` or use the shared pool. They use the runner's free `deepseek-v4.1-flash-free` model via OpenCode Console's documented Responses endpoint (all text models support it). Original hook identity, request cancellation, HTTP errors and `Retry-After` remain available to the runner's compaction budget.
- Routed primary requests omit `temperature`, which some selected models reject.
- It forwards the original Responses payload, including tools and tool results, to `/responses`.
- It executes no tools. OpenCode runs its native tools and sends their results back through the same route.
- It stabilizes opaque item IDs across streamed Responses events.

## Options

Pass options through the plugin entry when needed:

```json
{
  "plugins": [
    {
      "package": "git+https://github.com/OMGDemoPlayground/opencode-copilot-fusion.git#v0.1.2",
      "options": {
        "tokenFile": "/absolute/path/to/tokens.json",
        "tier": "balance"
      }
    }
  ]
}
```

Supported options: `tokenFile`, `upstream`, `tier`, `timeoutMs`, `auxiliaryUpstream`, `auxiliaryModel`, and `auxiliaryApiKey`. Environment equivalents are `FUSION_TOKEN_FILE`, `FUSION_ACCESS_TOKEN`, `FUSION_UPSTREAM`, `FUSION_TIER`, `FUSION_AUXILIARY_UPSTREAM`, `FUSION_AUXILIARY_MODEL`, and `FUSION_AUXILIARY_API_KEY`.

`FUSION_UPSTREAM` may be the shared-pool proxy prefix and `FUSION_ACCESS_TOKEN` its run credential. Auxiliary calls use a separate endpoint (default `https://opencode.ai/inference/openai/v1`) and a separate API key (default `public`). **Fusion credentials, cookies, and encrypted reasoning are never forwarded there.** Auxiliary input preserves conversational text and tool-call/result history; these calls do not execute tools or transfer image data. The genuine OpenCode User-Agent/client headers are retained, since free chat models require OpenCode. If your deployment uses a different free-model endpoint, configure the auxiliary options explicitly.

## Release assets

Download the release `.tgz` and extract it into `~/.config/opencode/plugins/opencode-copilot-fusion` for a local install. OpenCode discovers plugin directories automatically.

## Develop

```sh
bun install
bun test
bun run typecheck
```

## OpenCode v2 integration harness

The repeatable credential-free harness reuses `/workspace/fusion-oc2-diagnostic/bin/opencode` (v2.2.5) and a local instance of the pool proxy with a synthetic upstream. It does not launch Actions, create production runs, read contributor tokens, or call real inference:

```sh
FUSION_PROXY_REPOSITORY=/workspace/omsite node scripts/test-opencode-v2.mjs /workspace/fusion-oc2-diagnostic UNIQUE_RUN_NAME
FUSION_PROXY_REPOSITORY=/workspace/omsite node scripts/test-opencode-v2.mjs /workspace/fusion-oc2-diagnostic UNIQUE_FAILURE_RUN_NAME --fail-compaction
```

Assertions cover title bypass, simple/large writes, sticky tool follow-ups, compaction bypass and re-anchoring, no local 429s, and exactly three failed auxiliary compaction attempts before the existing runner policy stops retries. Synthetic transport success is **not** evidence of real large-generation quality or the live free endpoint's availability.

## Output budget

`FUSION_OUTPUT_LIMIT` is a single named constant, currently **128000**. This follows the separately authorized 2026-11-06 probe: the selected `mai-code-1.1-flash` catalog advertised 128000 output tokens and `/responses` accepted/reported that requested budget. Those short responses prove parameter acceptance, not reliable sustained 128k generation or support by every possible Fusion-selected model.

The existing conservative 48000 input-token window stays unchanged. Client context metadata reserves input plus output (176000) so the larger output allowance does not create an always-overfull compaction budget. Title output is capped at 512; other auxiliaries at 8000. Keep the runner's chunked-write guidance and bounded-compaction companion plugin installed.

## Limits

- Text and image input with Responses-capable models only.
- Upstream image count and size limits still apply; the plugin does not pre-validate them.
- PDF input is not handled by this image path.
- No token refresh yet.
- No WebSocket transport or Copilot CLI escalation policy.
- The `/auto` endpoint is a private Copilot surface and can change.
