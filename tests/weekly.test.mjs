import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeekly, renderWeeklyMarkdown, fmtYuanText } from '../lib/weekly.mjs';
import { buildRecruitIssue } from '../lib/track.mjs';

const R = (cityCode, spuId, storeCode, sessionId, leftNum, extra = {}) => ({
  cityCode,
  spuId,
  spuName: extra.spuName ?? '过家家派对',
  storeCode,
  storeName: extra.storeName ?? '黄浦店',
  sessionId,
  date: extra.date ?? '2026-10-17',
  timeStart: extra.timeStart ?? '15:30',
  priceFen: extra.priceFen ?? 11800,
  priceText: extra.priceText ?? '¥118',
  leftNum,
});

const D1 = [
  R('310100', 11308, 'a1', 100, 12, { date: '2026-10-17', timeStart: '18:30' }),
  R('310100', 11308, 'a1', 101, 6, { date: '2026-10-18', timeStart: '10:00', priceFen: 4500, priceText: '¥45', spuName: '读书会' }),
  R('110100', 1830, 'b1', 200, 8, { date: '2026-10-17', timeStart: '15:30', spuName: '迪士尼主题' }),
];
const D2 = [
  R('310100', 11308, 'a1', 100, 9, { date: '2026-10-17', timeStart: '18:30' }),
  R('110100', 1830, 'b1', 200, 3, { date: '2026-10-17', timeStart: '15:30', spuName: '迪士尼主题' }),
  R('110100', 1830, 'b1', 201, 5, { date: '2026-10-18', timeStart: '16:00', spuName: '新释出场' }),
];
const D3 = [
  R('110100', 1830, 'b1', 201, 2, { date: '2026-10-18', timeStart: '16:00', spuName: '新释出场' }),
];

describe('fmtYuanText', () => {
  test('分转元：整数免小数、异常返回 null', () => {
    assert.equal(fmtYuanText(11800), '¥118');
    assert.equal(fmtYuanText(4550), '¥45.5');
    assert.equal(fmtYuanText(0), null);
    assert.equal(fmtYuanText(null), null);
    assert.equal(fmtYuanText('abc'), null);
  });
});

