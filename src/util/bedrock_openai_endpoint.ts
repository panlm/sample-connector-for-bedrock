// Pure helpers for the bedrock-openai provider (OpenAI Chat Completions payload → Bedrock).
// Kept dependency-free so they can be unit tested in isolation.
//
// Covers three of the four required unit-test points:
//   ② endpoint → { baseURL, SigV4 service name }
//   ③ modelId 形态换算 (mantle strips inference-profile prefixes; runtime keeps them)
//   ① 参数裁剪家族分支 (gpt-5.6/gpt-6 vs gpt-oss vs other)
// The fourth (④ 出站认证优先级) is `resolveAuthMode` below.

export type EndpointType = "bedrock-runtime" | "bedrock-mantle";
export type SigV4ServiceName = "bedrock" | "bedrock-mantle";

export interface EndpointConfig {
    baseURL: string;
    sigV4ServiceName: SigV4ServiceName;
}

/**
 * 单测点② endpoint → host + SigV4 service name.
 *
 * host / region 完全由参数拼装，代码里不写死任何 host 或 region。
 * `baseURLOverride` 给了就原样用（逃生口 / 私有 endpoint），但 service name 仍按 endpointType 推导。
 */
export function endpointConfig(
    endpointType: EndpointType,
    region: string,
    baseURLOverride?: string,
): EndpointConfig {
    const sigV4ServiceName: SigV4ServiceName =
        endpointType === "bedrock-mantle" ? "bedrock-mantle" : "bedrock";

    if (baseURLOverride) {
        return { baseURL: baseURLOverride, sigV4ServiceName };
    }

    const host =
        endpointType === "bedrock-mantle"
            ? `https://bedrock-mantle.${region}.api.aws/openai/v1`
            : `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;

    return { baseURL: host, sigV4ServiceName };
}

// Inference-profile prefixes that only the bedrock-runtime endpoint accepts.
// bedrock-mantle 只收裸 modelId，带这些前缀一律 404。
const PROFILE_PREFIXES = ["global.", "us.", "eu.", "apac."];

/**
 * 单测点③ modelId 形态换算.
 *
 * runtime：用户配置写什么就发什么（含 `us.`/`global.` 推理配置前缀，这是用户的显式选择）。
 * mantle：机械地去掉推理配置前缀（裸 modelId），避免用户手动去前缀漏掉而踩 404。
 * `overrides` 命中时优先（每端显式钉死写法的逃生口）。
 */
export function toEndpointModelId(
    modelId: string,
    endpointType: EndpointType,
    overrides?: Record<string, string>,
): string {
    if (overrides && overrides[endpointType]) {
        return overrides[endpointType];
    }
    if (endpointType === "bedrock-mantle") {
        for (const p of PROFILE_PREFIXES) {
            if (modelId.startsWith(p)) {
                return modelId.slice(p.length);
            }
        }
        return modelId;
    }
    // runtime：原样
    return modelId;
}

export type Family = "gpt-oss" | "gpt-56-or-6" | "other";

/**
 * 家族判定用子串匹配，覆盖 `openai.gpt-6-astra` / `global.openai.gpt-6-astra` /
 * `openai.gpt-oss-120b-1:0` 各形态。gpt-oss 优先判定（避免被 gpt-6 之类误吞）。
 */
export function modelFamily(modelId: string): Family {
    if (!modelId) return "other";
    if (modelId.includes("gpt-oss")) return "gpt-oss";
    if (modelId.includes("gpt-5.6") || modelId.includes("gpt-6")) return "gpt-56-or-6";
    return "other";
}

export interface InferenceParams {
    temperature?: number;
    top_p?: number;
    reasoning_effort?: any;
}

/**
 * 单测点① 参数裁剪按家族分支.
 *
 * 入参是「客户端实际传来的值」（不注入任何默认）；出参是要发给 SDK 的对象。
 * - gpt-5.6 / gpt-6：temperature 仅接受默认(1)，非 1 一律剔除；top_p / reasoning_effort 一律剔除
 *   （实测：非默认值返回 400 / unknown_parameter）。
 * - gpt-oss：temperature / top_p / reasoning_effort 原样透传，绝不误伤。
 * - other（未知 OpenAI 家族）：保守透传客户端显式值，不注入默认。
 */
export function trimInferenceParams(modelId: string, p: InferenceParams): InferenceParams {
    const fam = modelFamily(modelId);
    const out: InferenceParams = {};

    if (fam === "gpt-56-or-6") {
        // 显式传 1 放行（幂等）；其它值 / top_p / reasoning_effort 全部剔除。
        if (p.temperature === 1) out.temperature = 1;
        return out;
    }

    // gpt-oss 与 other：透传客户端显式值，不注入默认。
    if (p.temperature !== undefined) out.temperature = p.temperature;
    if (p.top_p !== undefined) out.top_p = p.top_p;
    if (p.reasoning_effort !== undefined) out.reasoning_effort = p.reasoning_effort;
    return out;
}

export type AuthMode = "bearer" | "aksk" | "default";

/**
 * 单测点④ 三种出站认证的选择优先级.
 *
 * 与 bedrock_converse.ts 现有语义一致：
 *   ① 显式 bearerToken（静态 Bedrock API key）
 *   ② 显式静态 AKSK（credentials 非空数组，用其铸短期 token）
 *   ③ 都不配 → AWS SDK 默认凭证链铸短期 token（instance role 可用，方案 1 必做验收点）
 */
export function resolveAuthMode(config: any): AuthMode {
    if (config && config.bearerToken) return "bearer";
    if (config && Array.isArray(config.credentials) && config.credentials.length > 0) {
        return "aksk";
    }
    return "default";
}
