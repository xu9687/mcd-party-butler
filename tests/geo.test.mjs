/**
 * 麦麦派对管家 · 地理工具单元测试（node:test，零依赖）
 * 运行：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineM, sortByDistance, formatDistanceM } from '../lib/geo.mjs';

// 上海人民广场 ≈ (31.2335, 121.4692)，外滩 ≈ (31.2400, 121.4900)
const PG = [31.2335, 121.4692];
const BUND = [31.24, 121.49];

test('haversineM: 人民广场到外滩为 1-3km 量级', () => {
  const d = haversineM(PG[0], PG[1], BUND[0], BUND[1]);
  assert.ok(d >= 1000 && d <= 3000, `期望 1000-3000m，实际 ${d}m`);
});

test('haversineM: 同一点距离为 0', () => {
  assert.equal(haversineM(PG[0], PG[1], PG[0], PG[1]), 0);
});

test('haversineM: 返回整数（四舍五入）', () => {
  const d = haversineM(PG[0], PG[1], BUND[0], BUND[1]);
  assert.equal(Number.isInteger(d), true);
});

test('haversineM: 距离对称性（A→B 与 B→A 相同）', () => {
  const ab = haversineM(PG[0], PG[1], BUND[0], BUND[1]);
  const ba = haversineM(BUND[0], BUND[1], PG[0], PG[1]);
  assert.equal(ab, ba);
});

test('sortByDistance: 按距输入坐标升序排序并附加 calcDistance', () => {
  const stores = [
    { code: 'A', latitude: '31.30', longitude: '121.50' }, // 远
    { code: 'B', latitude: '31.235', longitude: '121.470' }, // 近
    { code: 'C', latitude: '31.26', longitude: '121.48' }, // 中
  ];
  const sorted = sortByDistance(stores, PG[0], PG[1]);
  assert.deepEqual(
    sorted.map((s) => s.code),
    ['B', 'C', 'A']
  );
  for (const s of sorted) {
    assert.equal(typeof s.calcDistance, 'number');
    assert.ok(s.calcDistance >= 0);
  }
});

test('sortByDistance: 不修改原数组', () => {
  const stores = [
    { code: 'A', latitude: '31.30', longitude: '121.50' },
    { code: 'B', latitude: '31.235', longitude: '121.470' },
  ];
  const before = stores.map((s) => s.code).join(',');
  sortByDistance(stores, PG[0], PG[1]);
  assert.equal(stores.map((s) => s.code).join(','), before);
  assert.equal(stores[0].calcDistance, undefined); // 原数组未附加字段
});

test('sortByDistance: 坐标参数无效时原样返回', () => {
  const stores = [{ code: 'A' }];
  const r = sortByDistance(stores, null, undefined);
  assert.deepEqual(r, stores);
});

test('sortByDistance: 非数组输入返回空数组', () => {
  assert.deepEqual(sortByDistance(null, 31, 121), []);
});

test('formatDistanceM: 米与千米的格式化', () => {
  assert.equal(formatDistanceM(350), '350m');
  assert.equal(formatDistanceM(1234), '1.2km');
  assert.equal(formatDistanceM(0), '0m');
  assert.equal(formatDistanceM(null), '-');
  assert.equal(formatDistanceM('abc'), '-');
});
