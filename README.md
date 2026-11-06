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

## Selected-model output budget

After `/auto`, the plugin uses **that exact selected model's** `capabilities.limits.max_output_tokens` from the models inventory. A proxy may attach the inventory's `capabilities.limits`/`limits` to `selected_model`; otherwise the plugin reads `GET {FUSION_UPSTREAM}/models` with the same credential. It never sends a pool run credential directly to Copilot. Catalog reads are cached and single-flighted, and reset on credential rotation.

The actual outgoing `max_output_tokens` is clamped to the selected model's cap, so a known lower-limit model never inherits the 128000 cap from another model. The provider's `limit.output` metadata is refreshed after selection too. Smaller request budgets are retained. The initial metadata bootstrap is replaced by the selected cap for subsequent provider requests; an already-created smaller request keeps its budget.

`FUSION_OUTPUT_LIMIT=64000` is the explicitly approved **fallback only** when catalog metadata is unavailable. The 2026-11-06 authorized catalog/probe reports show 128000 for observed `gpt-6-luna`, `gpt-5.6-luna` variants and `mai-code-1.1-flash`. This does not establish a universal floor for every future Fusion model: expose model metadata in the pool proxy rather than relying on the fallback. An older proxy without metadata stays compatible at the fallback (`--no-models` in the integration harness tests this path).

The existing conservative 48000 input-token window stays unchanged. Client context metadata reserves input plus the current output cap so increasing the allowance does not create an always-overfull compaction budget. Title output is capped at 512; other auxiliaries at 8000. Keep the runner's chunked-write guidance and bounded-compaction companion plugin installed.

The integration harness includes a local, authenticated `/models` metadata shim until the separately coordinated proxy endpoint/enrichment is available. To test a lower-limit selection without actual inference:

```sh
FUSION_SYNTHETIC_MODEL=luna-synthetic-low-limit FUSION_SYNTHETIC_OUTPUT_LIMIT=16384 node scripts/test-opencode-v2.mjs /workspace/fusion-oc2-diagnostic UNIQUE_LOW_LIMIT_RUN
```

16384 here is a deliberately lower **synthetic** cap, not Luna's real catalog limit. Short real parameter-acceptance probes and synthetic large writes do not prove reliable sustained large generation.

## Limits

- Text and image input with Responses-capable models only.
- Upstream image count and size limits still apply; the plugin does not pre-validate them.
- PDF input is not handled by this image path.
- No token refresh yet.
- No WebSocket transport or Copilot CLI escalation policy.
- The `/auto` endpoint is a private Copilot surface and can change.
