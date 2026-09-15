# bedrock-openai

该 Provider 通过 Amazon Bedrock 的 **OpenAI 兼容** 接口（`/openai/v1/chat/completions` 路径）调用 Bedrock 模型，让你用标准的 OpenAI Chat Completions 报文驱动 Bedrock，同时 BRConnector 入站侧的 `br-` key / group / 配额行为完全不变。

与 `openai-compatible` 不同，本 Provider **不要求**静态 API key。它默认从 AWS SDK 默认凭证链现场铸造一个短期 Bedrock bearer token，因此 EC2 instance role / Lambda execution role 即可直接使用，模型配置里无需存放任何静态密钥。

> 增量新增，不改动现有的 `bedrock-converse` 和 `openai-compatible`。要用 Bedrock 的 `Converse` / `InvokeModel` 接口请用 `bedrock-converse`；只有当你确实需要对 Bedrock 发 OpenAI Chat Completions 报文时才用本 Provider。

## 配置

```json
{
  "modelId": "global.openai.gpt-6-astra",
  "regions": ["us-west-2"],
  "endpointType": "bedrock-runtime"
}
```

| 键              | 类型               | 必填 | 默认值             | 说明 |
| --------------- | ------------------ | ---- | ------------------ | ---- |
| modelId         | string             | 是   |                    | Bedrock 模型 id。按 **runtime** 形态填写（需要推理配置前缀的模型带上 `us.` / `global.`，如 `global.openai.gpt-6-astra`）。详见下方 modelId 处理。 |
| regions / region| string[] 或 string | 是   |                    | 单个 region，或一个列表（每次请求随机选一个）。代码里不硬编码 region。`region` 与 `regions` 均可。 |
| endpointType    | string             | 否   | `bedrock-runtime`  | `bedrock-runtime` 或 `bedrock-mantle`。会自动选择对应的 host **和** SigV4 service name（见下）。 |
| baseURL         | string             | 否   | 自动推导           | 逃生口：指向私有 / 自定义 endpoint。配了就原样作为 base URL；SigV4 service name 仍按 `endpointType` 推导。 |
| modelIdOverrides| object             | 否   |                    | 按 endpoint 覆盖 modelId，如 `{"bedrock-mantle": "openai.gpt-6-astra"}`。命中当前 endpoint 的键时，优先于自动换算。 |
| bearerToken     | string             | 否   |                    | 静态 Bedrock API key。配了则直接作为出站 bearer token 使用（不铸造）。 |
| credentials     | array              | 否   |                    | 静态 AKSK 凭证组。配了（且未配 `bearerToken`）时选一组用于铸造出站 token。 |

`bearerToken` 与 `credentials` 都不配时，回落到 AWS SDK 默认凭证链（instance role）—— 这是推荐的生产形态，也与现有 CloudFormation 部署的运行方式一致。

### 两个 endpoint 怎么选

两个 endpoint 服务的是同一个底层推理引擎、同一个 `/openai/v1/chat/completions` 路径；差异在于各自独有的能力和 IAM action：

| | `bedrock-runtime` | `bedrock-mantle` |
|---|---|---|
| Host | `bedrock-runtime.{region}.amazonaws.com` | `bedrock-mantle.{region}.api.aws` |
| SigV4 service name | `bedrock` | `bedrock-mantle` |
| IAM action（调用） | `bedrock:InvokeModel` | `bedrock-mantle:CreateInference` |
| `Converse` / `InvokeModel` | 支持（走 `bedrock-converse`） | 不支持 |
| Guardrails / 智能提示路由 | 支持 | 不支持 |
| 服务端工具（web search）、`background=true` 异步、Projects / Workspaces | 不支持 | 支持 |

经验法则：默认用 `bedrock-runtime`（AWS 对大多数新应用的推荐）。只有当你需要某个 mantle 独有能力时才选 `bedrock-mantle`。

