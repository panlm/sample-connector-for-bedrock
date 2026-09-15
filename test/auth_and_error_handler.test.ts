import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 边界 mock：在 import 被测模块前 hoist 生效，隔离 config / postgres / cache / logger ——
// admin_api_key 固定为 'admin-secret'，便于断言 admin 分支。
vi.mock('../src/config', () => ({
    default: {
        admin_api_key: 'admin-secret',
        debugMode: false,
        performanceMode: false,
        pgsql: {},
    },
}));
vi.mock('../src/util/postgres', () => ({ default: { build: vi.fn() } }));
vi.mock('../src/util/cache', () => ({
    default: { models: [], api_keys: [], connectors: [] },
}));
vi.mock('../src/util/logger', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), silly: vi.fn() },
}));

import { authHandler, errorHandler } from '../src/middleware/handlers';

// 构造一个最小 koa ctx。cache 传 undefined 表示"无缓存"路径。
function makeCtx(opts: {
    path: string;
    authorization?: string;
    xApiKey?: string;
    cache?: any;
}) {
    const header: any = {};
    if (opts.authorization !== undefined) header.authorization = opts.authorization;
    if (opts.xApiKey !== undefined) header['x-api-key'] = opts.xApiKey;
    return {
        path: opts.path,
        header,
        cache: opts.cache,
        user: undefined as any,
        status: undefined as any,
        body: undefined as any,
        res: { finished: true, on: vi.fn(), end: vi.fn() },
        logger: { error: vi.fn(), info: vi.fn() },
    };
}

describe('链路1 · authHandler 认证鉴权（br- key，fail-closed）', () => {
    // AC-1① fail-closed：受保护路径、无 x-api-key、authorization 空 → 抛 "api key required."，不进 next
    it('AC-1①: /v1 无任何凭证 → 抛 api key required.，next 不被调用', async () => {
        const ctx = makeCtx({ path: '/v1/chat/completions', authorization: '' });
        const next = vi.fn();
        await expect(authHandler(ctx, next)).rejects.toThrow('Unauthorized: api key required.');
        expect(next).not.toHaveBeenCalled();
    });

    // AC-1② fail-closed：authorization 长度 ≤10 → 不满足 >10 → api_key 仍为 null → 抛
    it('AC-1②: authorization 长度≤10（"Bearer"）→ 抛 api key required.', async () => {
        const ctx = makeCtx({ path: '/v1/x', authorization: 'Bearer' }); // 长度 6
        const next = vi.fn();
        await expect(authHandler(ctx, next)).rejects.toThrow('Unauthorized: api key required.');
        expect(next).not.toHaveBeenCalled();
    });

    // AC-2：x-api-key 优先于 Authorization。x-api-key 给合法 key，Authorization 给垃圾 → 命中 x-api-key
    it('AC-2: x-api-key 优先于 Authorization', async () => {
        const cache = { api_keys: [{ api_key: 'br-user-key', id: 5, role: 'user', name: 'u' }] };
        const ctx = makeCtx({
            path: '/v1/x',
            xApiKey: 'br-user-key',
            authorization: 'Bearer GARBAGE-would-not-match',
            cache,
        });
        const next = vi.fn();
        await authHandler(ctx, next);
        expect(ctx.user.id).toBe(5);
        expect(next).toHaveBeenCalledOnce();
    });

    // AC-3① 缓存命中 → 注入 user 并 next
    it('AC-3①: 缓存命中 → 注入 ctx.user 并放行', async () => {
        const cache = { api_keys: [{ api_key: 'br-abc', id: 9, role: 'user' }] };
        const ctx = makeCtx({ path: '/v1/x', authorization: 'Bearer br-abc', cache });
        const next = vi.fn();
        await authHandler(ctx, next);
        expect(ctx.user.id).toBe(9);
        expect(next).toHaveBeenCalledOnce();
    });

    // AC-3② 缓存未命中 → 抛 "does not exist"
    it('AC-3②: 有 cache 但 key 不在 → 抛 does not exist', async () => {
        const cache = { api_keys: [{ api_key: 'br-other', id: 1 }] };
        const ctx = makeCtx({ path: '/v1/x', authorization: 'Bearer br-missing', cache });
        const next = vi.fn();
        await expect(authHandler(ctx, next)).rejects.toThrow('does not exist');
        expect(next).not.toHaveBeenCalled();
    });

    // AC-4① 普通 key 访 /admin → 抛 "not an admin role."
    it('AC-4①: 普通 key 访问 /admin → 抛 not an admin role.', async () => {
        const cache = { api_keys: [{ api_key: 'br-abc', id: 9, role: 'user' }] };
        const ctx = makeCtx({ path: '/admin/models', authorization: 'Bearer br-abc', cache });
        const next = vi.fn();
        await expect(authHandler(ctx, next)).rejects.toThrow('not an admin role.');
        expect(next).not.toHaveBeenCalled();
    });

    // AC-4② admin key 访 /admin → 放行
    it('AC-4②: admin key 访问 /admin → 放行', async () => {
        const ctx = makeCtx({ path: '/admin/models', authorization: 'Bearer admin-secret' });
        const next = vi.fn();
        await authHandler(ctx, next);
        expect(ctx.user.role).toBe('admin');
        expect(next).toHaveBeenCalledOnce();
    });

    // AC-5 fail-closed：有 key、无 cache、非 admin → 抛 "api key error."
    it('AC-5: 有 key 但无 cache 且非 admin → 抛 api key error.（fail-closed）', async () => {
        const ctx = makeCtx({ path: '/v1/x', authorization: 'Bearer br-anything', cache: undefined });
        const next = vi.fn();
        await expect(authHandler(ctx, next)).rejects.toThrow('Unauthorized: api key error.');
        expect(next).not.toHaveBeenCalled();
    });

    // AC-6：畸形头 substring(7) 盲截得到的 key 不命中 → 拒绝（不因盲截误放行）
    it('AC-6: 畸形 Authorization 盲截后不命中缓存 → 拒绝', async () => {
        // substring(7) of 'XXXXXXXbr-nope' => 'br-nope'，不在 cache
        const cache = { api_keys: [{ api_key: 'br-real', id: 2 }] };
        const ctx = makeCtx({ path: '/v1/x', authorization: 'XXXXXXXbr-nope', cache });
        const next = vi.fn();
        await expect(authHandler(ctx, next)).rejects.toThrow('does not exist');
        expect(next).not.toHaveBeenCalled();
    });
});

