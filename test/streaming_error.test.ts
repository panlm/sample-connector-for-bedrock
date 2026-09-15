import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 隔离 AWS Bedrock SDK：用 class stub 使 `new BedrockRuntimeClient()` 可用，
//    其 send 指向共享 sendMock，逐用例控制返回/抛错。绝不连真实 Bedrock。——
const sendMock = vi.fn();
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: class {
        send = sendMock;
    },
    ConverseStreamCommand: class {
        constructor(public input: any) {}
    },
    ConverseCommand: class {
        constructor(public input: any) {}
    },
}));
vi.mock('../src/config', () => ({
    default: { pgsql: {}, performanceMode: false, bedrock: { region: 'us-east-1' }, debugMode: false },
}));
vi.mock('../src/util/logger', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), silly: vi.fn() },
}));
vi.mock('../src/util/cache', () => ({
    default: { models: [], api_keys: [], connectors: [], updateKeyFee: vi.fn() },
}));

import BedrockConverse from '../src/providers/bedrock_converse';
import helper from '../src/util/helper';

// 构造一个可控 modelData：credentials + regions + maxRetries
function makeBC(maxRetries = 3) {
    const bc = new BedrockConverse();
    bc.setModelData({
        config: {
            modelId: 'anthropic.claude-3',
            credentials: [{ accessKeyId: 'AK1', secretAccessKey: 's1' }],
            regions: ['us-east-1'],
            maxRetries,
        },
    });
    bc.setKeyData({ id: 1 });
    // 避免真实消息转换：直接给个空 payload
    vi.spyOn(bc.chatMessageConverter, 'toPayload').mockResolvedValue({} as any);
    return bc;
}

function makeCtx() {
    const writes: string[] = [];
    return {
        writes,
        ctx: {
            status: 0,
            headers: {},
            set: vi.fn(),
            logger: { error: vi.fn(), info: vi.fn() },
            res: {
                finished: false,
                write: (s: string) => { writes.push(s); return true; },
                end: vi.fn(),
                on: vi.fn(),
            },
        } as any,
    };
}

// 把一组 item 包成 async 可迭代 stream
function asyncStream(items: any[]) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const it of items) yield it;
        },
    };
}

beforeEach(() => {
    sendMock.mockReset();
});

