import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 覆盖 PR #21 的两处改动：gemini_converse.ts 的 streaming/sync catch 分支
//    console.error → logger.error（原始 error 对象作第二参，交给 winston errors({stack})）。
//    边界 mock：隔离 @google/generative-ai（不连外部 API）、logger（可断言）、
//    cache（断开 abstract_provider → cache → postgres/config 的 import 链，杜绝 DB 副作用）。

// vi.hoisted：mock 工厂在 import 前被提升，需用 hoisted 让工厂闭包安全引用这些桩函数。
const { generateContentStream, generateContent, getGenerativeModel } = vi.hoisted(() => {
  const generateContentStream = vi.fn();
  const generateContent = vi.fn();
  const getGenerativeModel = vi.fn(() => ({ generateContentStream, generateContent }));
  return { generateContentStream, generateContent, getGenerativeModel };
});

vi.mock('@google/generative-ai', () => ({
  // 用普通 function 以支持 `new GoogleGenerativeAI(apiKey)`（箭头函数不可作构造器）。
  GoogleGenerativeAI: vi.fn(function () {
    return { getGenerativeModel };
  }),
}));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/util/cache', () => ({ default: {} }));

import GeminiConverse from '../src/providers/gemini_converse';
import logger from '../src/util/logger';

function makeProvider() {
  const p = new GeminiConverse();
  // ensureClient 需要 apiKey；performanceMode/db 交给 ctx 让 saveThread 早退（错误路径本就不会走到它）。
  (p as any).setModelData({ config: { apiKey: 'test-key', model: 'gemini-pro' } });
  return p;
}

function makeCtx() {
  return {
    set: vi.fn(),
    performanceMode: true,
    db: null,
    res: { write: vi.fn(), end: vi.fn() },
  } as any;
}

const userMessages = [{ role: 'user', content: 'hi' }];

describe('GeminiConverse 服务端错误日志（PR #21：console.error → logger.error）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('[P1] streaming catch（gemini_converse.ts:137）：logger.error 收到 msg + 原始 error 对象作第二参', async () => {
    const boom = new Error('stream boom');
    generateContentStream.mockRejectedValueOnce(boom);

    const p = makeProvider();
    const ctx = makeCtx();
    await p.chat({ stream: true, messages: userMessages } as any, 'sess-1', ctx);

    expect(logger.error).toHaveBeenCalledTimes(1);
    // 第二参必须是原始 error 对象本身（引用相等），winston 才能拿到 stack。
    expect(logger.error).toHaveBeenCalledWith('Gemini streaming error:', boom);
    // 原有行为不变：错误仍以 SSE 形式回写客户端。
    expect(ctx.res.write).toHaveBeenCalledWith(expect.stringContaining('stream boom'));
    expect(ctx.res.end).toHaveBeenCalled();
  });

  it('[P1] sync catch（gemini_converse.ts:196）：logger.error 收到 msg + error，并重新抛出', async () => {
    const boom = new Error('sync boom');
    generateContent.mockRejectedValueOnce(boom);

    const p = makeProvider();
    const ctx = makeCtx();
    await expect(
      p.chat({ stream: false, messages: userMessages } as any, 'sess-2', ctx),
    ).rejects.toThrow('sync boom');

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Gemini sync error:', boom);
  });

  it('[P2] 回归：两处错误路径都不再触碰 console.error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    generateContentStream.mockRejectedValueOnce(new Error('x'));
    generateContent.mockRejectedValueOnce(new Error('y'));

    const ps = makeProvider();
    await ps.chat({ stream: true, messages: userMessages } as any, 's', makeCtx());
    const pc = makeProvider();
    await pc.chat({ stream: false, messages: userMessages } as any, 's', makeCtx()).catch(() => {});

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
