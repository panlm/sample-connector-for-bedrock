# bedrock-openai

This Provider calls Amazon Bedrock through its **OpenAI-compatible** surface (the `/openai/v1/chat/completions` path), so you can drive Bedrock models with standard OpenAI Chat Completions payloads while keeping BRConnector's normal inbound `br-` key / group / quota behaviour.

Unlike `openai-compatible`, this provider does **not** require a static API key. Its default outbound path mints a short-lived Bedrock bearer token from the AWS SDK default credential chain, so an EC2 instance role / Lambda execution role works with no static secret stored in the model config.

> Incremental addition. It does not change the existing `bedrock-converse` or `openai-compatible` providers.
>
> **For most cases, default to [`bedrock-converse`](bedrock-converse.md)**: its Converse API also supports the GPT family (measured: `Converse + global.openai.gpt-6-astra` with only `maxTokens` → 200), and it is the **only API that covers both Claude and GPT** — Chat Completions / Responses serve only the OpenAI family, Messages serves only the Anthropic family (measured: cross-family calls all return `404 The model doesn't exist or doesn't support this API`).
>
> Choose this provider only when you specifically need a capability unique to it: sending **native OpenAI Chat Completions payloads** to Bedrock, or the `bedrock-mantle`-only server-side tools / `background=true` async / Projects / Workspaces (the latter is not implemented in this round — see the note below).

## Configuration

```json
{
  "modelId": "global.openai.gpt-6-astra",
  "regions": ["us-west-2"],
  "endpointType": "bedrock-runtime"
}
```

| Key             | Type              | Required | Default           | Description |
| --------------- | ----------------- | -------- | ----------------- | ----------- |
| modelId         | string            | Y        |                   | Bedrock model id. Write it in the **runtime** form (with the `us.` / `global.` inference-profile prefix when the model needs one, e.g. `global.openai.gpt-6-astra`). See modelId handling below. |
| regions / region| string[] or string| Y        |                   | One region, or a list from which one is picked at random per request. There is no hard-coded region. `region` and `regions` are accepted interchangeably. |
| endpointType    | string            | N        | `bedrock-runtime` | `bedrock-runtime` or `bedrock-mantle`. Selects the host **and** the SigV4 service name automatically (see below). |
| baseURL         | string            | N        | derived           | Escape hatch to point at a private / custom endpoint. When set it is used verbatim as the base URL; the SigV4 service name is still derived from `endpointType`. |
| modelIdOverrides| object            | N        |                   | Per-endpoint modelId override, e.g. `{"bedrock-mantle": "openai.gpt-6-astra"}`. When the key for the active endpoint is present, it wins over the automatic conversion. |
| bearerToken     | string            | N        |                   | A static Bedrock API key. When set, it is used directly as the outbound bearer token (no minting). |
| credentials     | array             | N        |                   | Static AKSK credential set(s). When set (and no `bearerToken`), one set is selected and used to mint the outbound token. |

If neither `bearerToken` nor `credentials` is configured, the provider falls back to the AWS SDK default credential chain (instance role) — this is the recommended production setup and matches how the CloudFormation deployment already runs.

### Choosing between the two endpoints

Both endpoints serve the same `/openai/v1/chat/completions` path on the same underlying inference engine; they differ in which extra capabilities and IAM actions they expose:

| | `bedrock-runtime` | `bedrock-mantle` |
|---|---|---|
| Host | `bedrock-runtime.{region}.amazonaws.com` | `bedrock-mantle.{region}.api.aws` |
| SigV4 service name | `bedrock` | `bedrock-mantle` |
| IAM action (default bearer-token path) | `bedrock:CallWithBearerToken` | `bedrock-mantle:CallWithBearerToken` |
| `Converse` / `InvokeModel` | Supported (via `bedrock-converse`) | Not supported |
| Guardrails / intelligent prompt routing | Supported | Not supported |
| Server-side tools (web search), `background=true` async, Projects / Workspaces | Not supported | Supported |

