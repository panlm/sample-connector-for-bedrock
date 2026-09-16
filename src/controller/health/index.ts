import { probe } from '../../util/health/probe';

// 就绪聚合口径（AD-8 / AD-11）：
// - required = postgres：不通 → 整体 unhealthy / 503
// - optional = s3、bedrock：不通 → 整体 degraded / 200
// 逐依赖状态直接透传 probe 的 up/down（NFR-1：不放内部错误细节进 body）。
const REQUIRED = ['postgres'];

export default {
    // liveness：浅探活，恒 200、零依赖（AD-6）。绝不 import/调用 probe。
    liveness: async (ctx: any) => {
        ctx.status = 200;
        ctx.body = { status: 'ok' };
    },

    // readiness：深探就绪，聚合三依赖（AD-8）。probe 永不 reject。
    readiness: async (ctx: any) => {
        const results = await Promise.all([
            probe('postgres'),
            probe('s3'),
            probe('bedrock'),
        ]);

        const isDown = (name: string) =>
            results.some((r: any) => r.name === name && r.status === 'down');
        const requiredDown = REQUIRED.some((name) => isDown(name));
        const optionalDown = results.some(
            (r: any) => !REQUIRED.includes(r.name) && r.status === 'down',
        );

        let status: string;
        if (requiredDown) {
            status = 'unhealthy';
            ctx.status = 503;
        } else if (optionalDown) {
            status = 'degraded';
            ctx.status = 200;
        } else {
            status = 'healthy';
            ctx.status = 200;
        }

        ctx.body = {
            status,
            dependencies: results.map((r: any) => ({ name: r.name, status: r.status })),
        };
    },
};
