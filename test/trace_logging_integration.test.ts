import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'stream';
import { transports } from 'winston';

// —— 集成 mock 边界：隔离外部副作用（config/pg/cache/response），
// 但**保留真实的 logger 与真实的 trace（als/getTraceId）** ——
// 目的：端到端验证 traceContextHandler → loggerHandler → 业务日志
// 产出的是真正打到 stdout 的单行 JSON，且同一请求的多条日志带同一 traceId。
vi.mock('../src/config', () => ({
    default: { pgsql: {}, debugMode: false, performanceMode: false },
}));
vi.mock('../src/util/postgres', () => ({ default: { build: vi.fn() } }));
vi.mock('../src/util/cache', () => ({
    default: { models: {}, api_keys: [], connectors: [] },
}));
vi.mock('../src/util/response', () => ({
    default: { error: vi.fn((message: any, detail: any) => ({ message, detail })) },
    extractErrorDetails: vi.fn(() => ({})),
}));

import logger from '../src/util/logger';
import { traceContextHandler, loggerHandler } from '../src/middleware/handlers';

// 最小 koa 风格 ctx：get 大小写不敏感、缺失回 ''；set 记进 resHeaders。
function makeCtx(reqHeaders: Record<string, string> = {}, path = '/v1/chat/completions') {
    const lower: Record<string, string> = {};
    for (const k of Object.keys(reqHeaders)) lower[k.toLowerCase()] = reqHeaders[k];
    const resHeaders: Record<string, string> = {};
    return {
        path,
        get: (name: string) => lower[name.toLowerCase()] ?? '',
        set: (name: string, val: string) => { resHeaders[name] = val; },
        res: { on: vi.fn(), finished: true },
        resHeaders,
    };
}

// 采集 winston 顶层 format 之后真正写出的文本行（就是 Console 打到 stdout 的那一行）。
async function captureRequest(
    ctx: any,
    business: (ctx: any) => Promise<void> | void,
): Promise<string[]> {
    const chunks: string[] = [];
    const sink = new Writable({
        write(chunk: any, _enc: any, cb: () => void) {
            chunks.push(chunk.toString());
            cb();
        },
    });
    const streamTransport: any = new transports.Stream({ stream: sink });
    logger.add(streamTransport);
    try {
        // 真实中间件链：trace 最外层 → loggerHandler 建 child logger → 业务逻辑打日志。
        await traceContextHandler(ctx, () => loggerHandler(ctx, () => business(ctx)));
    } finally {
        logger.remove(streamTransport);
    }
    return chunks.join('').split('\n').filter((l) => l.trim().length > 0);
}

describe('trace + 单行 JSON 日志 端到端集成（父#1 / 父#2）', () => {
    it('同一请求产生 ≥2 条日志 → 全部为单行合法 JSON 且 traceId 相同、等于响应头 X-Request-Id', async () => {
        const ctx = makeCtx();
        const lines = await captureRequest(ctx, async (c) => {
            c.logger.info('entered handler');
            await Promise.resolve(); // 跨一次 await 边界
            c.logger.info('finished handler');
        });

        // 至少两条日志（业务里打了两条）。
        expect(lines.length).toBeGreaterThanOrEqual(2);

        const parsed = lines.map((line) => {
            // 每一非空行必须是单行合法 JSON（父#2：JSON.parse 单行不抛）。
            let obj: any;
            expect(() => { obj = JSON.parse(line); }).not.toThrow();
            expect(line).not.toMatch(/\n/);
            // 四个必备字段（level/time/traceId/msg）。
            expect(obj).toHaveProperty('level');
            expect(obj).toHaveProperty('time');
            expect(obj).toHaveProperty('traceId');
            expect(obj).toHaveProperty('msg');
            return obj;
        });

        // 父#1：同一请求的多条日志带同一 traceId。
        const ids = new Set(parsed.map((o) => o.traceId));
        expect(ids.size).toBe(1);
        const traceId = parsed[0].traceId;
        expect(traceId).toBeTruthy();
        // traceId 与回写响应头一致（可端到端关联）。
        expect(ctx.resHeaders['X-Request-Id']).toBe(traceId);
        // 两条业务消息都在，且各自带同一 traceId。
        expect(parsed.map((o) => o.msg)).toEqual(
            expect.arrayContaining(['entered handler', 'finished handler']),
        );
    });

    it('两个独立请求 → 各自日志的 traceId 互不相同（父#1 反向）', async () => {
        const a = await captureRequest(makeCtx(), (c) => { c.logger.info('req A log'); });
        const b = await captureRequest(makeCtx(), (c) => { c.logger.info('req B log'); });

        const idA = JSON.parse(a[0]).traceId;
        const idB = JSON.parse(b[0]).traceId;
        expect(idA).toBeTruthy();
        expect(idB).toBeTruthy();
        expect(idA).not.toBe(idB);
    });

    it('沿用上游 X-Request-Id 时，同一请求日志 traceId == 该头值（父#1 沿用路径）', async () => {
        const ctx = makeCtx({ 'X-Request-Id': 'upstream-trace-42' });
        const lines = await captureRequest(ctx, (c) => {
            c.logger.info('log one');
            c.logger.warn('log two');
        });
        const ids = new Set(lines.map((l) => JSON.parse(l).traceId));
        expect(ids).toEqual(new Set(['upstream-trace-42']));
        expect(ctx.resHeaders['X-Request-Id']).toBe('upstream-trace-42');
    });
});
