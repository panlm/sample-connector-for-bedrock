import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// —— 边界 mock：在 import handlers 前 hoist 生效，隔离外部依赖、杜绝副作用 ——
// 注意：不 mock '../src/util/trace'，本用例要验真实的 als / getTraceId。
vi.mock('../src/config', () => ({ default: { pgsql: {}, debugMode: false } }));
vi.mock('../src/util/postgres', () => ({ default: { build: vi.fn() } }));
vi.mock('../src/util/cache', () => ({ default: { models: {}, api_keys: [] } }));
vi.mock('../src/util/response', () => ({
    default: { error: vi.fn((message: any, detail: any) => ({ message, detail })) },
    extractErrorDetails: vi.fn(() => ({})),
}));
// logger.child(meta) 回一个把 meta 摊平出来的对象，方便断言 child 里带了哪些字段。
vi.mock('../src/util/logger', () => ({
    default: {
        level: 'info',
        defaultMeta: {},
        child: vi.fn((meta: any) => ({ ...meta, info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
    },
}));

import { traceContextHandler, loggerHandler, errorHandler } from '../src/middleware/handlers';
import { getTraceId } from '../src/util/trace';

// 构造一个最小 koa 风格 ctx：get 大小写不敏感、缺失回 ''；set 记进 resHeaders。
function makeCtx(reqHeaders: Record<string, string> = {}, path = '/v1/chat/completions') {
    const lower: Record<string, string> = {};
    for (const k of Object.keys(reqHeaders)) lower[k.toLowerCase()] = reqHeaders[k];
    const resHeaders: Record<string, string> = {};
    return {
        path,
        get: (name: string) => lower[name.toLowerCase()] ?? '',
        set: (name: string, val: string) => { resHeaders[name] = val; },
        // errorHandler 会注册 ctx.res.on('close', ...)，给个最小 mock。
        res: { on: vi.fn(), finished: true },
        resHeaders,
    };
}

describe('traceContextHandler — traceId 生成/沿用 + 回写头', () => {
    it('AC1: 无 trace 头时两请求各得非空且互不相等的 traceId', async () => {
        const a = makeCtx();
        const b = makeCtx();
        await traceContextHandler(a, async () => {});
        await traceContextHandler(b, async () => {});
        expect(a.resHeaders['X-Request-Id']).toBeTruthy();
        expect(b.resHeaders['X-Request-Id']).toBeTruthy();
        expect(a.resHeaders['X-Request-Id']).not.toBe(b.resHeaders['X-Request-Id']);
    });

    it('AC2: 带 X-Request-Id: fixed-123 时响应头与链内 getTraceId 均为 fixed-123', async () => {
        const ctx = makeCtx({ 'X-Request-Id': 'fixed-123' });
        let seen: string | undefined;
        await traceContextHandler(ctx, async () => { seen = getTraceId(); });
        expect(ctx.resHeaders['X-Request-Id']).toBe('fixed-123');
        expect(seen).toBe('fixed-123');
    });

    it('AC3: X-Request-Id 与 X-Amzn-Trace-Id 都非空时 X-Request-Id 优先', async () => {
        const ctx = makeCtx({ 'X-Request-Id': 'rid-1', 'X-Amzn-Trace-Id': 'amzn-9' });
        let seen: string | undefined;
        await traceContextHandler(ctx, async () => { seen = getTraceId(); });
        expect(ctx.resHeaders['X-Request-Id']).toBe('rid-1');
        expect(seen).toBe('rid-1');
    });

    it('AC3b: X-Request-Id 为空串时回落到 X-Amzn-Trace-Id', async () => {
        const ctx = makeCtx({ 'X-Request-Id': '', 'X-Amzn-Trace-Id': 'amzn-9' });
        let seen: string | undefined;
        await traceContextHandler(ctx, async () => { seen = getTraceId(); });
        expect(ctx.resHeaders['X-Request-Id']).toBe('amzn-9');
        expect(seen).toBe('amzn-9');
    });

    it('AC4: 跨至少一次 await 边界后 getTraceId() 仍与入口一致', async () => {
        const ctx = makeCtx({ 'X-Request-Id': 'trace-await' });
        let afterAwait: string | undefined;
        await traceContextHandler(ctx, async () => {
            await new Promise((r) => setTimeout(r, 5));
            await new Promise((r) => setImmediate(r));
            afterAwait = getTraceId();
        });
        expect(afterAwait).toBe('trace-await');
    });

    it('AC5: 两并发请求各自链路内 traceId 不串染', async () => {
        const seen: Record<string, string | undefined> = {};
        const mk = (id: string, delay: number) => {
            const ctx = makeCtx({ 'X-Request-Id': id });
            return traceContextHandler(ctx, async () => {
                await new Promise((r) => setTimeout(r, delay));
                seen[id] = getTraceId();
            });
        };
        // A 故意慢于 B，交错执行；正确传播下各自读到的必须是自己的 id。
        await Promise.all([mk('req-A', 20), mk('req-B', 5)]);
        expect(seen['req-A']).toBe('req-A');
        expect(seen['req-B']).toBe('req-B');
    });

    it('AC9: 外部头值按普通字符串原样传递，含注入字符也不被解释', async () => {
        const nasty = 'evil\n[FATAL] injected"; DROP';
        const ctx = makeCtx({ 'X-Request-Id': nasty });
        let seen: string | undefined;
        await traceContextHandler(ctx, async () => { seen = getTraceId(); });
        expect(seen).toBe(nasty);
        expect(ctx.resHeaders['X-Request-Id']).toBe(nasty);
    });
});

describe('loggerHandler — 请求级 child logger（FR-5 / AD-3）', () => {
    it('AC6: child logger 带当前 traceId + path，且响应头值 == 日志 traceId', async () => {
        const ctx = makeCtx({ 'X-Request-Id': 'log-777' });
        await traceContextHandler(ctx, async () => {
            await loggerHandler(ctx, async () => {});
        });
        expect(ctx.logger.traceId).toBe('log-777');
        expect(ctx.logger.path).toBe('/v1/chat/completions');
        // 响应头回写值必须等于日志上下文里的 traceId（AC6）。
        expect(ctx.resHeaders['X-Request-Id']).toBe(ctx.logger.traceId);
    });

    it('AC7: loggerHandler 不再对共享单例做逐请求赋值（child 而非改 level/defaultMeta）', async () => {
        const src = readFileSync(resolve(__dirname, '../src/middleware/handlers.ts'), 'utf-8');
        expect(src).not.toMatch(/logger\.level\s*=\s*['"]silly['"]/);
        expect(src).not.toMatch(/logger\.defaultMeta\.path\s*=/);
        expect(src).toMatch(/logger\.child\(\s*\{[^}]*traceId/);
    });
});

describe('中间件顺序与 errorHandler（AC8）', () => {
    it('AC8: index.ts 中 traceContextHandler 挂在 loggerHandler 之前、loggerHandler 在 errorHandler 之前', () => {
        const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8');
        const iTrace = src.indexOf('app.use(traceContextHandler)');
        const iLogger = src.indexOf('app.use(loggerHandler)');
        const iError = src.indexOf('app.use(errorHandler)');
        expect(iTrace).toBeGreaterThanOrEqual(0);
        expect(iLogger).toBeGreaterThan(iTrace);
        expect(iError).toBeGreaterThan(iLogger);
    });

    it('AC8: errorHandler 执行时 ctx.logger 仍可用，错误日志带 traceId', async () => {
        const ctx = makeCtx({ 'X-Request-Id': 'err-42' });
        await traceContextHandler(ctx, async () => {
            await loggerHandler(ctx, async () => {
                // errorHandler 排在 loggerHandler 之后，此时 ctx.logger 已就绪。
                await errorHandler(ctx, async () => { throw new Error('boom'); });
            });
        });
        expect(ctx.logger.traceId).toBe('err-42');
        expect(ctx.logger.error).toHaveBeenCalled();
        // 错误被 errorHandler 捕获并写回响应体，不再向上抛。
        expect(ctx.status).toBe(400);
    });
});