describe('buildWeekly', () => {
  const CN = { '310100': '上海', '110100': '北京' };
  test('三天数据：总量、分城、退场、新释出', () => {
    const r = buildWeekly([
      { date: '2026-10-09', results: D1 },
      { date: '2026-10-10', results: D2 },
      { date: '2026-10-11', results: D3 },
    ], { cityNames: CN });
    assert.equal(r.period.days, 3);
    assert.equal(r.period.from, '2026-10-09');
    assert.equal(r.period.to, '2026-10-11');
    assert.equal(r.totals.observed, 7);
    assert.equal(r.totals.distinct, 4);
    // 退场：100（10-11 消失）、101（10-10 后消失）、200（10-11 消失）；201 在售
    assert.equal(r.totals.gone, 3);
    // 201 首次出现于 10-10 > from
    assert.equal(r.totals.newCount, 1);
    const sh = r.cities.find((c) => c.code === '310100');
    assert.equal(sh.name, '上海');
    assert.equal(sh.distinct, 2);
    assert.equal(sh.gone, 2);
    assert.equal(sh.newCount, 0);
    assert.equal(sh.minPriceText, '¥45');
    assert.equal(sh.minPriceItem.spuName, '读书会');
    // 退场的上海场次：100（周六 18:30）与 101（周六 10:00）并列，取先插入者
    assert.match(sh.hottest, /周六/);
    const bj = r.cities.find((c) => c.code === '110100');
    assert.equal(bj.name, '北京');
    assert.equal(bj.newCount, 1);
    assert.equal(bj.gone, 1); // 200 在 10-11 消失
  });

  test('星期标注正确（2026-10-17 是周六）', () => {
    const r = buildWeekly([
      { date: '2026-10-09', results: [R('310100', 1, 'a', 1, 5, { date: '2026-10-17', timeStart: '09:30' })] },
      { date: '2026-10-10', results: [R('310100', 1, 'a', 2, 5, { date: '2026-10-17', timeStart: '11:00' })] },
      { date: '2026-10-11', results: [R('310100', 1, 'a', 2, 4, { date: '2026-10-17', timeStart: '11:00' })] },
    ], { cityNames: CN });
    assert.match(r.cities[0].hottest, /^周六 09:30$/); // 只有场次 1 退场（场次 2 仍在售）
  });

  test('curves：取降幅最大且至少两个观测点', () => {
    const r = buildWeekly([
      { date: '2026-10-09', results: D1 },
      { date: '2026-10-10', results: D2 },
    ]);
    assert.ok(r.curves.length >= 1);
    const top = r.curves[0];
    assert.equal(top.points.length, 2);
    assert.ok(top.firstLeft >= top.lastLeft || top.gone);
  });

  test('单日数据：无 curves、无 killer、带样本提示', () => {
    const r = buildWeekly([{ date: '2026-10-11', results: D1 }]);
    assert.equal(r.curves.length, 0);
    assert.equal(r.narrative.killer, null);
    assert.match(r.narrative.sampleNote, /样本积累中（仅 1 天/);
  });

  test('叙事：headline/bullets/killer 内容完整', () => {
    const r = buildWeekly([
      { date: '2026-10-09', results: D1 },
      { date: '2026-10-10', results: D2 },
      { date: '2026-10-11', results: D3 },
    ], { cityNames: CN });
    assert.match(r.narrative.headline, /4 个真实场次/);
    assert.ok(r.narrative.bullets.some((b) => b.includes('上海')));
    assert.ok(r.narrative.killer === null || r.narrative.killer.includes('消亡最快'));
  });

  test('无有效输入返回 null', () => {
    assert.equal(buildWeekly([]), null);
    assert.equal(buildWeekly(null), null);
    assert.equal(buildWeekly([{ date: '2026-10-11', results: [] }]), null);
  });
});

describe('renderWeeklyMarkdown', () => {
  test('包含关键叙事与表格', () => {
    const r = buildWeekly([
      { date: '2026-10-09', results: D1 },
      { date: '2026-10-10', results: D2 },
    ], { cityNames: { '310100': '上海', '110100': '北京' } });
    const md = renderWeeklyMarkdown(r);
    assert.ok(md.includes('# 麦门派对周报（2026-10-09 ~ 2026-10-10）'));
    assert.ok(md.includes('## 分城战报'));
    assert.ok(md.includes('| 上海 |'));
    assert.ok(md.includes('¥45'));
    assert.ok(md.includes('node party.mjs weekly'));
  });
  test('report 为空时抛错', () => {
    assert.throws(() => renderWeeklyMarkdown(null), /report 为空/);
  });
});

describe('buildRecruitIssue（拼团黑板）', () => {
  test('包含报名指令与安全提示', () => {
    const md = buildRecruitIssue(
      { name: '小宝生日局', spuName: '过家家派对', storeName: '黄浦店', storeCode: '1450713', date: '2026-10-17', timeStart: '15:30', sessionId: 100, priceText: '¥118' },
      { joined: 3, currentLeft: 9, soldOut: false },
      8
    );
    assert.ok(md.includes('【拼团招募】小宝生日局'));
    assert.ok(md.includes('目标 8 人 · 还差 5 人'));
    assert.ok(md.includes('「+1 +人数」'));
    assert.ok(md.includes('book --confirm'));
    assert.ok(md.includes('以官方实时结果为准'));
  });
  test('满员时不再招募', () => {
    const md = buildRecruitIssue(
      { spuName: 'x', storeName: 'y', storeCode: 'z', date: '2026-10-17', timeStart: '10:00', sessionId: 1, priceText: '¥88' },
      { joined: 12, currentLeft: 0, soldOut: true }
    );
    assert.ok(md.includes('已满员'));
    assert.ok(!md.includes('「+1 +人数」'));
  });
});
