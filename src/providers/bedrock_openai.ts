// bedrock-openai provider —— 用 OpenAI Chat Completions 报文调 Bedrock 的 /openai/v1 endpoint。
//
// 出站认证走方案 1：OpenAI SDK + `@aws/bedrock-token-generator` 现场铸短期 bearer token
// （默认凭证链 = instance role 可用），token 作为 `apiKey` 交给 `new OpenAI(...)`，**不经 process.env**。
// 兼容显式 bearerToken（静态 Bedrock API key）与静态 AKSK 两种模式，优先级 bearer > aksk > default。
//
// 增量新增，不改 openai_compatible.ts —— 存量静态 apiKey 配置行为免证不变。
import OpenAI from 'openai';
import { ChatRequest, ResponseData } from "../entity/chat_request";
import AbstractProvider from "./abstract_provider";
import helper from "../util/helper";
import {
    endpointConfig,
    toEndpointModelId,
    trimInferenceParams,
    resolveAuthMode,
    EndpointType,
} from "../util/bedrock_openai_endpoint";
import { getBedrockBearerToken, CredSource } from "../util/bedrock_token";

interface ExtendedDelta {
    content?: string;
    reasoning_content?: string;
}

export default class BedrockOpenAI extends AbstractProvider {

    /**
     * 解析模型配置 → 本次请求实际要用的 endpoint / modelId / apiKey。
     * apiKey 每次现取（token 会刷新、单例会被多模型复用），不缓存跨模型的 client。
     */
    private async resolveRequest(): Promise<{
        baseURL: string;
        modelId: string;
        apiKey: string;
    }> {
        const config = this.modelData.config || {};

        const modelId: string = config.modelId;
        if (!modelId) {
            throw new Error("You must specify the parameters 'modelId' in the backend model configuration.");
        }

        const regionsCfg = config.regions ?? config.region;
        if (!regionsCfg) {
            throw new Error("You must specify 'region' or 'regions' in the backend model configuration.");
        }
        const region: string = helper.selectRandomRegion(regionsCfg);

        const endpointType: EndpointType =
            config.endpointType === "bedrock-mantle" ? "bedrock-mantle" : "bedrock-runtime";

        const { baseURL, sigV4ServiceName } = endpointConfig(endpointType, region, config.baseURL);
        const resolvedModelId = toEndpointModelId(modelId, endpointType, config.modelIdOverrides);

        const apiKey = await this.resolveApiKey(config, region, sigV4ServiceName);

        return { baseURL, modelId: resolvedModelId, apiKey };
    }

    /** 出站认证：bearer > aksk > default（见 resolveAuthMode）。返回交给 OpenAI SDK 的 apiKey。 */
    private async resolveApiKey(config: any, region: string, sigV4ServiceName: string): Promise<string> {
        const mode = resolveAuthMode(config);

        if (mode === "bearer") {
            // 静态 Bedrock API key：直接用，不铸造。
            return config.bearerToken;
        }

        let src: CredSource;
        if (mode === "aksk") {
            const cred = helper.selectCredentials(config.credentials, undefined);
            if (!cred) {
                // credentials 配了但选不出（异常配置）→ 回落默认凭证链，不静默用错凭证。
                src = { kind: "default" };
            } else {
                src = {
                    kind: "static",
                    accessKeyId: cred.accessKeyId,
                    secretAccessKey: cred.secretAccessKey,
                    sessionToken: cred.sessionToken,
                };
            }
        } else {
            // default：AWS SDK 默认凭证链（instance role 可用）——方案 1 必做验收点。
            src = { kind: "default" };
        }

        return getBedrockBearerToken(region, sigV4ServiceName, src);
    }

