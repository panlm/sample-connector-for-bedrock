import { describe, it, expect, vi } from 'vitest';

import PGClient from '../src/util/postgres';

// —— 全程靠 spy 拦截 query，绝不连库、绝不触发真实 DELETE ——
describe('deleteMulti where 校验', () => {
  it('缺 where（{}）→ 抛错且不调用 query', async () => {
    const client = new PGClient();
    const querySpy = vi.spyOn(client, 'query');
    await expect(client.deleteMulti('eiai_key', {})).rejects.toThrow(/where/);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('where 空串 → 抛错且不调用 query', async () => {
    const client = new PGClient();
    const querySpy = vi.spyOn(client, 'query');
    await expect(client.deleteMulti('eiai_key', { where: '' })).rejects.toThrow(/where/);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('where 纯空格 → 抛错且不调用 query', async () => {
    const client = new PGClient();
    const querySpy = vi.spyOn(client, 'query');
    await expect(client.deleteMulti('eiai_key', { where: '   ' })).rejects.toThrow(/where/);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('正常 where → 透传拼好的 SQL 与 params', async () => {
    const client = new PGClient();
    const querySpy = vi.spyOn(client, 'query').mockResolvedValue({ rowCount: 1 });
    const result = await client.deleteMulti('eiai_key', { where: 'id=$1', params: [1] });
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledWith('delete from eiai_key where id=$1 ', [1]);
    expect(result).toBe(true);
  });
});
