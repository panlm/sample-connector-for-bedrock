import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageConverter } from '../src/providers/bedrock_converse';
import {
    supportsStopSequences,
    deprecatesSamplingParams,
    thinkingFields,
} from '../src/util/bedrock_openai_endpoint';

// PIPE-130 / PIPE-128 三条既有缺陷的回归测试。
// 全部断言基于真实 Converse 调用确认的容忍度（ap-northeast-1，见交付评论矩阵）：
//   - stopSequences：anthropic 全接受；gpt-6 / gpt-oss 拒（400 doesn't support the stopSequences field）。
//   - temperature/top_p：opus gen≥4 + 任意家族 gen≥5（opus-5/sonnet-5/opus-4-8）拒（`... is deprecated`）；
//     sonnet-4-5 / sonnet-4-6 接受（保留互斥语义）。
//   - thinking：上述「已弃用采样参数」的同一集合要求 type=adaptive 且不接受 budget_tokens；
//     sonnet-4-5 / sonnet-4-6 仍用 type=enabled + budget_tokens。GPT 系不支持 thinking。
describe('PIPE-130 三缺陷回归（改动前必失败）', () => {
    const converter = new MessageConverter();
    const baseMessages = [{ role: 'user', content: 'hi' }];

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ── 缺陷 1：stop / stopSequences 未按家族裁剪 ──────────────────────────────
    describe('缺陷 1：stopSequences 按家族逐项裁剪', () => {
        it('gpt-6 传 stop → payload 不含 stopSequences（真链路：gpt-6 拒 stopSequences）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, stop: ['STOP'] } as any,
                { modelId: 'global.openai.gpt-6-astra' },
            );
            expect(payload.inferenceConfig.stopSequences).toBeUndefined();
        });

        it('gpt-oss 传 stop → payload 不含 stopSequences（真链路：gpt-oss 拒 stopSequences，尽管接受 temp/top_p）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, stop: ['\n\n'] } as any,
                { modelId: 'openai.gpt-oss-120b-1:0' },
            );
            expect(payload.inferenceConfig.stopSequences).toBeUndefined();
        });

        it('回归：anthropic (opus-5) 传 stop → 仍注入 stopSequences（真链路：anthropic 接受）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, stop: ['STOP'] } as any,
                { modelId: 'global.anthropic.claude-opus-5' },
            );
            expect(payload.inferenceConfig.stopSequences).toEqual(['STOP']);
        });

        it('谓词 supportsStopSequences：GPT 系 false，其余 true', () => {
            expect(supportsStopSequences('global.openai.gpt-6-astra')).toBe(false);
            expect(supportsStopSequences('openai.gpt-oss-120b-1:0')).toBe(false);
            expect(supportsStopSequences('openai.gpt-5.6-terra')).toBe(false);
            expect(supportsStopSequences('global.anthropic.claude-opus-5')).toBe(true);
            expect(supportsStopSequences('anthropic.claude-sonnet-4-5')).toBe(true);
            expect(supportsStopSequences('deepseek.r1')).toBe(true);
        });
    });

    // ── 缺陷 2：opus-5 被 opus4+ 子串判定漏掉 ─────────────────────────────────
    describe('缺陷 2：采样参数弃用判定覆盖「opus gen≥4 + 任意家族 gen≥5」', () => {
        it('opus-5 传 temperature → temperature/topP 均被剔除（真链路：opus-5 拒 temperature/top_p）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, temperature: 0.7 } as any,
                { modelId: 'global.anthropic.claude-opus-5' },
            );
            expect(payload.inferenceConfig.temperature).toBeUndefined();
            expect(payload.inferenceConfig.topP).toBeUndefined();
        });

        it('sonnet-5 传 temperature → temperature/topP 均被剔除（真链路：sonnet-5 同样弃用）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, temperature: 0.7 } as any,
                { modelId: 'global.anthropic.claude-sonnet-5' },
            );
            expect(payload.inferenceConfig.temperature).toBeUndefined();
            expect(payload.inferenceConfig.topP).toBeUndefined();
        });

        it('回归：opus-4-8 传 temperature → 仍被剔除（原 includes("claude-opus-4") 已覆盖，行为不变）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, temperature: 0.7 } as any,
                { modelId: 'global.anthropic.claude-opus-4-8' },
            );
            expect(payload.inferenceConfig.temperature).toBeUndefined();
            expect(payload.inferenceConfig.topP).toBeUndefined();
        });

        it('回归：sonnet-4-5 传 temperature → 保留 temperature（真链路：接受，互斥逻辑删 topP）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, temperature: 0.3 } as any,
                { modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0' },
            );
            expect(payload.inferenceConfig.temperature).toBe(0.3);
            expect(payload.inferenceConfig.topP).toBeUndefined();
        });

        it('回归：sonnet-4-6 传 temperature → 保留（真链路：接受）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, temperature: 0.3 } as any,
                { modelId: 'global.anthropic.claude-sonnet-4-6' },
            );
            expect(payload.inferenceConfig.temperature).toBe(0.3);
        });

        it('谓词 deprecatesSamplingParams：opus gen≥4 + 任意 gen≥5 为 true，legacy 为 false', () => {
            expect(deprecatesSamplingParams('global.anthropic.claude-opus-5')).toBe(true);
            expect(deprecatesSamplingParams('global.anthropic.claude-sonnet-5')).toBe(true);
            expect(deprecatesSamplingParams('anthropic.claude-fable-5')).toBe(true);
            expect(deprecatesSamplingParams('global.anthropic.claude-opus-4-8')).toBe(true);
            expect(deprecatesSamplingParams('global.anthropic.claude-opus-4-6-v1')).toBe(true);
            expect(deprecatesSamplingParams('anthropic.claude-opus-4-5-20251101-v1:0')).toBe(true);
            // legacy：保持互斥语义
            expect(deprecatesSamplingParams('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(false);
            expect(deprecatesSamplingParams('global.anthropic.claude-sonnet-4-6')).toBe(false);
            expect(deprecatesSamplingParams('anthropic.claude-sonnet-4-20250514-v1:0')).toBe(false);
            expect(deprecatesSamplingParams('anthropic.claude-3-5-sonnet')).toBe(false);
            expect(deprecatesSamplingParams('anthropic.claude-3-7-sonnet')).toBe(false);
            expect(deprecatesSamplingParams('')).toBe(false);
        });
    });

    // ── 缺陷 3：thinking 硬编码 type:"enabled" ───────────────────────────────
    describe('缺陷 3：thinking.type 按代次选择 adaptive/enabled', () => {
        it('opus-5 + thinking → type=adaptive 且不含 budget_tokens（真链路：opus-5 拒 enabled 与 adaptive.budget_tokens）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, thinking: { type: 'enabled', budget_tokens: 2048 } } as any,
                { modelId: 'global.anthropic.claude-opus-5' },
            );
            expect(payload.additionalModelRequestFields.thinking.type).toBe('adaptive');
            expect(payload.additionalModelRequestFields.thinking.budget_tokens).toBeUndefined();
            // opus-5 弃用采样参数：adaptive 路径下 temperature 也不得注入
            expect(payload.inferenceConfig.temperature).toBeUndefined();
        });

        it('回归：sonnet-4-5 + thinking → type=enabled + budget_tokens（真链路：接受 enabled）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, thinking: { type: 'enabled', budget_tokens: 2048 } } as any,
                { modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0' },
            );
            expect(payload.additionalModelRequestFields.thinking).toEqual({
                type: 'enabled',
                budget_tokens: 2048,
            });
        });

        it('GPT 系 + thinking → 忽略 + 警告，不注入 thinking（不回退）', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const payload = await converter.toPayload(
                { messages: baseMessages, thinking: { type: 'enabled', budget_tokens: 2048 } } as any,
                { modelId: 'global.openai.gpt-6-astra' },
            );
            expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('thinking requested but model family does not support it'),
            );
        });

        it('谓词 thinkingFields：弃用集合 → adaptive(no budget)，legacy → enabled+budget', () => {
            expect(thinkingFields('global.anthropic.claude-opus-5', 1024)).toEqual({ type: 'adaptive' });
            expect(thinkingFields('global.anthropic.claude-sonnet-5', 1024)).toEqual({ type: 'adaptive' });
            expect(thinkingFields('anthropic.claude-sonnet-4-5', 1024)).toEqual({
                type: 'enabled',
                budget_tokens: 1024,
            });
            expect(thinkingFields('global.anthropic.claude-sonnet-4-6', 2048)).toEqual({
                type: 'enabled',
                budget_tokens: 2048,
            });
        });
    });
});
