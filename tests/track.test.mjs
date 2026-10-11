import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSurvivalTable, computeProgress, buildShareCard, birthdayPhase } from '../lib/track.mjs';

const R = (sessionId, leftNum, over = {}) => ({
  spuId: 1830, storeCode: '1450713', sessionId, leftNum,
  spuName: '亲子读书会', storeName: '黄浦华旭餐厅', date: '2026-10-17',
  timeStart: '10:30', priceText: '¥45', ...over,
});

test('buildSurvivalTable: 单日快照，全部存活 1 天', () => {
  const t = buildSurvivalTable([{ date: '2026-10-11', results: [R(1, 12), R(2, 5)] }]);
  assert.equal(t.length, 2);
  assert.ok(t.every((s) => s.aliveDays === 1));
});

test('buildSurvivalTable: 跨日累计名额轨迹与存活天数', () => {
  const t = buildSurvivalTable([
    { date: '2026-10-11', results: [R(1, 12)] },
    { date: '2026-10-12', results: [R(1, 8)] },
    { date: '2026-10-13', results: [R(1, 3)] },
  ]);
  assert.equal(t.length, 1);
  assert.equal(t[0].aliveDays, 3);
  assert.equal(t[0].firstLeft, 12);
  assert.equal(t[0].lastLeft, 3);
  assert.deepEqual(t[0].trajectory.map((x) => x.leftNum), [12, 8, 3]);
});

test('buildSurvivalTable: 中途消失的场次存活天数小于总天数', () => {
  const t = buildSurvivalTable([
    { date: '2026-10-11', results: [R(1, 12), R(2, 6)] },
    { date: '2026-10-12', results: [R(1, 9)] },
    { date: '2026-10-13', results: [R(1, 2)] },
  ]);
  assert.equal(t.length, 2);
  const gone = t.find((s) => s.key === `1830:1450713:2`);
  assert.equal(gone.aliveDays, 1);
});

test('buildSurvivalTable: 日期乱序输入自动排序', () => {
  const t = buildSurvivalTable([
    { date: '2026-10-13', results: [R(1, 3)] },
    { date: '2026-10-11', results: [R(1, 12)] },
  ]);
  assert.equal(t[0].firstLeft, 12);
  assert.equal(t[0].lastLeft, 3);
});

test('buildSurvivalTable: 空输入返回空数组', () => {
  assert.deepEqual(buildSurvivalTable([]), []);
  assert.deepEqual(buildSurvivalTable(null), []);
});

test('computeProgress: 正常上车', () => {
  assert.deepEqual(computeProgress(12, 9), { joined: 3, currentLeft: 9, soldOut: false });
});

test('computeProgress: 售罄', () => {
  assert.deepEqual(computeProgress(12, 0), { joined: 12, currentLeft: 0, soldOut: true });
});

test('computeProgress: 名额增加（异常数据）不算上车', () => {
  assert.equal(computeProgress(5, 8).joined, 0);
});

test('computeProgress: 非数字输入兜底为 0', () => {
  assert.deepEqual(computeProgress('x', 'y'), { joined: 0, currentLeft: 0, soldOut: false });
});

test('buildShareCard: 未满员含关键信息', () => {
  const card = buildShareCard(
    { name: '小宝生日局', spuName: '亲子读书会', storeName: '黄浦餐厅', date: '2026-10-17', timeStart: '10:30', priceText: '¥45', initialLeft: 12 },
    { joined: 3, currentLeft: 9, soldOut: false }
  );
  assert.ok(card.includes('小宝生日局'));
  assert.ok(card.includes('已上车 3 人'));
  assert.ok(card.includes('还剩 9 个名额'));
});

test('buildShareCard: 售罄版本', () => {
  const card = buildShareCard(
    { spuName: '读书会', storeName: 'x', date: 'd', timeStart: 't' },
    { joined: 12, currentLeft: 0, soldOut: true }
  );
  assert.ok(card.includes('名额已满'));
  assert.ok(!card.includes('还剩'));
});

test('birthdayPhase: 远期（>10天）为 far', () => {
  const p = birthdayPhase('12-31', new Date('2026-10-11T08:00:00'));
  assert.equal(p.phase, 'far');
  assert.ok(p.daysLeft > 10);
});

test('birthdayPhase: T-10..T-4 为 recommend', () => {
  // 10-11 + 7 天 = 10-18
  assert.equal(birthdayPhase('10-18', new Date('2026-10-11T08:00:00')).phase, 'recommend');
});

test('birthdayPhase: T-3..T-1 为 book（官方提前3天约束）', () => {
  assert.equal(birthdayPhase('10-14', new Date('2026-10-11T08:00:00')).phase, 'book');
  assert.equal(birthdayPhase('10-12', new Date('2026-10-11T08:00:00')).phase, 'book');
});

test('birthdayPhase: 当天为 today', () => {
  assert.equal(birthdayPhase('10-11', new Date('2026-10-11T08:00:00')).phase, 'today');
});

test('birthdayPhase: 今年已过则顺延明年', () => {
  const p = birthdayPhase('01-05', new Date('2026-10-11T08:00:00'));
  assert.equal(p.phase, 'far');
  assert.ok(p.daysLeft > 80);
});

test('birthdayPhase: 非法格式抛错', () => {
  assert.throws(() => birthdayPhase('5月20日'), /MM-DD/);
});
