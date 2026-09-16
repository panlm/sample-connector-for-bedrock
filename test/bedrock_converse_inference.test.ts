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

    // PIPE-124 缺陷 1：非 anthropic 分支改走单一家族裁剪（trimInferenceParams）。
    describe('gpt-5.6/6 家族裁剪（Converse 路径接单一家族表）', () => {
        it('temperature=0.7（非默认）→ 被剔除，结果不含 temperature/topP（核心验收 REQ-1）', () => {
            expect(buildBaseInferenceParams('global.openai.gpt-6-astra', { temperature: 0.7 })).toEqual({});
            expect(buildBaseInferenceParams('openai.gpt-5.6', { temperature: 0.7 })).toEqual({});
        });
        it('temperature=1（允许值）→ 放行', () => {
            expect(buildBaseInferenceParams('global.openai.gpt-6-astra', { temperature: 1 })).toEqual({ temperature: 1 });
        });
        it('top_p → 一律剔除（gpt-6 不支持 topP）', () => {
            expect(buildBaseInferenceParams('global.openai.gpt-6-astra', { top_p: 0.9 })).toEqual({});
            expect(buildBaseInferenceParams('global.openai.gpt-6-astra', { temperature: 0.7, top_p: 0.9 })).toEqual({});
        });
    });

    describe('gpt-oss 家族透传（REQ-2：值真的进入 payload，不被裁）', () => {
        it('temperature=0.7 → 原样透传', () => {
            expect(buildBaseInferenceParams('openai.gpt-oss-120b-1:0', { temperature: 0.7 })).toEqual({ temperature: 0.7 });
        });
        it('top_p=0.9 → 映射为 topP 透传', () => {
            expect(buildBaseInferenceParams('openai.gpt-oss-120b-1:0', { top_p: 0.9 })).toEqual({ topP: 0.9 });
        });
        it('temperature + top_p → 两者都透传', () => {
            expect(buildBaseInferenceParams('openai.gpt-oss-120b-1:0', { temperature: 0.7, top_p: 0.9 })).toEqual({
                temperature: 0.7,
                topP: 0.9,
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