> 注意：mantle 独有能力（服务端工具、`background=true`、Projects / Workspaces）与 Responses API（`/openai/v1/responses`）**本轮未实现** —— 本 Provider 只发 Chat Completions。调用面已隔离，后续要加这些能力无需改动 endpoint / 认证 / modelId / 参数逻辑。

### modelId 处理（前缀差异）

同一个模型在两个 endpoint 上写法不同，本 Provider 自动换算以免踩 404：

- **runtime**：按配置原样发送，保留 `us.` / `global.` 推理配置前缀（前缀是你的显式选择）。
- **mantle**：机械地去掉推理配置前缀（`global.` / `us.` / `eu.` / `apac.`），因为 mantle 只收裸 modelId —— 带前缀会返回 `404 The model ... does not exist`。

所以 `modelId` 按 **runtime** 形态填一次即可；把 `endpointType` 切成 `bedrock-mantle` 会自动换算。若某模型需要在某个 endpoint 上手动钉死写法，用 `modelIdOverrides`。

### 按模型家族做参数裁剪

Bedrock 对推理参数的容忍度按模型家族不同，因此按家族裁剪而非一刀切。**本 Provider 不注入任何默认 `temperature` / `top_p`** —— 只转发客户端实际传来的值（裁剪后）：

- **`gpt-5.6-*` / `gpt-6-*`**：`temperature` 只接受默认值 `1`，其它值一律剔除（Bedrock 返回 `400 Unsupported value: 'temperature' does not support 0.7 ...`）；`top_p`、`reasoning_effort` 一律剔除。
- **`gpt-oss-*`**：`temperature`、`top_p`、`reasoning_effort` 原样透传。
- **其它 OpenAI 家族**：透传客户端显式值，不注入。

## IAM 前提

出站身份（instance role / execution role，或你配置的静态凭证）必须有权调用所选 endpoint：

| endpointType | 所需 IAM action |
|---|---|
| `bedrock-runtime` | `bedrock:InvokeModel`、`bedrock:InvokeModelWithResponseStream` |
| `bedrock-mantle` | `bedrock-mantle:CreateInference` |

⚠️ **随仓库的 `cloudformation/quick-build-brconnector.yaml` 只授予了 `bedrock:InvokeModel*` / `bedrock:ListFoundationModels`。** 若你配置 `bedrock-mantle` endpoint，`bedrock-mantle:CreateInference` **不在**模板里，需要你自行加到 role 的 inline policy —— 否则 mantle 调用会被拒。本轮有意未改模板；在其被合入模板前，加这条 action 属于部署时的步骤。

铸造短期 bearer token 本身走 AWS SDK 默认凭证链（`@aws/bedrock-token-generator`）；token 有缓存（约 1h TTL，过期前约 5 分钟刷新），且绝不写入 `process.env`。

## 已知陷阱

- **模型行要绑 group。** 新建的模型行如果没绑到 group（`eiai_group_model`），调用会报 `You do not have permission to access the [xxx] model`。这是 BRConnector 正常的入站行为，不是 provider 写坏了 —— 加模型时连带绑好 group。
- **约 60 秒 model 缓存。** 改完模型配置后，要等一轮缓存刷新（日志里 `The cache has been flushed`）才能在 `/v1/models` 看到。

## 示例

`bedrock-runtime`（推荐）+ instance role + 无静态密钥：

```json
{
  "modelId": "global.openai.gpt-6-astra",
  "regions": ["us-west-2"],
  "endpointType": "bedrock-runtime"
}
```

同一模型走 `bedrock-mantle`（前缀自动去成 `openai.gpt-6-astra`）：

```json
{
  "modelId": "global.openai.gpt-6-astra",
  "regions": ["us-west-2"],
  "endpointType": "bedrock-mantle"
}
```

`gpt-oss` 模型 —— 客户端可自由传 `temperature`：

```json
{
  "modelId": "openai.gpt-oss-120b-1:0",
  "regions": ["us-west-2"],
  "endpointType": "bedrock-runtime"
}
```