    async chat(chatRequest: ChatRequest, session_id: string, ctx: any) {
        const { baseURL, modelId, apiKey } = await this.resolveRequest();

        // token 会刷新、单例被多模型复用 → 每次新建 client（构造开销可忽略），避免串配置 / 用到旧 token。
        const client = new OpenAI({ baseURL, apiKey });

        // 按 endpoint 换算后的 modelId 覆盖，确保发给 Bedrock 的是正确形态。
        chatRequest.model_id = modelId;

        ctx.status = 200;

        if (chatRequest.stream) {
            ctx.set({
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache',
                'Content-Type': 'text/event-stream',
            });
            await this.chatStream(client, ctx, chatRequest, session_id, modelId);
        } else {
            ctx.set({
                'Content-Type': 'application/json',
            });
            ctx.body = await this.chatSync(client, ctx, chatRequest, session_id, modelId);
        }
    }

    /**
     * 调用 Bedrock 的 OpenAI 兼容 surface。集中在此处，Responses API 等未来 surface 只需在此扩展分支，
     * 无需改动 endpoint / auth / modelId / 参数裁剪逻辑（父 issue「预留扩展位」要求）。
     */
    private buildPayload(chatRequest: ChatRequest, modelId: string, stream: boolean): any {
        // 参数裁剪按模型家族做（gpt-5.6/6 剔除、gpt-oss 不误伤），且**不注入 || 1.0 默认**。
        const trimmed = trimInferenceParams(modelId, {
            temperature: chatRequest.temperature,
            top_p: chatRequest.top_p,
            reasoning_effort: chatRequest.reasoning_effort,
        });

        const payload: any = {
            model: modelId,
            messages: JSON.parse(JSON.stringify(chatRequest.messages)),
            max_tokens: chatRequest.max_tokens,
            max_completion_tokens: chatRequest.max_completion_tokens,
            ...(trimmed.temperature !== undefined && { temperature: trimmed.temperature }),
            ...(trimmed.top_p !== undefined && { top_p: trimmed.top_p }),
            ...(trimmed.reasoning_effort !== undefined && { reasoning_effort: trimmed.reasoning_effort }),
            ...(chatRequest.tools && { tools: chatRequest.tools }),
            ...(chatRequest.tool_choice && { tool_choice: chatRequest.tool_choice }),
        };
        if (stream) payload.stream = true;
        return payload;
    }

    async chatStream(client: OpenAI, ctx: any, chatRequest: ChatRequest, session_id: string, modelId: string) {
        const chatResponse = await client.chat.completions.create(
            this.buildPayload(chatRequest, modelId, true),
        );

        let responseText = "";
        for await (const part of chatResponse as any) {
            const reasoning_content = (part.choices[0]?.delta as ExtendedDelta)?.reasoning_content || '';
            responseText += reasoning_content;
            const content = part.choices[0]?.delta?.content || '';
            responseText += content;
            if (part.choices[0]?.finish_reason === "stop") {
                const {
                    completion_tokens = 0,
                    prompt_tokens = 0
                } = part.usage ?? {};

                const response: ResponseData = {
                    text: responseText,
                    input_tokens: prompt_tokens,
                    output_tokens: completion_tokens,
                };
                await this.saveThread(ctx, session_id, chatRequest, response);
            }
            ctx.res.write("data: " + JSON.stringify(part) + "\n\n");
        }
        ctx.res.write("data: [DONE]\n\n");
        ctx.res.end();
    }

    async chatSync(client: OpenAI, ctx: any, chatRequest: ChatRequest, session_id: string, modelId: string) {
        const chatResponse = await client.chat.completions.create(
            this.buildPayload(chatRequest, modelId, false),
        );

        const {
            completion_tokens = 0,
            prompt_tokens = 0
        } = chatResponse.usage ?? {};

        const content = chatResponse.choices[0].message.content || "";

        const response: ResponseData = {
            text: content,
            input_tokens: prompt_tokens,
            output_tokens: completion_tokens,
        };

        await this.saveThread(ctx, session_id, chatRequest, response);

        return chatResponse;
    }
}
