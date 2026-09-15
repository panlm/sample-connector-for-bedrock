// 出站认证方案 1 —— 现场铸造短期 Bedrock bearer token（继承 instance role / 默认凭证链），
// 带进程内缓存 + 过期前刷新。这是**唯一** import `@aws/bedrock-token-generator` 的地方，
// 便于单测 mock，也便于将来替换铸造实现。
//
// ⚠️ 硬约束：铸出的 token 只作为返回值交给调用方（provider 会把它当 OpenAI SDK 的 apiKey），
// 绝不写 process.env、不写日志、不落库、不进错误消息。
//
// 说明（R1 结论）：`@aws/bedrock-token-generator` v1.1.0 的 SigV4 service name 固定为 `bedrock`
// （见 token.js `SERVICE_NAME = "bedrock"`），铸出的是标准 Bedrock API key（`bedrock-api-key-…`），
// 是与身份绑定的凭证、与目标 endpoint 无关，两个 OpenAI 兼容 endpoint（runtime / mantle）通用。
// 生成器不提供、也不需要 `bedrock-mantle` 专用铸造入口。service name 仅用于 endpoint 映射与单测。

import { getToken, getTokenProvider } from "@aws/bedrock-token-generator";

/** token 铸造的凭证来源。 */
export type CredSource =
    | { kind: "default" }
    | {
          kind: "static";
          accessKeyId: string;
          secretAccessKey: string;
          sessionToken?: string;
      };

interface CacheEntry {
    token: string;
    expiresAt: number; // epoch ms
}

// 模块级缓存：provider 是单例、跨模型复用，缓存必须按「区域 + service + 凭证来源」分键，
// 不能假设一个实例只服务一个模型。
const cache = new Map<string, CacheEntry>();

// 请求的 token 存活时长。生成器上限 12h，但实际有效期取 min(请求值, 凭证到期)。
// 取 1h 作保守 TTL：既远低于凭证轮换窗口（避免用到过期 token），又足够摊薄铸造开销。
const TOKEN_TTL_SECONDS = 3600;
const TOKEN_TTL_MS = TOKEN_TTL_SECONDS * 1000;
// 过期前提前刷新的余量。
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function cacheKey(region: string, service: string, src: CredSource): string {
    const credId = src.kind === "static" ? src.accessKeyId : "-";
    return `${region}|${service}|${src.kind}|${credId}`;
}

async function mintToken(region: string, src: CredSource): Promise<string> {
    if (src.kind === "static") {
        return getToken({
            region,
            expiresInSeconds: TOKEN_TTL_SECONDS,
            credentials: {
                accessKeyId: src.accessKeyId,
                secretAccessKey: src.secretAccessKey,
                sessionToken: src.sessionToken,
            },
        });
    }
    // 默认凭证链（instance role / env / shared config）——getTokenProvider 内部用 fromNodeProviderChain 填充。
    const provide = getTokenProvider({ region, expiresInSeconds: TOKEN_TTL_SECONDS });
    return provide();
}

/**
 * 取一个可用的 Bedrock bearer token（命中未近过期的缓存则复用，否则现场铸造）。
 *
 * @param region             铸 token 的区域（来自模型配置，不硬编码）。
 * @param sigV4ServiceName   仅用于缓存分键 / 语义标注；生成器实际固定以 `bedrock` 签名（见文件顶部说明）。
 * @param src                凭证来源：默认凭证链或静态 AKSK。
 * @param nowFn              时间注入点，仅供单测控制时间；生产用默认 Date.now。
 */
export async function getBedrockBearerToken(
    region: string,
    sigV4ServiceName: string,
    src: CredSource,
    nowFn: () => number = Date.now,
): Promise<string> {
    const key = cacheKey(region, sigV4ServiceName, src);
    const now = nowFn();
    const hit = cache.get(key);
    if (hit && now < hit.expiresAt - REFRESH_SKEW_MS) {
        return hit.token;
    }
    const token = await mintToken(region, src);
    cache.set(key, { token, expiresAt: now + TOKEN_TTL_MS });
    return token;
}

/** 仅供单测使用：清空模块级缓存，避免用例间串扰。 */
export function __clearBedrockTokenCacheForTest(): void {
    cache.clear();
}
