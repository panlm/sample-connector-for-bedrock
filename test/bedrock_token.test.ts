import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 边界 mock：在 import 前 hoist，隔离官方铸造包，杜绝真实网络/凭证访问 ——
const getToken = vi.fn();
const getTokenProvider = vi.fn();
vi.mock('@aws/bedrock-token-generator', () => ({
    getToken: (...args: any[]) => getToken(...args),
    getTokenProvider: (...args: any[]) => getTokenProvider(...args),
}));

import {
    getBedrockBearerToken,
    __clearBedrockTokenCacheForTest,
} from '../src/util/bedrock_token';

describe('getBedrockBearerToken —— 缓存 + 过期前刷新', () => {
    beforeEach(() => {
        __clearBedrockTokenCacheForTest();
        getToken.mockReset();
        getTokenProvider.mockReset();
        let n = 0;
        // default 通路：getTokenProvider() 返回一个铸造函数，每次调用产出新 token
        getTokenProvider.mockImplementation(() => async () => `default-token-${++n}`);
        // static 通路：getToken 直接产出
        let m = 0;
        getToken.mockImplementation(async () => `static-token-${++m}`);
    });

    it('连续两次取（未过期）→ 铸造仅发生一次（命中缓存）', async () => {
        const now = 1_000_000;
        const t1 = await getBedrockBearerToken('us-west-2', 'bedrock', { kind: 'default' }, () => now);
        const t2 = await getBedrockBearerToken('us-west-2', 'bedrock', { kind: 'default' }, () => now + 1000);
        expect(t1).toBe('default-token-1');
        expect(t2).toBe('default-token-1');
        expect(getTokenProvider).toHaveBeenCalledTimes(1);
    });

    it('时间越过 expiresAt - skew → 触发重铸', async () => {
        const base = 1_000_000;
        const first = await getBedrockBearerToken('us-west-2', 'bedrock', { kind: 'default' }, () => base);
        expect(first).toBe('default-token-1');
        // TTL=1h(3600_000ms)，skew=5min(300_000ms)。越过 base + 3600000 - 300000 即需刷新。
        const afterSkew = base + 3_600_000 - 300_000 + 1;
        const second = await getBedrockBearerToken('us-west-2', 'bedrock', { kind: 'default' }, () => afterSkew);
        expect(second).toBe('default-token-2');
        expect(getTokenProvider).toHaveBeenCalledTimes(2);
    });

    it('default 与 static 两种凭证来源独立缓存，不串键', async () => {
        const now = 2_000_000;
        const d = await getBedrockBearerToken('us-west-2', 'bedrock', { kind: 'default' }, () => now);
        const s = await getBedrockBearerToken(
            'us-west-2',
            'bedrock',
            { kind: 'static', accessKeyId: 'AK1', secretAccessKey: 'SK1' },
            () => now,
        );
        expect(d).toBe('default-token-1');
        expect(s).toBe('static-token-1');
        expect(getTokenProvider).toHaveBeenCalledTimes(1);
        expect(getToken).toHaveBeenCalledTimes(1);
    });

    it('runtime / mantle 两种 service 独立缓存，不串键', async () => {
        const now = 3_000_000;
        const a = await getBedrockBearerToken('us-west-2', 'bedrock', { kind: 'default' }, () => now);
        const b = await getBedrockBearerToken('us-west-2', 'bedrock-mantle', { kind: 'default' }, () => now);
        expect(a).toBe('default-token-1');
        expect(b).toBe('default-token-2');
        expect(getTokenProvider).toHaveBeenCalledTimes(2);
    });

    it('不同静态 accessKeyId 独立缓存', async () => {
        const now = 4_000_000;
        const a = await getBedrockBearerToken('us-west-2', 'bedrock', { kind: 'static', accessKeyId: 'AK1', secretAccessKey: 'x' }, () => now);
        const b = await getBedrockBearerToken('us-west-2', 'bedrock', { kind: 'static', accessKeyId: 'AK2', secretAccessKey: 'y' }, () => now);
        expect(a).toBe('static-token-1');
        expect(b).toBe('static-token-2');
        expect(getToken).toHaveBeenCalledTimes(2);
    });

    it('static 通路把区域与静态凭证透传给 getToken', async () => {
        const now = 5_000_000;
        await getBedrockBearerToken(
            'eu-west-1',
            'bedrock',
            { kind: 'static', accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' },
            () => now,
        );
        expect(getToken).toHaveBeenCalledWith(
            expect.objectContaining({
                region: 'eu-west-1',
                credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' },
            }),
        );
    });
});
