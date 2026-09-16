# bedrock-converse

> Since Docker image version 0.0.6

Amazon Bedrock LLM Unified Interface.

Sends messages to the specified Amazon Bedrock model. `Converse` provides a consistent interface that works with all models that support messages. This allows you to write code once and use it with different models. If a model has unique inference parameters, you can also pass those unique parameters to the model.

## Configuration

Invoke model via Amazon Bedrock Converse API. You can config all supported models with this provider.

[This page](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) explains how to use Bedrock Converse API, and what features it supports.

**Prompt Caching**
[This page](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) shows the supported models and usage.
Please note that the total number of prompt caches should not exceed the limit described in the documentation. Among them: system counts as one, tools counts as one, messagePositions counts as multiple, and the sum of these should not exceed the limit.

It is recommended to use this provider to support Bedrock's large language models.

| Key     | Type      | Required     | Default value | Description |
| ------------- | -------| ------------- | ------------- | ------------- |
| modelId  | string   | Y    |  |   Model id or ARN, See [Bedrock doc](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)  |
| baseModelId  | string   | N    |  |   Source model id when using an inference profile ARN. This would be the model referenced from the infererence profile |
| regions  | string[] or string   | N     | ["us-east-1"] |   If you have applied and specified multiple regions, then a region will be randomly selected for the call. This feature can effectively alleviate performance bottlenecks.  |
| maxTokens  |  number   | N     | 1024 | The default maximum number of tokens, corresponding to the max_tokens parameter in the standard API. If not specified in the API request, this value will be used.   |
| thinking  |  boolean   | N     | false | Whether to enable the reason/think functionality  |
| thinkBudget  |  number   | N     | 1024 | When thinking is enabled, the maximum number of tokens allowed for the reasoning part |
| promptCache.fields  |  string[]   | N     |  | Where to enable prompt caching, supports three strings: "system", "messages", "tools" |
| promptCache.messagePositions  |  int[]   | N     |  | In multi-turn conversations, you can specify the loading positions for messages caching |

The configuration example:

```json
{
  "modelId": "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
  "regions": [
    "us-east-1"
  ],
  "thinking": true,
  "maxTokens": 32000,
  "promptCache": {
    "fields": [
      "system",
      "messages",
      "tools"
    ],
    "messagePositions": [
      0,
      1
    ]
  },
  "thinkBudget": 2000
}
```

## Supported model families and parameter tolerance

Converse is the **only Bedrock API that covers both the Claude and GPT families**, so this provider can be configured with Anthropic models as well as GPT-family models (`global.openai.gpt-6-astra`, `global.openai.gpt-5.6-terra`, `openai.gpt-oss-120b-1:0`, etc.). Different families tolerate inference parameters differently, so a client that sends a parameter can get rejected by Bedrock.

The table below is **measured** (region `ap-northeast-1`, real `ConverseCommand` / `ConverseStreamCommand` calls, one parameter in isolation; `maxTokens=1024` as baseline):

| Parameter | gpt-6 | gpt-5.6 | gpt-oss | claude-opus-5 | claude-sonnet-4-5 |
|---|---|---|---|---|---|
| `maxTokens` (baseline) | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| `temperature=0.7` | ❌ 400 | ❌ 400 | ✅ 200 | ❌ 400 | ✅ 200 |
| `topP=0.9` | ❌ 400 | ❌ 400 | ✅ 200 | ❌ 400 | ✅ 200 |
| `stopSequences` | ❌ 400 | ❌ 400 | ❌ 400 | ✅ 200 | ✅ 200 |
| `stream` | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| `tools` + `toolChoice` | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |

Raw rejection messages (excerpt):

```
gpt-6      temperature   400 This model doesn't support the temperature field. Remove temperature and try again.
gpt-6      topP          400 This model doesn't support the topP field. Remove topP and try again.
gpt-oss    stopSequences 400 This model doesn't support the stopSequences field. Remove stopSequences and try again.
opus-5     temperature   400 The model returned the following errors: `temperature` is deprecated for this model.
```

One **client-friendly asymmetry**: `maxTokens` is **accepted** on Converse + gpt-6, whereas the same model on `bedrock-openai`'s Chat Completions rejects `max_tokens` (it wants `max_completion_tokens`). So Converse is the more forgiving path for client parameters.

### How the connector trims per family

So that a client sending a parameter a GPT family doesn't accept still succeeds, this provider trims per family when building the Converse payload (sharing the **same family table** as `bedrock-openai`, not a second copy):

- **`gpt-5.6-*` / `gpt-6-*`**: `temperature` is dropped (unless it equals the allowed value `1`) and `top_p` (`topP`) is dropped. So a client sending `temperature: 0.7` gets it trimmed → 200 instead of 400.
- **`gpt-oss-*`**: `temperature` / `top_p` are **passed through unchanged** (measured to accept `0.7`); the value really lands in the payload.
- **`anthropic` family**: behaviour is **byte-for-byte identical** to before this change (`0.7` default + opus4 removal + `temperature`/`topP` mutual exclusion).

## Scope of thinking

`thinking` (from the request body or the model config `config.thinking`) triggers three injections: raising `maxTokens` to `thinkBudget`, setting `temperature=1` and deleting `topP`, and injecting the Anthropic-private field `additionalModelRequestFields.thinking`. These **only take effect for model families that support thinking (measured: the Anthropic family)**.

- When `config.thinking: true` is set on a **GPT-family** model row, the connector **ignores** the thinking injection — no `thinking` field appears in the payload and `temperature` is not forced to `1` — and leaves a diagnosable `warn` in the log (`thinking requested but model family does not support it, skipping thinking injection`). Measured: gpt-6 + `config.thinking:true` → **200**.

## Known limitations

The following were exposed by this round's live testing but are **pre-existing code**, **not fixed** in this round (out of scope for "GPT family trimming + thinking by family"). Keep them in mind when configuring:

- **`stop` is not trimmed per family.** A client `stop` is converted unconditionally to `stopSequences`, so sending `stop` on gpt-5.6 / gpt-6 / gpt-oss returns `400` (see the table above).
- **`claude-opus-5` + `temperature` returns 400 live.** The opus4+ removal check matches the substring `claude-opus-4`, which misses `claude-opus-5`, so opus-5 keeps `temperature` and Bedrock returns `` `temperature` is deprecated for this model ``. The table's "opus-5 baseline → 200" only holds when `temperature` is **not** sent.
- **`claude-opus-5` + `thinking` returns 400 live.** Thinking hard-codes `type: "enabled"`, but opus-5 requires `type: "adaptive"`; `claude-sonnet-4-5` with `enabled` thinking is measured at 200, so the issue is limited to the newer opus-5.

## Output Results

The output adds a reasoning_content field, consistent with deepseek's output. As follows:

```json
data: {"id":"3","created":1740468210,"object":"text_completion","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"hello"},"finish_reason":null,"logprobs":null}],"model":"sonnet37-think"}
...

```
