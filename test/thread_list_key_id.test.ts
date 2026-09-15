import { describe, it, expect } from 'vitest';

import threadControllerFactory from '../src/controller/user/ThreadController';

// —— 驱动真 ThreadController + 真 service/thread，不连库 ——
// 假 router 捕获注册的 handler；假 db 捕获 service.list 拼出来的 where/params；
// 假 ctx 提供 query + user，并记录传给 service.list 的 options。

function makeHarness() {
  const handlers: Record<string, (ctx: any) => Promise<void>> = {};
  const router: any = {
    get: (path: string, handler: (ctx: any) => Promise<void>) => {
      handlers[path] = handler;
    },
  };
  threadControllerFactory(router);

  // 捕获 service.list 传给 db.list 的条件；db.loadById 供 detail 用。
  const captured: any = {};
  const db = {
    list: async (_table: string, conditions: any) => {
      captured.where = conditions.where;
      captured.params = conditions.params;
      return [];
    },
    count: async () => 0,
    loadById: async (_table: string, _id: number) => captured.thread,
  };

  return { handlers, db, captured };
}

describe('/user/thread/list 注入 key_id', () => {
  it('不传 key_id → 传给 service 的 options.key_id 等于 ctx.user.id，where 含 key_id 过滤', async () => {
    const { handlers, db, captured } = makeHarness();
    const ctx: any = {
      query: {},                 // 调用方不带 key_id
      user: { id: 'caller-user-id' },
      db,
    };

    await handlers['/user/thread/list'](ctx);

    expect(ctx.query.key_id).toBe('caller-user-id');       // controller 注入了调用者身份
    expect(captured.where).toContain('key_id = $');        // service 据此加了归属过滤
    expect(captured.where).not.toBe('1=1');                // 不再是全表
    expect(captured.params).toContain('caller-user-id');
  });

  it('伪造 key_id=<别人的 id> → 被 ctx.user.id 覆盖，params 不含伪造值', async () => {
    const { handlers, db, captured } = makeHarness();
    const ctx: any = {
      query: { key_id: 'someone-else-id' },   // 请求里伪造别人的 id
      user: { id: 'caller-user-id' },
      db,
    };

    await handlers['/user/thread/list'](ctx);

    expect(ctx.query.key_id).toBe('caller-user-id');       // 被自己的身份覆盖
    expect(captured.params).toContain('caller-user-id');
    expect(captured.params).not.toContain('someone-else-id');
  });
});

describe('/user/thread/detail 既有行为不变', () => {
  it('访问他人 thread → 抛 "Unauthorized: not your thread."', async () => {
    const { handlers, db, captured } = makeHarness();
    captured.thread = { id: 1, key_id: 'someone-else-id' };   // 该 thread 属于别人
    const ctx: any = {
      query: { id: 1 },
      user: { id: 'caller-user-id' },
      db,
    };

    await expect(handlers['/user/thread/detail'](ctx)).rejects.toThrow('Unauthorized: not your thread.');
  });
});