Rule of thumb: default to `bedrock-runtime` (AWS's own recommendation for most new applications). Choose `bedrock-mantle` only when you need a mantle-only capability.

> Note: the mantle-only capabilities (server-side tools, `background=true`, Projects / Workspaces) and the Responses API (`/openai/v1/responses`) are **not implemented in this round** — this provider only sends Chat Completions. The provider's call surface is isolated so those can be added later without touching endpoint / auth / modelId / parameter logic.

### modelId handling (prefix differences)

The same model is addressed differently on the two endpoints, and this provider handles the difference automatically so you don't hit a 404:

- **runtime**: sent as configured, including any `us.` / `global.` inference-profile prefix. That prefix is your explicit choice.
- **mantle**: the inference-profile prefix (`global.` / `us.` / `eu.` / `apac.`) is stripped mechanically, because mantle only accepts the bare modelId — a prefixed id returns `404 The model ... does not exist`.

So configure `modelId` in the **runtime** form once; switching `endpointType` to `bedrock-mantle` converts it for you. If a specific model needs a hand-pinned form on one endpoint, use `modelIdOverrides`.

### Parameter handling by model family

Bedrock's tolerance for inference parameters differs by model family, so parameters are trimmed per family rather than with a single rule. **This provider does not inject any default `temperature` / `top_p`** — only what the client actually sends is forwarded (after trimming):

- **`gpt-5.6-*` / `gpt-6-*`**: `temperature` is only accepted as the default value `1`; any other value is dropped (Bedrock returns `400 Unsupported value: 'temperature' does not support 0.7 ...`). `top_p` and `reasoning_effort` are dropped.
- **`gpt-oss-*`**: `temperature`, `top_p`, and `reasoning_effort` are passed through unchanged.
- **other OpenAI families**: client-supplied values are passed through; nothing is injected.

## IAM prerequisites

The outbound identity (instance role / execution role, or the static credentials you configure) must be allowed to call the endpoint you select. **By default this provider does not sign requests with SigV4 — it mints a short-lived Bedrock bearer token and calls with it**, so the required action is `CallWithBearerToken`, not `InvokeModel`:

| endpointType | Required IAM action (default bearer-token path) |
|---|---|
| `bedrock-runtime` | `bedrock:CallWithBearerToken` |
| `bedrock-mantle` | `bedrock-mantle:CallWithBearerToken` |

### Why a bearer token needs `CallWithBearerToken`, not `InvokeModel`

Bedrock has two outbound authorization paths, gated by *different* IAM actions:

- **SigV4 (direct signing).** You sign the request with AWS credentials; Bedrock authorizes it against the classic actions (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, or `bedrock-mantle:CreateInference`).
- **Bearer token.** You mint a short-lived Bedrock bearer token from your credentials (via `@aws/bedrock-token-generator`) and call with `Authorization: Bearer <token>`. Bedrock then authorizes against `bedrock:CallWithBearerToken` (runtime) / `bedrock-mantle:CallWithBearerToken` (mantle) — **not** `InvokeModel` / `CreateInference`.

This provider's default path is the bearer-token one (see the intro: it mints a token from the default credential chain and hands it to the OpenAI SDK). So the default deployment needs `CallWithBearerToken`; granting only `InvokeModel*` yields `401/403 ... is not authorized to perform: bedrock:CallWithBearerToken` (runtime) or `bedrock-mantle:CallWithBearerToken` (mantle).

> ⚠️ **You cannot reproduce this locally with admin credentials + `curl --aws-sigv4`.** That command exercises the *SigV4* path, which admin credentials always satisfy (200). The failure only surfaces in a real deployment where the provider mints a bearer token from an instance role that lacks `CallWithBearerToken`.

⚠️ **The bundled `cloudformation/quick-build-brconnector.yaml` grants only `bedrock:InvokeModel*` / `bedrock:ListFoundationModels`.** Those cover the SigV4 path only; they do **not** cover the default bearer-token path. You must add `bedrock:CallWithBearerToken` (and `bedrock-mantle:CallWithBearerToken` if you use a `bedrock-mantle` endpoint) to the role's inline policy yourself. The template was intentionally left unchanged in this round; adding the action is a deployment-time step until it is folded into the template.

Minting the short-lived bearer token itself uses the AWS SDK default credential chain via `@aws/bedrock-token-generator`; the token is cached (~1h TTL, refreshed ~5 min before expiry) and is never written to `process.env`.

**Static `bearerToken` / static `credentials` (not measured):** the reproduction above was captured with the default credential chain (instance role). The two static paths were **not tested** in that report:
- Static `bearerToken`: the connector sends your token verbatim, so authorization depends on whatever identity that token already carries — the connector's own role is not consulted. Not measured.
- Static `credentials`: the connector mints a token from these AKSK and then calls with the bearer token, so by the reasoning above it is *expected* to need `CallWithBearerToken` — but this was **not measured**; treat it as inference and verify before relying on it.

## Known gotchas

- **Bind the model row to a group.** A new model row that is not bound to a group (`eiai_group_model`) returns `You do not have permission to access the [xxx] model`. This is BRConnector's normal inbound behaviour, not a provider fault — bind the group when you add the model.
- **~60 s model cache.** After you change model configuration, wait for one cache flush (`The cache has been flushed` in the log) before the model appears in `/v1/models`.

## Samples

Configure via `bedrock-runtime` (recommended), instance role, no static secret:

```json
{
  "modelId": "global.openai.gpt-6-astra",
  "regions": ["us-west-2"],
  "endpointType": "bedrock-runtime"
}
```

Same model on `bedrock-mantle` (prefix stripped automatically to `openai.gpt-6-astra`):

```json
{
  "modelId": "global.openai.gpt-6-astra",
  "regions": ["us-west-2"],
  "endpointType": "bedrock-mantle"
}
```

A `gpt-oss` model — client may send `temperature` freely:

```json
{
  "modelId": "openai.gpt-oss-120b-1:0",
  "regions": ["us-west-2"],
  "endpointType": "bedrock-runtime"
}
```
