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

/**
 * thinking 家族门控（唯一实现）.
 *
 * `thinking`（含 `temperature: 1` / 删 `topP` / `additionalModelRequestFields.thinking` 抬 maxTokens）
 * 是 Anthropic 私有能力：只有 anthropic 家族接受。给非支持家族注入这些字段会 400
 * （Anthropic 私有字段被 Bedrock 拒收）。这是与 `modelFamily` 正交的另一条判定轴
 * （modelFamily 只区分 gpt-oss / gpt-56-or-6 / other，无 anthropic 语义），故用独立谓词，
 * 但收在同一模块，保持「所有家族知识一处」，避免 provider 里散落 `includes("anthropic")` 私判。
 */
export function supportsThinking(modelId: string): boolean {
    return !!modelId && modelId.includes("anthropic");
}

/**
 * stopSequences 家族门控（PIPE-130 缺陷 1，唯一实现）.
 *
 * `inferenceConfig.stopSequences` 并非所有家族都接受：真链路实测（ap-northeast-1）
 * gpt-6 与 gpt-oss 均 400 `This model doesn't support the stopSequences field`——注意
 * gpt-oss 接受 temperature/top_p 却拒 stopSequences，故必须按【参数轴】逐项判定，不能按
 * 家族整体开关。anthropic / deepseek / llama 等（modelFamily === "other"）实测/现状接受。
 * 与 `modelFamily` 同模块，避免 provider 里散落 `includes("gpt")` 私判。
 */
export function supportsStopSequences(modelId: string): boolean {
    const fam = modelFamily(modelId);
    // GPT 两族拒收 stopSequences；其余（other，含 anthropic）接受。
    return fam !== "gpt-oss" && fam !== "gpt-56-or-6";
}

/**
 * Claude 代次解析：从 modelId 抽出 `claude-<family>-<major>` 的家族名与主版本号.
 *
 * 兼容新旧两种命名：新式 `claude-opus-5` / `claude-sonnet-4-6` / `claude-fable-5`
 * （family 在前、版本在后）与推理配置前缀（`global.` / `us.` 等，靠子串匹配穿透）。
 * 旧式 `claude-3-5-sonnet`（版本在前）没有 `claude-<字母族>-<数字>` 形态 → 返回 null，
 * 由调用方按 legacy 处理。
 */
function claudeGeneration(modelId: string): { family: string; major: number } | null {
    if (!modelId) return null;
    const m = modelId.match(/claude-([a-z]+)-(\d+)/);
    if (!m) return null;
    return { family: m[1], major: parseInt(m[2], 10) };
}

/**
 * 采样参数（temperature/top_p）弃用判定（PIPE-130 缺陷 2，替换原 `includes("claude-opus-4")` 子串）.
 *
 * 真链路实测（ap-northeast-1）确认的边界，非按名字规律推断：
 *   - opus gen≥4（opus-4-5/4-6/4-7/4-8）→ 400 ``temperature`/`top_p` is deprecated``；
 *   - 任意家族 gen≥5（opus-5 / sonnet-5 / fable-5）→ 同样弃用；
 *   - sonnet gen4（sonnet-4 / 4-5 / 4-6）→ 接受，保留原「temperature 与 top_p 互斥」语义；
 *   - claude-3 系及更早 → 接受，保留 legacy 行为。
 * 命中则 provider 剔除 temperature+topP；未命中走 legacy 互斥分支。
 */
export function deprecatesSamplingParams(modelId: string): boolean {
    const g = claudeGeneration(modelId);
    if (!g) return false;
    if (g.major >= 5) return true; // 任意家族 gen≥5
    if (g.family === "opus" && g.major >= 4) return true; // opus gen≥4
    return false;
}

/**
 * thinking 字段构造（PIPE-130 缺陷 3，替换原硬编码 `type:"enabled"`）.
 *
 * 真链路实测（ap-northeast-1）：`deprecatesSamplingParams` 命中的同一集合
 * （opus-5 / sonnet-5 / opus-4-8 …）要求 `thinking.type=adaptive` 且【不接受】budget_tokens
 * （`"thinking.type.enabled" is not supported ... Use "thinking.type.adaptive"`；
 * 传 budget_tokens → `thinking.adaptive.budget_tokens: Extra inputs are not permitted`）。
 * 老代次（sonnet-4-5 / sonnet-4-6）仍用 `type=enabled` + budget_tokens。两条判定共用同一代次谓词，
 * 不另起一套。仅 `supportsThinking` 为 true 的家族才会走到这里（GPT 系在 provider 侧「忽略 + 日志」）。
 */
export function thinkingFields(modelId: string, budgetTokens: number): Record<string, any> {
    if (deprecatesSamplingParams(modelId)) {
        // adaptive 不接受 budget_tokens。
        return { type: "adaptive" };
    }
    return { type: "enabled", budget_tokens: budgetTokens };
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
