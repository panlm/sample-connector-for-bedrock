// 依赖探测模块（Story 2.1）
// 对 Postgres / S3 / Bedrock 每项独立超时探测、结果短时缓存、返回统一的永不 reject 的契约。
// 本模块只报"可达/不可达"（up/down），不做 required/optional 判定、不做 HTTP 状态码 / degraded 映射
// —— 那属于 Story 2.2 的 controller。落实架构 AD-7 / AD-9 / AD-11，实现 FR-8。

import { Pool } from 'pg';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import config from '../../config';

// —— 命名常量 + env 覆盖钩子（AD-7 超时 / AD-9 缓存 TTL）——
const PROBE_TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS) || 2000;
const PROBE_CACHE_TTL_MS = Number(process.env.HEALTH_PROBE_TTL_MS) || 5000;

// 权威字面量：name 只用 postgres / s3 / bedrock（Story 2.2 也用这三个，必须一致）
export type ProbeName = 'postgres' | 's3' | 'bedrock';
export type ProbeResult = { name: string; status: 'up' | 'down'; error?: string };

// —— 模块级缓存（AD-9）：每依赖结果按 TTL 缓存，TTL 窗口内不重复真探 ——
const cache = new Map<string, { result: ProbeResult; at: number }>();

// —— 模块级单例 client（AD-7）：长期复用，绝不每次探测 new 一个不 end，也不复用 ctx.db ——
let pgPool: any = null;
let s3Client: any = null;
let bedrockClient: any = null;

function resolveRegion(): string {
  return (config.bedrock && config.bedrock.region) || process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

function getPgPool(): any {
  if (!pgPool) {
    const pg: any = config.pgsql || {};
    // 参照 src/util/postgres.ts 的 Pool 配置；健康探测用独立单例、小连接池，
    // connectionTimeoutMillis 对齐探测超时，避免建连长期挂起。
    pgPool = new Pool({
      host: pg.host,
      port: pg.port ? ~~pg.port : 5432,
      database: pg.database,
      user: pg.user,
      password: pg.password,
      max: 1,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    });
  }
  return pgPool;
}

function getS3Client(): any {
  if (!s3Client) {
    s3Client = new S3Client({ region: resolveRegion() });
  }
  return s3Client;
}

function getBedrockClient(): any {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({ region: resolveRegion() });
  }
  return bedrockClient;
}

/**
 * Promise.race 一个超时 promise；超时 reject 后由 probe() catch 成 down。
 * 无论成功、失败还是超时，都 clearTimeout —— 不留悬挂 timer 阻止进程退出（AD-7）。
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: any = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

// —— 三个探测实现：只判断可达性，任何异常向上抛，由 probe() 统一折成 down ——

async function doProbePostgres(): Promise<void> {
  const pool = getPgPool();
  await pool.query('SELECT 1');
}

async function doProbeS3(): Promise<void> {
  const bucket = process.env.HEALTH_S3_BUCKET || process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error('no S3 bucket configured (set HEALTH_S3_BUCKET or S3_BUCKET)');
  }
  const client = getS3Client();
  // HeadBucketCommand 是轻量元数据调用，不下载对象、不放大负载。
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

async function doProbeBedrock(): Promise<void> {
  const client = getBedrockClient();
  // 只验证能取得 AWS 凭证 / 建立连接，不发真实推理请求，避免烧 Bedrock 配额（AC Task3）。
  const provider = client.config && client.config.credentials;
  if (typeof provider === 'function') {
    await provider();
  }
}

const PROBERS: Record<ProbeName, () => Promise<void>> = {
  postgres: doProbePostgres,
  s3: doProbeS3,
  bedrock: doProbeBedrock,
};

/**
 * 统一契约（AD-11）：永不 reject、永不抛。任何超时/异常都折成 { status: 'down', error }。
 * 命中未过期缓存直接返回；否则真探一次并写回缓存。
 */
export async function probe(name: ProbeName): Promise<ProbeResult> {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
    return cached.result;
  }

  let result: ProbeResult;
  try {
    const prober = PROBERS[name];
    if (!prober) {
      throw new Error(`unknown probe target: ${name}`);
    }
    await withTimeout(prober(), PROBE_TIMEOUT_MS);
    result = { name, status: 'up' };
  } catch (err: any) {
    result = { name, status: 'down', error: err && err.message ? err.message : String(err) };
  }

  cache.set(name, { result, at: Date.now() });
  return result;
}

// —— 仅测试用的重置钩子：便于用例隔离、断言底层调用计数与单例构造次数 ——
export function __resetProbeCacheForTest(): void {
  cache.clear();
}

export function __resetProbeClientsForTest(): void {
  cache.clear();
  pgPool = null;
  s3Client = null;
  bedrockClient = null;
}
