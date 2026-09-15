import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config', () => ({
    default: { pgsql: {}, performanceMode: false, bedrock: { region: 'us-east-1' } },
}));
vi.mock('../src/util/logger', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), silly: vi.fn() },
}));
// Cache.updateKeyFee 在 updateKeyFee 尾部被调用 → mock 掉，避免真实缓存副作用
const updateKeyFeeSpy = vi.fn();
vi.mock('../src/util/cache', () => ({
    default: { models: [], api_keys: [], connectors: [], updateKeyFee: (...a: any[]) => updateKeyFeeSpy(...a) },
}));
// api_key.rebillMonthly 仅在跨月分支触发；用例统一把 updated_at 设为当月避免它
vi.mock('../src/service/key', () => ({ default: { rebillMonthly: vi.fn() } }));

import provider from '../src/providers/provider';

// 单例里的 bedrock-converse 是一个 AbstractProvider 实例，带 updateKeyFee / saveThread
const abstractProvider: any = provider['bedrock-converse'];

describe('链路3 · checkFee 配额闸门', () => {
    const now = new Date();

    // AC-11：month_fee>=quota 且 balance<=0 → 抛 "Please recharge."
    it('AC-11①: month_fee=10, quota=5, balance=0 → 抛 Please recharge.', async () => {
        const key = { month_fee: '10', month_quota: '5', balance: '0', updated_at: now, id: 1 };
        await expect(provider.checkFee({ db: {} } as any, key)).rejects.toThrow('Please recharge.');
    });

    // AC-11：余额 >0 → 放行（即便 month_fee>=quota）
    it('AC-11②: balance=1（>0）→ 放行', async () => {
        const key = { month_fee: '10', month_quota: '5', balance: '1', updated_at: now, id: 1 };
        await expect(provider.checkFee({ db: {} } as any, key)).resolves.toBeUndefined();
    });

    // AC-11：month_fee < quota → 放行
    it('AC-11③: month_fee=3 < quota=5 → 放行', async () => {
        const key = { month_fee: '3', month_quota: '5', balance: '0', updated_at: now, id: 1 };
        await expect(provider.checkFee({ db: {} } as any, key)).resolves.toBeUndefined();
    });

    // AC-12 (R-004 缺陷证据)：字段缺失 → parseFloat=NaN → NaN>=NaN 为 false → 闸门被跳过（fail-open）
    // 测试如实固化"当前放行行为"，非验证其正确；修法交 dev。
    it('AC-12 [R-004 缺陷证据]: 缺 month_fee/quota/balance → NaN 比较为 false → 放行(fail-open)', async () => {
        const key = { updated_at: now, id: 1 }; // 无计费字段
        await expect(provider.checkFee({ db: {} } as any, key)).resolves.toBeUndefined();
    });
});

describe('链路3 · updateKeyFee 扣费 SQL 参数', () => {
    beforeEach(() => updateKeyFeeSpy.mockClear());

    // AC-13①：month_fee+fee < quota → month_fee 累加，SQL 参数正确
    it('AC-13①: month_fee=0,quota=100,fee=2 → SQL [2, 2, Date, id]', async () => {
        abstractProvider.setKeyData({ id: 7, month_fee: '0', month_quota: '100', balance: '0', total_fee: '0' });
        const query = vi.fn().mockResolvedValue({ id: 7 });
        const ctx: any = { db: { query }, user: { id: 7 } };
        await abstractProvider.updateKeyFee(ctx, 2);
        expect(query).toHaveBeenCalledOnce();
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('update eiai_key set total_fee=total_fee+$1');
        expect(params[0]).toBe(2); // fee
        expect(params[1]).toBe(2); // 新 month_fee = 0 + 2
        expect(params[3]).toBe(7); // key id
    });

    // AC-13②：month_fee+fee >= quota → 扣 balance，month_fee 封顶为 quota
    it('AC-13②: month_fee=90,quota=100,balance=5,fee=20 → month_fee 封顶100，balance 扣至 -5', async () => {
        abstractProvider.setKeyData({ id: 8, month_fee: '90', month_quota: '100', balance: '5', total_fee: '0' });
        const query = vi.fn().mockResolvedValue({ id: 8 });
        const ctx: any = { db: { query }, user: { id: 8 } };
        await abstractProvider.updateKeyFee(ctx, 20);
        const [, params] = query.mock.calls[0];
        expect(params[1]).toBe(100); // month_fee 封顶 = quota
        // ctx.user 被写成 keyDataUpdate，balance = 5 - (90+20-100) = -5
        expect(ctx.user.balance).toBe(-5);
    });
});

describe('链路3 · saveThread 不计费旁路 (R-005)', () => {
    // AC-14①：performanceMode → 直接 return null，不触碰 db
    it('AC-14① [R-005]: performanceMode=true → 返回 null，不调 db', async () => {
        const db = { insert: vi.fn(), query: vi.fn(), save: vi.fn(), loadByKV: vi.fn() };
        const ctx: any = { performanceMode: true, db, user: { id: 1 } };
        const res = await abstractProvider.saveThread(ctx, 'sess', { messages: [] } as any, {} as any);
        expect(res).toBeNull();
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
    });

    // AC-14②：无 db → 同样 return null（完全不计费）
    it('AC-14② [R-005]: 无 ctx.db → 返回 null，不计费', async () => {
        const ctx: any = { performanceMode: false, db: undefined, user: { id: 1 } };
        const res = await abstractProvider.saveThread(ctx, 'sess', { messages: [] } as any, {} as any);
        expect(res).toBeNull();
    });
});
