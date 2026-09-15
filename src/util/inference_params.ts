// item 4（父 issue 必做 4）修复所需的纯函数：Converse 的基础 temperature/topP 注入。
//
// 现状缺陷（bedrock_converse.ts:867）：无条件注入 `temperature: temp || 0.7` / `topP: top_p || 0.7`，
// 而剔除逻辑被关在 `if (modelId.includes("anthropic"))` 里 —— 任何非 anthropic 模型走 Converse
// 且客户端没传参 → 必 ValidationException。
//
// 修复：把「基础注入」按是否 anthropic 分支。anthropic 分支行为字节级不变（仍是 0.7 默认，
// 供其下游 opus4 剔除 / topP&temp 互斥逻辑消费）；非 anthropic 分支只透传客户端显式值、不注入默认。
// 抽成纯函数便于单测（不牵动 bedrock_converse.ts 的重型依赖）。

export interface BaseInferenceParams {
    temperature?: number;
    topP?: number;
}

/**
 * 计算 Converse inferenceConfig 的基础 temperature / topP。
 *
 * @param modelId      模型 id（用 `includes("anthropic")` 判定分支，与现有代码一致）。
 * @param chatRequest  客户端请求（读 temperature / top_p）。
 */
export function buildBaseInferenceParams(modelId: string, chatRequest: any): BaseInferenceParams {
    const out: BaseInferenceParams = {};
    const isAnthropic = !!modelId && modelId.includes("anthropic");

    if (isAnthropic) {
        // —— anthropic 分支：保持现有行为（无条件 0.7 默认），下游 anthropic 专属逻辑再按需剔除 ——
        out.temperature = chatRequest.temperature || 0.7;
        out.topP = chatRequest.top_p || 0.7;
        return out;
    }

    // —— 非 anthropic：不再无条件注入 0.7，只透传客户端显式传来的值 ——
    if (chatRequest.temperature !== undefined) out.temperature = chatRequest.temperature;
    if (chatRequest.top_p !== undefined) out.topP = chatRequest.top_p;
    return out;
}
