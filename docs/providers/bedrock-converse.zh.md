# bedrock-converse

> Since Docker image version 0.0.6

Amazon Bedrock LLM 统一调用。

将消息发送到指定的 Amazon Bedrock 模型。Converse提供了一个与支持消息的所有模型兼容的统一接口。这允许您只编写一次代码,并将其用于不同的模型。如果某个模型具有独特的推理参数,您也可以将这些独特的参数传递给该模型。

## 参数配置

通过亚马逊Bedrock Converse API调用模型。您可以使用此提供程序配置所有支持的模型。

[这个网址](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) 解释了如何使用 Bedrock Converse API 以及他支持的特性。

**提示词缓存**

[这个网址](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) 可以看到支持模型和用法。
请注意，总的提示缓存数量不要超出文档中的描述。其中：system 算一个，tools 算一个，messagePositions 的算多个，这些总和不要超出限制。

建议使用这个 Provider 来支持 Bedrock 的大语言模型。

| Key     | Type      | Required     | Default value | Description |
| ------------- | -------| ------------- | ------------- | ------------- |
| modelId  | string   | Y    |  |   Model id, [点这里查看列表](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)  |
| regions  | string[] or string   | N     | ["us-east-1"] |   如果您已经申请并指定了多个地区,那么将会随机选择一个地区进行调用。这个功能可以有效缓解性能瓶颈。  |
| maxTokens  |  number   | N     | 1024 | 默认最大 tokens 数量，对应标准 API 的 max_tokens 参数。 如果 API 请求中不指定，则使用此值。  |
| thinking  |  boolen   | N     | false | 是否开启 reason/think 功能  |
| thinkBudget  |  number   | N     | 1024 | 在开启 thinking 的情况下，推理部分允许的最大 tokens 数量 |
| promptCache.fields  |  string[]   | N     |  | 在什么位置开启提示词缓存，支持三个字符串："system", "messages", "tools"|
| promptCache.messagePositions  |  int[]   | N     |  |多轮对话中，可以指定 messages 缓存的加载位置 |
| maxRetries  |  number   | N     |  | 当访问 bedrock 出错的时候，会持续尝试，如果存在多组 aksk，则会排除当前的 key 再尝试 |
| credentials  |  object[]   | N     |  | 多组 AKSK 的配置，具体参见下面的配置 |

bedrock-converse 的配置示例如下：

```json
{
  {
  "modelId": "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
  "regions": [
    "us-east-1"
  ],
  "thinking": false,
  "maxTokens": 32000,
  "maxRetries": 3,
  "credentials": [
    {
      "accessKeyId": "a0",
      "secretAccessKey": "xxx"
    },
    {
      "accessKeyId": "a1",
      "secretAccessKey": "bbb"
    },
    {
      "accessKeyId": "a2",
      "secretAccessKey": "bbb"
    },
    {
      "accessKeyId": "a3",
      "secretAccessKey": "bbb"
    },
    {
      "accessKeyId": "a4",
      "secretAccessKey": "bbb"
    }
  ],
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
}
```

## 支持的模型家族与参数容忍度

Converse 是**唯一同时覆盖 Claude 与 GPT 系的 Bedrock API**，所以本 Provider 既能配 Anthropic 模型，也能配 GPT 系（`global.openai.gpt-6-astra`、`global.openai.gpt-5.6-terra`、`openai.gpt-oss-120b-1:0` 等）。但不同家族对推理参数的容忍度不同，客户端一传参就可能被 Bedrock 拒。

下表为**实测**结果（region `ap-northeast-1`，真实 `ConverseCommand` / `ConverseStreamCommand` 调用，隔离单个参数；`maxTokens=1024` 为基线）：

