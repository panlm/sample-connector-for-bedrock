import { describe, it, expect, vi, afterEach } from 'vitest';

// 隔离 config / logger，避免 import Provider 单例时的副作用；不 mock helper，
// 契约表用真实 parseModelString，分发用例用 vi.spyOn 控制 helper 方法。
vi.mock('../src/config', () => ({
    default: { pgsql: {}, performanceMode: false, bedrock: { region: 'us-east-1' } },
}));
vi.mock('../src/util/logger', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), silly: vi.fn() },
}));

import helper from '../src/util/helper';
import provider from '../src/providers/provider';

describe('链路2 · parseModelString 契约表（真实实现）', () => {
    it('AC-7①: "a/b" → 按第一个 / 拆分', () => {
        expect(helper.parseModelString('a/b')).toEqual({ model: 'a', model_id: 'b' });
    });
    it('AC-7②: 无斜杠 → null', () => {
        expect(helper.parseModelString('claude-3')).toBeNull();
    });
    it('AC-7③: 空串 → null', () => {
        expect(helper.parseModelString('')).toBeNull();
    });
    it('AC-7④: "a/b/c" → {model:a, model_id:"b/c"}（只切第一个 /）', () => {
        expect(helper.parseModelString('a/b/c')).toEqual({ model: 'a', model_id: 'b/c' });
    });
    it('AC-7⑤: "/x" → {model:"", model_id:"x"}', () => {
        expect(helper.parseModelString('/x')).toEqual({ model: '', model_id: 'x' });
    });
    it('AC-7⑥: "a/" → {model:"a", model_id:""}', () => {
        expect(helper.parseModelString('a/')).toEqual({ model: 'a', model_id: '' });
    });
});

describe('链路2 · provider.init 分发（this[provider]）', () => {
    afterEach(() => vi.restoreAllMocks());

    function ctxFor(model: string) {
        return {
            user: undefined, // id 未 >0 → 跳过 checkFee
            db: undefined, // 跳过 checkModelAccess
            headers: {},
            request: { body: { model, messages: [] } },
        } as any;
    }

    // AC-8：已注册 provider → 返回对应实例，model/model_id 被覆盖
    it('AC-8: 已注册 provider(bedrock-converse) → 返回对应实例并覆盖 model/model_id', async () => {
        vi.spyOn(helper, 'parseModelString').mockReturnValue({ model: 'bedrock-converse', model_id: 'anthropic.claude-3' } as any);
        vi.spyOn(helper, 'refineModelParameters').mockResolvedValue({
            provider: 'bedrock-converse',
            name: 'claude-3-sonnet',
            config: {},
            price_in: 0,
            price_out: 0,
        } as any);
        const ctx = ctxFor('bedrock-converse/anthropic.claude-3');
        const res: any = await provider.init(ctx);
        expect(res.provider).toBe(provider['bedrock-converse']);
        // init 末尾 chatRequest.model 被覆盖成 modelData.name，model_id 取自 parse 结果
        expect(res.chatRequest.model).toBe('claude-3-sonnet');
        expect(res.chatRequest.model_id).toBe('anthropic.claude-3');
    });

    // AC-9 fail-closed：未注册 provider → 抛 "configure the provider correctly."
    it('AC-9: 未注册 provider → 抛 configure the provider correctly.', async () => {
        vi.spyOn(helper, 'parseModelString').mockReturnValue({ model: 'no-such', model_id: 'x' } as any);
        vi.spyOn(helper, 'refineModelParameters').mockResolvedValue({
            provider: 'no-such-provider',
            name: 'whatever',
            config: {},
        } as any);
        await expect(provider.init(ctxFor('no-such/x'))).rejects.toThrow('configure the provider correctly.');
    });

    // AC-10 (R-006)：parseModelString 返回 null → chatRequest.model_id 未被设置
    it('AC-10: parseModelString 返回 null → model_id 不被设置（R-006 静默分支）', async () => {
        vi.spyOn(helper, 'parseModelString').mockReturnValue(null as any);
        vi.spyOn(helper, 'refineModelParameters').mockResolvedValue({
            provider: 'bedrock-converse',
            name: 'default-model',
            config: {},
        } as any);
        const ctx = ctxFor('claude-3'); // 无斜杠
        const res: any = await provider.init(ctx);
        expect(res.provider).toBe(provider['bedrock-converse']);
        expect(res.chatRequest.model_id).toBeUndefined();
    });
});
