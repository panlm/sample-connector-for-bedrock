import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageConverter } from '../src/providers/bedrock_converse';

// PIPE-124 缺陷 2：thinking 注入按模型家族门控（supportsThinking，唯一实现）。
// 非支持家族（GPT 系）即使 config.thinking:true 也不注入 Anthropic 私有 thinking 字段、
// 不把 temperature 强改为 1；且留一条可诊断日志。anthropic 家族回归：thinking 仍注入。
describe('bedrock-converse thinking 分家族门控', () => {
    const converter = new MessageConverter();
    const baseMessages = [{ role: 'user', content: 'hi' }];

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('非支持家族（gpt-6）+ config.thinking:true', () => {
        it('payload 不含 additionalModelRequestFields.thinking，且 temperature 未被强改为 1', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const payload = await converter.toPayload(
                { messages: baseMessages, temperature: 0.7 } as any,
                { modelId: 'global.openai.gpt-6-astra', thinking: true },
            );

            // 无 Anthropic 私有字段
            expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
            // temperature 未被 thinking 强改为 1（gpt-6 家族裁剪后应不含 temperature）
            expect(payload.inferenceConfig.temperature).toBeUndefined();
            // 可诊断日志命中
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('thinking requested but model family does not support it'),
            );
        });

        it('gpt-oss + config.thinking:true 同样不注入 thinking，透传的 temperature 不被改写', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const payload = await converter.toPayload(
                { messages: baseMessages, temperature: 0.7 } as any,
                { modelId: 'openai.gpt-oss-120b-1:0', thinking: true },
            );
            expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
            expect(payload.inferenceConfig.temperature).toBe(0.7); // gpt-oss 透传，不被 thinking 置 1
        });
    });

    describe('支持家族（anthropic）+ thinking（回归：仍注入）', () => {
        it('config.thinking:true → 注入 thinking 字段且 temperature=1', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages } as any,
                { modelId: 'global.anthropic.claude-sonnet-4', thinking: true },
            );
            expect(payload.additionalModelRequestFields.thinking).toEqual({
                type: 'enabled',
                budget_tokens: 1024,
            });
            expect(payload.inferenceConfig.temperature).toBe(1);
            expect(payload.inferenceConfig.topP).toBeUndefined();
        });

        it('客户端请求体 thinking.type=enabled → 同样注入（非配置来源也门控通过）', async () => {
            const payload = await converter.toPayload(
                { messages: baseMessages, thinking: { type: 'enabled', budget_tokens: 2048 } } as any,
                { modelId: 'anthropic.claude-3-5-sonnet' },
            );
            expect(payload.additionalModelRequestFields.thinking).toEqual({
                type: 'enabled',
                budget_tokens: 2048,
            });
            expect(payload.inferenceConfig.temperature).toBe(1);
        });
    });

    describe('thinking 未开启时行为不变', () => {
        it('gpt-6 无 thinking → 无警告、无 thinking 字段', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const payload = await converter.toPayload(
                { messages: baseMessages, temperature: 1 } as any,
                { modelId: 'global.openai.gpt-6-astra' },
            );
            expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
            expect(warn).not.toHaveBeenCalledWith(
                expect.stringContaining('thinking requested but model family does not support it'),
            );
        });
    });
});