| 参数 | gpt-6 | gpt-5.6 | gpt-oss | claude-opus-5 | claude-sonnet-4-5 |
|---|---|---|---|---|---|
| `maxTokens`（基线） | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| `temperature=0.7` | ❌ 400 | ❌ 400 | ✅ 200 | ❌ 400 | ✅ 200 |
| `topP=0.9` | ❌ 400 | ❌ 400 | ✅ 200 | ❌ 400 | ✅ 200 |
| `stopSequences` | ❌ 400 | ❌ 400 | ❌ 400 | ✅ 200 | ✅ 200 |
| `stream` | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| `tools` + `toolChoice` | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |

拒绝时的原始报文（节选）：

```
gpt-6      temperature   400 This model doesn't support the temperature field. Remove temperature and try again.
gpt-6      topP          400 This model doesn't support the topP field. Remove topP and try again.
gpt-oss    stopSequences 400 This model doesn't support the stopSequences field. Remove stopSequences and try again.
opus-5     temperature   400 The model returned the following errors: `temperature` is deprecated for this model.
```

一个**对客户端有利的不对称**：`maxTokens` 在 Converse + gpt-6 上**被接受**，而同一模型走 `bedrock-openai` 的 Chat Completions 时 `max_tokens` 会被拒（要 `max_completion_tokens`）。即 Converse 这条路对客户端参数更宽容。

### 连接器如何按家族裁剪

为了让「客户端传了 GPT 家族不接受的参数」也能成功，本 Provider 在把请求转成 Converse payload 时按家族裁剪（与 `bedrock-openai` **共用同一张家族表**，不各写一份）：

- **`gpt-5.6-*` / `gpt-6-*`**：剔掉 `temperature`（除非等于允许值 `1`）与 `top_p`（`topP`）。所以客户端传 `temperature: 0.7` 会被裁掉后 → 200，而不是 400。
- **`gpt-oss-*`**：`temperature` / `top_p` **原样透传**（实测接受 `0.7`），值真的进 payload。
- **`anthropic` 家族**：行为与本次改动前**字节级一致**（`0.7` 默认 + opus4 剔除 + `temperature`/`topP` 互斥）。

## thinking 的适用范围

`thinking`（来自请求体或模型配置 `config.thinking`）触发三处注入：抬升 `maxTokens` 到 `thinkBudget`、设 `temperature=1` 并删 `topP`、注入 Anthropic 私有字段 `additionalModelRequestFields.thinking`。这些**只对支持 thinking 的模型家族生效（实测为 Anthropic 系）**。

- 给 **GPT 系**模型行开 `config.thinking: true` 时，连接器**忽略** thinking 注入——payload 里不出现 `thinking` 字段、`temperature` 也不会被强改为 `1`——并在日志留一条可诊断的 `warn`（`thinking requested but model family does not support it, skipping thinking injection`）。实测 gpt-6 + `config.thinking:true` → **200**。

## 已知限制

以下问题在本轮真链路测试中暴露，属**既有代码**、本轮**未修**（不在本次「GPT 家族裁剪 + thinking 分家族」范围内），配置时需注意：

- **`stop` 未按家族裁剪。** 客户端传的 `stop` 会无条件转成 `stopSequences` 发出，因此 gpt-5.6 / gpt-6 / gpt-oss 上带 `stop` 会 `400`（见上表）。
- **`claude-opus-5` + `temperature` 真链路 400。** opus4+ 的剔除判定用子串 `claude-opus-4`，匹配不到 `claude-opus-5`，故 opus-5 保留了 `temperature`，Bedrock 返回 `` `temperature` is deprecated for this model ``。上表「opus-5 只给 maxTokens → 200」只在**不传** `temperature` 时成立。
- **`claude-opus-5` + `thinking` 真链路 400。** thinking 硬编码 `type: "enabled"`，而 opus-5 要求 `type: "adaptive"`；`claude-sonnet-4-5` 的 `enabled` thinking 实测 200，问题仅限较新的 opus-5。

## 输出结果

输出中增加了 reasoning_content 字段，与 deepseek 的输出保持一致。如下：

```json
data: {"id":"3","created":1740468210,"object":"text_completion","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"你好"},"finish_reason":null,"logprobs":null}],"model":"sonnet37-think"}
...

```
