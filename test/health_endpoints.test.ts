import { describe, it, expect, vi, beforeEach } from 'vitest';

// 全 mock probe 模块：本 story 测试不真连 PG/S3/Bedrock，也不依赖 Story 2.1 的真实探测。
vi.mock('../src/util/health/probe', () => ({ probe: vi.fn() }));

import health from '../src/controller/health';
import { probe } from '../src/util/health/probe';

const probeMock = probe as unknown as ReturnType<typeof vi.fn>;

// 造一个最小 koa 风格 ctx。
function makeCtx() {
    return { status: undefined as any, body: undefined as any, header: {}, path: '' };
}

// 按依赖名给定 up/down 组合来编排 probe mock。
function setProbe(map: Record<string, 'up' | 'down'>) {
    probeMock.mockImplementation(async (name: string) => ({ name, status: map[name] }));
}

beforeEach(() => {
    probeMock.mockReset();
});

describe('GET /health — liveness (AC-1)', () => {
    it('恒 200 且 body { status: "ok" }', async () => {
        const ctx = makeCtx();
        await health.liveness(ctx);
        expect(ctx.status).toBe(200);
        expect(ctx.body).toEqual({ status: 'ok' });
    });

    it('三依赖全 mock 为不可用时仍 200，且不触发任何 probe 调用（计数 0）', async () => {
        // 即便 probe 被配置成全 down，liveness 也绝不调用它。
        setProbe({ postgres: 'down', s3: 'down', bedrock: 'down' });
        const ctx = makeCtx();
        await health.liveness(ctx);
        expect(ctx.status).toBe(200);
        expect(ctx.body).toEqual({ status: 'ok' });
        expect(probeMock).toHaveBeenCalledTimes(0);
    });
});

describe('GET /health/ready — readiness 聚合 (AC-2, AC-3)', () => {
    it('三依赖全通 → 200 / healthy / 三项 up', async () => {
        setProbe({ postgres: 'up', s3: 'up', bedrock: 'up' });
        const ctx = makeCtx();
        await health.readiness(ctx);
        expect(ctx.status).toBe(200);
        expect(ctx.body.status).toBe('healthy');
        expect(ctx.body.dependencies).toEqual([
            { name: 'postgres', status: 'up' },
            { name: 's3', status: 'up' },
            { name: 'bedrock', status: 'up' },
        ]);
    });

    it('仅 Postgres 不通 → 503 / unhealthy（required 优先）', async () => {
        setProbe({ postgres: 'down', s3: 'up', bedrock: 'up' });
        const ctx = makeCtx();
        await health.readiness(ctx);
        expect(ctx.status).toBe(503);
        expect(ctx.body.status).toBe('unhealthy');
    });

    it('仅 S3 不通 → 200 / degraded / S3 项 down', async () => {
        setProbe({ postgres: 'up', s3: 'down', bedrock: 'up' });
        const ctx = makeCtx();
        await health.readiness(ctx);
        expect(ctx.status).toBe(200);
        expect(ctx.body.status).toBe('degraded');
        const s3 = ctx.body.dependencies.find((d: any) => d.name === 's3');
        expect(s3.status).toBe('down');
    });

    it('仅 Bedrock 不通 → 200 / degraded / Bedrock 项 down', async () => {
        setProbe({ postgres: 'up', s3: 'up', bedrock: 'down' });
        const ctx = makeCtx();
        await health.readiness(ctx);
        expect(ctx.status).toBe(200);
        expect(ctx.body.status).toBe('degraded');
        const bedrock = ctx.body.dependencies.find((d: any) => d.name === 'bedrock');
        expect(bedrock.status).toBe('down');
    });

    it('Postgres 不通 + S3 也不通 → 503（required 优先决定不就绪）', async () => {
        setProbe({ postgres: 'down', s3: 'down', bedrock: 'up' });
        const ctx = makeCtx();
        await health.readiness(ctx);
        expect(ctx.status).toBe(503);
        expect(ctx.body.status).toBe('unhealthy');
    });

    it('body 契约固定：三项都在、name/status 取值合法 (AC-3)', async () => {
        setProbe({ postgres: 'up', s3: 'down', bedrock: 'up' });
        const ctx = makeCtx();
        await health.readiness(ctx);
        const names = ctx.body.dependencies.map((d: any) => d.name);
        expect(names).toEqual(['postgres', 's3', 'bedrock']);
        for (const d of ctx.body.dependencies) {
            expect(['up', 'degraded', 'down']).toContain(d.status);
        }
        expect(['healthy', 'degraded', 'unhealthy']).toContain(ctx.body.status);
    });
});

describe('免鉴权 & 不泄敏 (AC-4, AC-5)', () => {
    it('健康端点不校验 API key —— controller 从不读 ctx.header / 抛 401 (AC-4)', async () => {
        // controller 本身不做鉴权；不带 key 调用不会抛错、也不置 401。
        setProbe({ postgres: 'up', s3: 'up', bedrock: 'up' });
        const liveCtx = makeCtx();
        await health.liveness(liveCtx);
        expect(liveCtx.status).not.toBe(401);
        const readyCtx = makeCtx();
        await health.readiness(readyCtx);
        expect(readyCtx.status).not.toBe(401);
    });

    it('body 不含连接串 / 凭证 / 堆栈细节，只暴露依赖名 + 粗粒度状态 (AC-5)', async () => {
        // 即便 probe 返回带 error 的对象，controller 也不得把 error 放进 body。
        probeMock.mockImplementation(async (name: string) => ({
            name,
            status: name === 's3' ? 'down' : 'up',
            error: 'ECONNREFUSED postgres://user:secret@10.0.0.1:5432/db',
        }));
        const ctx = makeCtx();
        await health.readiness(ctx);
        const serialized = JSON.stringify(ctx.body);
        expect(serialized).not.toContain('secret');
        expect(serialized).not.toContain('ECONNREFUSED');
        expect(serialized).not.toContain('5432');
        for (const d of ctx.body.dependencies) {
            expect(Object.keys(d).sort()).toEqual(['name', 'status']);
        }
    });
});
