import { describe, it, expect } from 'vitest';
import { buildBaseInferenceParams } from '../src/util/inference_params';

// item 4（父 issue 必做 4）：bedrock_converse.ts 的 temperature/topP 基础注入修复。
describe('buildBaseInferenceParams (item 4 修复)', () => {
    describe('非 anthropic 模型', () => {
        it('客户端未传 temperature/top_p → 结果不含 temperature/topP（不再无条件注入 0.7）', () => {
            expect(buildBaseInferenceParams('deepseek.r1', {})).toEqual({});
            expect(buildBaseInferenceParams('openai.gpt-6-astra', {})).toEqual({});
            expect(buildBaseInferenceParams('meta.llama3', { max_tokens: 100 })).toEqual({});
        });
        it('客户端显式传值 → 透传', () => {
            expect(buildBaseInferenceParams('deepseek.r1', { temperature: 0.3 })).toEqual({ temperature: 0.3 });
            expect(buildBaseInferenceParams('deepseek.r1', { top_p: 0.8 })).toEqual({ topP: 0.8 });
            expect(buildBaseInferenceParams('deepseek.r1', { temperature: 0.3, top_p: 0.8 })).toEqual({
                temperature: 0.3,
                topP: 0.8,
            });
        });
    });

    describe('anthropic 分支行为不变（回归）', () => {
        it('未传 → 仍注入 0.7 默认（与改动前一致）', () => {
            expect(buildBaseInferenceParams('anthropic.claude-3-5-sonnet', {})).toEqual({
                temperature: 0.7,
                topP: 0.7,
            });
        });
        it('传 temperature → 覆盖，topP 仍取默认 0.7', () => {
            expect(buildBaseInferenceParams('anthropic.claude-3-5-sonnet', { temperature: 0.2 })).toEqual({
                temperature: 0.2,
                topP: 0.7,
            });
        });
        it('传 top_p → 覆盖，temperature 仍取默认 0.7', () => {
            expect(buildBaseInferenceParams('anthropic.claude-3-5-sonnet', { top_p: 0.1 })).toEqual({
                temperature: 0.7,
                topP: 0.1,
            });
        });
        it('temperature=0 走 || 0.7（保持改动前的既有 falsy 行为，不擅自变更）', () => {
            // 原代码即 `chatRequest.temperature || 0.7`，0 会被兜成 0.7。此处固定该既有行为以证明零变化。
            expect(buildBaseInferenceParams('anthropic.claude-3-5-sonnet', { temperature: 0 })).toEqual({
                temperature: 0.7,
                topP: 0.7,
            });
        });
    });
});
