import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'stream';
import { transports } from 'winston';

import logger from '../src/util/logger';

// —— 用一个 Stream transport 收集 winston 最终格式化后写出的文本 ——
// Stream transport 继承顶层 format，写出的正是 Console 实际打到 stdout 的那一行 JSON。
function captureLines(fn: (log: any) => void): string[] {
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
    fn(logger);
  } finally {
    logger.remove(streamTransport);
  }
  return chunks.join('').split('\n').filter((l) => l.trim().length > 0);
}

describe('winston 单行 JSON 日志格式 (Story 1.2)', () => {
  it('AC-1: 每一非空行都是单行合法 JSON', () => {
    const lines = captureLines((log) => {
      log.child({ traceId: 't-1' }).info('hello world');
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // 单行合法 JSON：不抛异常
      expect(() => JSON.parse(line)).not.toThrow();
      // 不含 pretty-print 的多行缩进痕迹（换行已被 JSON.stringify 转义）
      expect(line).not.toMatch(/\n/);
    }
  });

  it('AC-2: 字段完整 + 语义映射 (level/time/traceId/msg)', () => {
    const lines = captureLines((log) => {
      log.child({ traceId: 't-2' }).info('mapped message');
    });
    const obj = JSON.parse(lines[0]);
    expect(obj).toHaveProperty('level');
    expect(obj).toHaveProperty('time');
    expect(obj).toHaveProperty('traceId');
    expect(obj).toHaveProperty('msg');
    // 映射生效：time 非空、msg 等于打印的消息文本、traceId 透传
    expect(obj.time).toBeTruthy();
    expect(obj.msg).toBe('mapped message');
    expect(obj.traceId).toBe('t-2');
    expect(obj.level).toBe('info');
    // 默认名不再作为唯一键泄漏
    expect(obj.timestamp).toBeUndefined();
    expect(obj.message).toBeUndefined();
  });

  it('AC-3: 顶层 json 生效（去掉破坏单行的 splat），仍带 defaultMeta.service', () => {
    const lines = captureLines((log) => {
      log.info('no splat here %s', 'ignored');
    });
    const obj = JSON.parse(lines[0]);
    expect(obj.service).toBe('brconnector');
    // 输出是 JSON 对象而非 pretty 文本
    expect(typeof obj).toBe('object');
  });

  it('AC-4: 稳态日志级别为 info', () => {
    expect(logger.level).toBe('info');
  });
});