describe('链路4 · bedrock_converse 流式/重试错误路径', () => {
    // AC-16：重试总次数 = maxRetry+1 = 4，耗尽后抛 enhancedError，$metadata 保留
    it('AC-16: 持续失败 → 尝试 4 次(maxRetry+1) → enhancedError，$metadata 保留', async () => {
        const bc = makeBC(3);
        const awsErr: any = new Error('boom');
        awsErr.name = 'ThrottlingException';
        awsErr.$metadata = { httpStatusCode: 429 };
        sendMock.mockRejectedValue(awsErr);

        const { ctx, writes } = makeCtx();
        await expect(
            bc.chat({ model: 'm', model_id: 'anthropic.claude-3', stream: true, messages: [] } as any, 'sess', ctx)
        ).rejects.toMatchObject({
            message: expect.stringContaining('Maximum retry attempts (3) exceeded'),
            $metadata: { httpStatusCode: 429 },
        });
        expect(sendMock).toHaveBeenCalledTimes(4);
        // AC-17③：错误发生在首个 write 之前 → 客户端无任何数据帧
        expect(writes.filter((w) => w.startsWith('data:'))).toHaveLength(0);
    });

    // AC-17：成功路径 → 写出内容 + [DONE]，且重试计数归零、excludeAccessKeyId 复位
    it('AC-17: 成功流 → 写出 content 与 [DONE]，retryCount 归零', async () => {
        const bc = makeBC(3);
        vi.spyOn(bc as any, 'saveThread').mockResolvedValue(null); // 隔离计费/db
        sendMock.mockResolvedValue({
            stream: asyncStream([
                { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
                { metadata: { usage: { inputTokens: 1, outputTokens: 1 }, metrics: { latencyMs: 5 } } },
            ]),
        });

        const { ctx, writes } = makeCtx();
        await bc.chat({ model: 'm', model_id: 'x', stream: true, messages: [] } as any, 'sess', ctx);

        expect(writes.some((w) => w.includes('Hello'))).toBe(true);
        expect(writes).toContain('data: [DONE]\n\n');
        expect(ctx.res.end).toHaveBeenCalled();
        expect((bc as any).retryCount).toBe(0);
        expect((bc as any).excludeAccessKeyId).toBeNull();
    });

    // AC-18 [R-002 缺陷证据]：错误发生在首个 write 之后 → 客户端收不到 [DONE]，也无 in-stream error 帧
    it('AC-18 [R-002 缺陷证据]: write 后流中途抛错 → 无 [DONE]、无 error 帧、流未 end()', async () => {
        const bc = makeBC(1); // 少重试，快速耗尽
        // 每次 send 都返回一个"先吐一个 token 再抛错"的流
        sendMock.mockImplementation(() => Promise.resolve({
            stream: {
                async *[Symbol.asyncIterator]() {
                    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'partial-token' } } };
                    throw new Error('mid-stream failure');
                },
            },
        }));

        const { ctx, writes } = makeCtx();
        await expect(
            bc.chat({ model: 'm', model_id: 'x', stream: true, messages: [] } as any, 'sess', ctx)
        ).rejects.toThrow(/Maximum retry attempts/);

        // 部分 token 已经写出去了
        expect(writes.some((w) => w.includes('partial-token'))).toBe(true);
        // 但客户端永远收不到终止信号，也没有结构化 error 帧
        expect(writes).not.toContain('data: [DONE]\n\n');
        expect(writes.some((w) => w.toLowerCase().includes('error'))).toBe(false);
        // chatStream 抛出前未走到 ctx.res.end()
        expect(ctx.res.end).not.toHaveBeenCalled();
    });

    // AC-19 [R-001 缺陷证据]①：excludeAccessKeyId 是实例字段 → 上一个请求遗留的排除态污染下一个请求
    it('AC-19① [R-001 缺陷证据]: 遗留 excludeAccessKeyId 污染下一请求的凭证选择', async () => {
        const bc = makeBC(3);
        vi.spyOn(bc as any, 'saveThread').mockResolvedValue(null);
        // 给两个凭证，便于观察排除效果
        bc.setModelData({
            config: {
                modelId: 'anthropic.claude-3',
                credentials: [
                    { accessKeyId: 'AK1', secretAccessKey: 's1' },
                    { accessKeyId: 'AK2', secretAccessKey: 's2' },
                ],
                regions: ['us-east-1'],
                maxRetries: 3,
            },
        });
        // 模拟"上一个请求"在重试中途遗留下来的实例状态
        (bc as any).excludeAccessKeyId = 'AK1';
        const credSpy = vi.spyOn(helper, 'selectCredentials');
        sendMock.mockResolvedValue({ stream: asyncStream([
            { metadata: { usage: { inputTokens: 0, outputTokens: 0 }, metrics: { latencyMs: 1 } } },
        ]) });

        const { ctx } = makeCtx();
        await bc.chat({ model: 'm', model_id: 'x', stream: true, messages: [] } as any, 'sess', ctx);

        // 新请求的凭证选择被上一个请求的遗留排除态影响 → 无 per-request 隔离
        expect(credSpy).toHaveBeenCalledWith(expect.anything(), 'AK1');
    });

    // AC-19 [R-001 缺陷证据]②：单例复用同一个 BedrockConverse 实例，retryCount 为共享可变字段
    it('AC-19② [R-001 缺陷证据]: provider 单例复用同一实例，retryCount 是共享实例字段', async () => {
        // 从单例读取 bedrock-converse：任何请求拿到的都是同一个对象引用
        const provider = (await import('../src/providers/provider')).default;
        const a: any = provider['bedrock-converse'];
        const b: any = provider['bedrock-converse'];
        expect(a).toBe(b); // 同一引用 → 无 per-request 实例
        expect(a instanceof BedrockConverse).toBe(true);
        // retryCount / excludeAccessKeyId 是实例自有字段（跨请求共享的可变状态）
        a.retryCount = 2;
        expect(b.retryCount).toBe(2);
        expect(Object.prototype.hasOwnProperty.call(a, 'retryCount')).toBe(true);
        a.retryCount = 0; // 复位，避免影响其他用例
    });
});
