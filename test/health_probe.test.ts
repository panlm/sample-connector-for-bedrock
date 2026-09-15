import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// —— 全 mock，绝不真连 Postgres / S3 / Bedrock（硬约束）——
// vi.hoisted 让 mock 载荷在 vi.mock 提升后仍可被测试体引用（控制返回值 + 断言调用计数）。
const { pgQuery, PoolCtor } = vi.hoisted(() => {
  const pgQuery = vi.fn();
  const endFn = vi.fn();
  const PoolCtor = vi.fn(function () { return { query: pgQuery, end: endFn }; });
  return { pgQuery, PoolCtor };
});
vi.mock('pg', () => ({ Pool: PoolCtor }));

const { s3Send, S3Ctor, HeadBucketCommandCtor } = vi.hoisted(() => {
  const s3Send = vi.fn();
  const S3Ctor = vi.fn(function () { return { send: s3Send }; });
  const HeadBucketCommandCtor = vi.fn(function (input: any) { return { input }; });
  return { s3Send, S3Ctor, HeadBucketCommandCtor };
});
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: S3Ctor, HeadBucketCommand: HeadBucketCommandCtor }));

const { bedrockCreds, BedrockCtor } = vi.hoisted(() => {
  const bedrockCreds = vi.fn();
  const BedrockCtor = vi.fn(function () { return { config: { credentials: bedrockCreds } }; });
  return { bedrockCreds, BedrockCtor };
});
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({ BedrockRuntimeClient: BedrockCtor }));

import {
  probe,
  withTimeout,
  __resetProbeCacheForTest,
  __resetProbeClientsForTest,
} from '../src/util/health/probe';

describe('依赖探测模块 probe()', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    __resetProbeClientsForTest();
    process.env.HEALTH_S3_BUCKET = 'test-bucket';
    // 默认全部可达
    pgQuery.mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 });
    s3Send.mockResolvedValue({});
    bedrockCreds.mockResolvedValue({ accessKeyId: 'x', secretAccessKey: 'y' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // AC1 / AC5 —— 正常路径返回 up，只报可达性
  it('postgres 正常 → { name:"postgres", status:"up" }', async () => {
    const res = await probe('postgres');
    expect(res).toEqual({ name: 'postgres', status: 'up' });
    expect(pgQuery).toHaveBeenCalledTimes(1);
    expect(pgQuery).toHaveBeenCalledWith('SELECT 1');
  });

  it('s3 正常 → up，并用 HeadBucketCommand + 配置的 bucket', async () => {
    const res = await probe('s3');
    expect(res).toEqual({ name: 's3', status: 'up' });
    expect(HeadBucketCommandCtor).toHaveBeenCalledWith({ Bucket: 'test-bucket' });
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  it('bedrock 正常 → up（只取凭证，不发真实推理请求）', async () => {
    const res = await probe('bedrock');
    expect(res).toEqual({ name: 'bedrock', status: 'up' });
    expect(bedrockCreds).toHaveBeenCalledTimes(1);
  });

  // AC1 —— 抛错折成 down，且 probe() 永不 reject
  it('底层抛错 → { status:"down", error } 且 probe() 不 reject', async () => {
    pgQuery.mockRejectedValue(new Error('connection refused'));
    // 不用 rejects：probe 必须 resolve
    const res = await probe('postgres');
    expect(res.name).toBe('postgres');
    expect(res.status).toBe('down');
    expect(res.error).toContain('connection refused');
  });

  it('未配置 bucket 时 s3 → down（不抛）', async () => {
    delete process.env.HEALTH_S3_BUCKET;
    delete process.env.S3_BUCKET;
    const res = await probe('s3');
    expect(res.status).toBe('down');
    expect(res.error).toContain('bucket');
    expect(s3Send).not.toHaveBeenCalled();
  });

  // AC2 —— 永久挂起在有限时间（默认 2s）内折成 down，并清理 timer
  it('依赖永久挂起 → 2s 内返回 down（超时路径生效）', async () => {
    vi.useFakeTimers();
    pgQuery.mockReturnValue(new Promise(() => { /* never resolves */ }));

    const p = probe('postgres');
    // 推进到默认超时窗口
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;

    expect(res.status).toBe('down');
    expect(res.error).toContain('timeout');
    // 超时后不应残留悬挂 timer
    expect(vi.getTimerCount()).toBe(0);
  });

  // AC2 —— 成功路径也 clearTimeout，不留悬挂 timer 阻止进程退出
  it('成功路径 clearTimeout：settle 后无悬挂 timer', async () => {
    vi.useFakeTimers();
    pgQuery.mockResolvedValue({ rows: [{ ok: 1 }] });

    const res = await probe('postgres');
    expect(res.status).toBe('up');
    expect(vi.getTimerCount()).toBe(0);
  });

  // AC3 —— TTL 窗口内重复 probe() 命中缓存，底层只真探一次
  it('TTL 内多次 probe("postgres") → 底层 query 只被调用一次（缓存生效）', async () => {
    await probe('postgres');
    await probe('postgres');
    await probe('postgres');
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('缓存清掉后再 probe → 会重新真探', async () => {
    await probe('postgres');
    expect(pgQuery).toHaveBeenCalledTimes(1);
    __resetProbeCacheForTest();
    await probe('postgres');
    expect(pgQuery).toHaveBeenCalledTimes(2);
  });

  // AC4 —— client 是模块级单例：多次真探只构造一次
  it('client 单例复用：跨多次真探只 new Pool 一次', async () => {
    __resetProbeClientsForTest();
    PoolCtor.mockClear();

    await probe('postgres');
    __resetProbeCacheForTest(); // 只清缓存、保留单例，强制第二次真探
    await probe('postgres');

    expect(PoolCtor).toHaveBeenCalledTimes(1);
    expect(pgQuery).toHaveBeenCalledTimes(2);
  });

  it('未知探测目标 → down（不抛）', async () => {
    // @ts-ignore 故意传非法 name 验证契约韧性
    const res = await probe('redis');
    expect(res.status).toBe('down');
  });
});

describe('withTimeout 工具', () => {
  it('p 先完成 → 透传结果并清理 timer', async () => {
    vi.useFakeTimers();
    const r = await withTimeout(Promise.resolve('done'), 1000);
    expect(r).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('超时 → reject，且不留悬挂 timer', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 500);
    const assertion = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
