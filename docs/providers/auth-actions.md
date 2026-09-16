# Bedrock 出站认证 · IAM action 对照

本页跨 provider 汇总 BRConnector 出站调用 Bedrock 时到底需要哪条 IAM action，用来快速定位 403/401。action 表以 `docs/providers/bedrock-openai.md` 更正后的「IAM prerequisites」一节为准，这里只做对照与排查索引，不重复推导。

## 更正后的 action 表（原样引用）

> | endpointType | Required IAM action (default bearer-token path) |
> |---|---|
> | `bedrock-runtime` | `bedrock:CallWithBearerToken` |
> | `bedrock-mantle` | `bedrock-mantle:CallWithBearerToken` |

引自 `docs/providers/bedrock-openai.md` 的「IAM prerequisites」一节。

## 三种出站认证方式对照

| 出站认证方式 | 需要的 IAM action | 哪些 provider 会走到它 |
|---|---|---|
| 铸短期 bearer token（`bedrock-openai` 默认路径） | `bedrock:CallWithBearerToken`（runtime）/ `bedrock-mantle:CallWithBearerToken`（mantle） | `bedrock-openai`（未配 `bearerToken`/`credentials`、走默认凭证链的默认形态） |
| 裸 SigV4（AWS SDK 直接签名） | `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` / `bedrock-mantle:CreateInference` | `bedrock-converse` 等所有用 AWS SDK 直签的 provider（来自更正表解释段的文档断言，本轮未对这些 provider 单独实测） |
| 静态 Bedrock API key（静态 `bearerToken`） | **未实测** —— 授权取决于该 token 自身携带的身份，connector 自己的 role 不参与 | 任何显式配了静态 `bearerToken` 的 provider 行 |

> 脚注：静态 `credentials`（AKSK）走的是「铸 token」那一路，**按推理预期**也需要 `CallWithBearerToken`，但**未实测**（见 `bedrock-openai.md` 该段原文），按原样标注、不得升级为结论。

## 怎么排查 403/401

1. 从报错报文里抓 `is not authorized to perform:` 后面的 action 名。
2. 对照上表反查是哪条出站路径缺权限：
   - 报文里是 `...:CallWithBearerToken` → 走的是铸 token 路径（默认），补 `bedrock:CallWithBearerToken` /（mantle 时）`bedrock-mantle:CallWithBearerToken`。
   - 报文里是 `...:InvokeModel` / `CreateInference` → 走的是裸 SigV4 路径，补对应 InvokeModel 系 action。
3. ⚠️ 别用本机 admin 凭证 + `curl --aws-sigv4` 复现默认路径的问题：该命令走的是 SigV4 路径，admin 凭证总能满足（200）；默认 bearer-token 路径的缺权限只在真实部署里（实例角色缺 `CallWithBearerToken`）才暴露。

## 边界

本页只做对照与排查索引，权威定义仍在各 provider 页；出站认证细节以 `docs/providers/bedrock-openai.md` 的「IAM prerequisites」一节为准。
