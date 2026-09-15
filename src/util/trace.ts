import { AsyncLocalStorage } from 'node:async_hooks';

// 单一 AsyncLocalStorage 实例（AD-2）：承载请求级 trace context，
// 经 als.run() 在整条请求处理链（含跨 await 边界的下游）中传播。
// 本文件不 import 任何应用层（middleware/controller/logger），保持依赖方向干净。
export const als = new AsyncLocalStorage<{ traceId: string }>();

// 读当前请求的 traceId；不在 als.run() 作用域内时返回 undefined。
export const getTraceId = (): string | undefined => als.getStore()?.traceId;