describe('链路4（部分）· errorHandler 错误路径', () => {
    function errCtx() {
        return {
            status: undefined as any,
            body: undefined as any,
            res: { finished: true, on: vi.fn(), end: vi.fn() },
            logger: { error: vi.fn() },
        } as any;
    }

    // AC-15①/②：AWS 429 → ctx.status=429 且结构化 body（含 error_type / http_status / request_id）
    it('AC-15: $metadata.httpStatusCode=429 → ctx.status=429 + 结构化错误体', async () => {
        const ctx = errCtx();
        const awsErr: any = new Error('Rate exceeded');
        awsErr.name = 'ThrottlingException';
        awsErr.$metadata = { httpStatusCode: 429, requestId: 'req-1' };
        const next = () => Promise.reject(awsErr);
        await errorHandler(ctx, next);
        expect(ctx.status).toBe(429);
        expect(ctx.body.success).toBe(false);
        expect(ctx.body.data).toBe('Rate exceeded');
        expect(ctx.body.error.http_status).toBe(429);
        expect(ctx.body.error.request_id).toBe('req-1');
        expect(ctx.body.error.error_type).toBe('ThrottlingException');
    });

    // 重试耗尽后的 enhancedError：$metadata 被保留 → status 仍取自 metadata
    it('AC-16 关联: enhancedError 保留 $metadata → status 取自 metadata', async () => {
        const ctx = errCtx();
        const enhanced: any = new Error('Maximum retry attempts (3) exceeded. Last error: boom');
        enhanced.name = 'BedrockConverseError';
        enhanced.$metadata = { httpStatusCode: 429 };
        await errorHandler(ctx, () => Promise.reject(enhanced));
        expect(ctx.status).toBe(429);
        expect(ctx.body.data).toContain('Maximum retry attempts (3) exceeded');
    });

    // 无 metadata / statusCode → 默认 400
    it('普通 Error（无 metadata）→ ctx.status 默认 400', async () => {
        const ctx = errCtx();
        await errorHandler(ctx, () => Promise.reject(new Error('plain')));
        expect(ctx.status).toBe(400);
        expect(ctx.body.success).toBe(false);
    });

    // ex.statusCode 生效（无 $metadata 时回退到 statusCode）
    it('error.statusCode=503（无 $metadata）→ ctx.status=503', async () => {
        const ctx = errCtx();
        const e: any = new Error('unavailable');
        e.statusCode = 503;
        await errorHandler(ctx, () => Promise.reject(e));
        expect(ctx.status).toBe(503);
    });

    // happy path：next 正常返回 → 不设置错误体
    it('next 正常返回 → 不写错误体', async () => {
        const ctx = errCtx();
        await errorHandler(ctx, () => Promise.resolve());
        expect(ctx.body).toBeUndefined();
    });
});
