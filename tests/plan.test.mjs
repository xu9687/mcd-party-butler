import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSessions, sortResults, pickDate, buildBookHint, mapLimit, diffSnapshots } from '../lib/plan.mjs';

const S = (over = {}) => ({
  id: 1,
  timeStart: '15:30',
  timeEnd: '17:00',
  partyMin: 5,
  partyMax: 12,
  price: 11800,
  leftNum: 12,
  ...over,
});

test('filterSessions: 基础过滤——仅保留有余量场次', () => {
  const out = filterSessions([S({ id: 1 }), S({ id: 2, leftNum: 0 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
});

test('filterSessions: leftNum 缺失/非数字视为无余量', () => {
  assert.equal(filterSessions([S({ leftNum: null }), S({ leftNum: 'x' })]).length, 0);
});

test('filterSessions: guests 在区间内且剩余名额足够', () => {
  const out = filterSessions([S({ partyMin: 5, partyMax: 12, leftNum: 8 })], { guests: 8 });
  assert.equal(out.length, 1);
});

test('filterSessions: guests 低于区间下限被过滤', () => {
  assert.equal(filterSessions([S({ partyMin: 5 })], { guests: 3 }).length, 0);
});

test('filterSessions: guests 超过剩余名额被过滤', () => {
  assert.equal(filterSessions([S({ leftNum: 4 })], { guests: 5 }).length, 0);
});

test('filterSessions: 预算按分比较，等于预算保留、超出过滤', () => {
  const list = [S({ id: 1, price: 11800 }), S({ id: 2, price: 11801 })];
  const out = filterSessions(list, { budgetFen: 11800 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
});

test('filterSessions: price 为字符串时仍按数值比较', () => {
  const out = filterSessions([S({ price: '9900' })], { budgetFen: 10000 });
  assert.equal(out.length, 1);
});

test('filterSessions: 输入为 null/undefined 时返回空数组', () => {
  assert.deepEqual(filterSessions(null), []);
  assert.deepEqual(filterSessions(undefined, { guests: 5 }), []);
});

test('sortResults: 价格升序优先', () => {
  const out = sortResults([
    { priceFen: 13800, distanceM: 100 },
    { priceFen: 9900, distanceM: 900 },
    { priceFen: 11800, distanceM: 500 },
  ]);
  assert.deepEqual(out.map((r) => r.priceFen), [9900, 11800, 13800]);
});

test('sortResults: 同价按距离升序', () => {
  const out = sortResults([
    { priceFen: 11800, distanceM: 800 },
    { priceFen: 11800, distanceM: 200 },
    { priceFen: 11800, distanceM: 500 },
  ]);
  assert.deepEqual(out.map((r) => r.distanceM), [200, 500, 800]);
});

test('sortResults: priceFen 缺失排在最后', () => {
  const out = sortResults([{ distanceM: 1 }, { priceFen: 20000, distanceM: 999 }]);
  assert.equal(out[0].priceFen, 20000);
  assert.equal(out[1].priceFen, undefined);
});

test('pickDate: 无指定时取第一个可订日期', () => {
  const out = pickDate([{ date: '2026-10-11' }, { date: '2026-10-12' }]);
  assert.equal(out.date, '2026-10-11');
  assert.equal(out.warned, false);
});

test('pickDate: 指定日期在列表内不告警', () => {
  const out = pickDate([{ date: '2026-10-11' }, { date: '2026-10-17' }], '2026-10-17');
  assert.equal(out.date, '2026-10-17');
  assert.equal(out.warned, false);
});

test('pickDate: 指定日期不在列表内返回告警', () => {
  const out = pickDate([{ date: '2026-10-11' }], '2026-10-25');
  assert.equal(out.date, '2026-10-25');
  assert.equal(out.warned, true);
});

test('pickDate: 空列表且无指定返回 null', () => {
  assert.equal(pickDate([]).date, null);
  assert.equal(pickDate(null, '2026-10-17').date, '2026-10-17');
});

test('buildBookHint: 命令完整且不含 --confirm', () => {
  const cmd = buildBookHint({
    spuId: 11308,
    skuId: 11936,
    storeCode: '1450713',
    date: '2026-10-17',
    sessionId: 36925878,
    guests: 6,
    cityCode: '310100',
  });
  assert.ok(cmd.startsWith('node party.mjs book'));
  assert.ok(cmd.includes('--spu 11308'));
  assert.ok(cmd.includes('--session 36925878'));
  assert.ok(cmd.includes('--count 6'));
  assert.ok(!cmd.includes('--confirm'));
});

test('mapLimit: 保持输入顺序', async () => {
  const out = await mapLimit([30, 10, 20], 3, async (v) => {
    await new Promise((r) => setTimeout(r, v));
    return v * 2;
  });
  assert.deepEqual(out, [60, 20, 40]);
});

test('mapLimit: 并发数不超上限', async () => {
  let running = 0;
  let peak = 0;
  await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 30));
    running--;
    return null;
  });
  assert.ok(peak <= 2, `peak=${peak} 应 <= 2`);
});

test('mapLimit: 空数组与 null 输入', async () => {
  assert.deepEqual(await mapLimit([], 3, async (x) => x), []);
  assert.deepEqual(await mapLimit(null, 3, async (x) => x), []);
});

test('mapLimit: fn 抛错时整体 reject', async () => {
  await assert.rejects(
    mapLimit([1, 2], 2, async (v) => {
      if (v === 2) throw new Error('boom');
      return v;
    }),
    /boom/
  );
});

const RS = (spuId, storeCode, sessionId, leftNum) => ({ spuId, storeCode, sessionId, leftNum, spuName: 'x', storeName: 'y', date: '2026-10-17', timeStart: '10:00', priceText: '¥88' });

test('diffSnapshots: 首次（prev=null）全部视为新增', () => {
  const next = [RS(1, 'a', 100, 5), RS(1, 'a', 101, 3)];
  const d = diffSnapshots(null, next);
  assert.equal(d.newSessions.length, 2);
  assert.equal(d.soldOut.length, 0);
});

test('diffSnapshots: 检出新场次 / 名额减少 / 售罄下架', () => {
  const prev = [RS(1, 'a', 100, 8), RS(1, 'a', 101, 0), RS(1, 'b', 200, 6)];
  const next = [RS(1, 'a', 100, 5), RS(1, 'a', 101, 0), RS(1, 'a', 102, 4)];
  const d = diffSnapshots(prev, next);
  assert.equal(d.newSessions.length, 1);
  assert.equal(d.newSessions[0].sessionId, 102);
  assert.equal(d.decreased.length, 1);
  assert.equal(d.decreased[0].delta, 3);
  assert.equal(d.soldOut.length, 1); // 门店 b 的 200（上次有量）本次消失
  assert.equal(d.dropped.length, 1);
});

test('diffSnapshots: 无变化时全空', () => {
  const snap = [RS(1, 'a', 100, 5)];
  const d = diffSnapshots(snap, [RS(1, 'a', 100, 5)]);
  assert.equal(d.newSessions.length, 0);
  assert.equal(d.decreased.length, 0);
  assert.equal(d.soldOut.length, 0);
});

test('diffSnapshots: 名额增加不算 decreased', () => {
  const d = diffSnapshots([RS(1, 'a', 100, 3)], [RS(1, 'a', 100, 7)]);
  assert.equal(d.decreased.length, 0);
});
