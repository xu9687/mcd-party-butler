/**
 * 麦麦派对管家 · 价格核验单元测试（node:test，零依赖）
 * 运行：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPrice, summarizeSession } from '../lib/price.mjs';

const SKU_118 = { price: '118' }; // 商品详情 SKU：元字符串

test('verifyPrice: 分 11800 × 元 118 倍率成立 → verified:true 且显示 ¥118', () => {
  const r = verifyPrice(11800, SKU_118);
  assert.equal(r.verified, true);
  assert.equal(r.text, '¥118');
});

test('verifyPrice: 分 9900 与元 118 倍率不成立 → verified:false 待核实', () => {
  const r = verifyPrice(9900, SKU_118);
  assert.equal(r.verified, false);
  assert.match(r.text, /单位待核实/);
  assert.match(r.text, /9900/); // 应回显原始数值
});

test('verifyPrice: 商品详情缺失（null）→ verified:false 待核实', () => {
  const r = verifyPrice(11800, null);
  assert.equal(r.verified, false);
  assert.match(r.text, /单位待核实/);
});

test('verifyPrice: SKU 价格缺失 → verified:false 待核实', () => {
  const r = verifyPrice(11800, {});
  assert.equal(r.verified, false);
  assert.match(r.text, /单位待核实/);
});

test('verifyPrice: SKU 价格非数字字符串 → verified:false 待核实', () => {
  const r = verifyPrice(11800, { price: 'abc' });
  assert.equal(r.verified, false);
  assert.match(r.text, /单位待核实/);
});

test('verifyPrice: sessionPriceFen 缺失（undefined）→ verified:false 且文案区分', () => {
  const r = verifyPrice(undefined, SKU_118);
  assert.equal(r.verified, false);
  assert.match(r.text, /原始价格缺失/);
});

test('verifyPrice: sessionPriceFen 为空字符串 → verified:false', () => {
  const r = verifyPrice('', SKU_118);
  assert.equal(r.verified, false);
  assert.match(r.text, /原始价格缺失/);
});

test('verifyPrice: sessionPriceFen 为数字字符串 "11800" → 健壮地核验通过', () => {
  const r = verifyPrice('11800', SKU_118);
  assert.equal(r.verified, true);
  assert.equal(r.text, '¥118');
});

test('verifyPrice: sessionPriceFen 为 NaN 字符串 → verified:false 待核实', () => {
  const r = verifyPrice('not-a-number', SKU_118);
  assert.equal(r.verified, false);
  assert.match(r.text, /单位待核实/);
  assert.match(r.text, /not-a-number/);
});

test('verifyPrice: 误差 <0.01 元视为一致（11799 分 → ¥117.99 vs 118）', () => {
  // 11799/100 = 117.99，与 118 差 0.01，不小于 0.01 → 不通过（边界行为）
  const r = verifyPrice(11799, SKU_118);
  assert.equal(r.verified, false);
  // 11800 与 118 的浮点差为 0，应通过（已在首例覆盖）
});

test('summarizeSession: 正常场次生成单行摘要', () => {
  const s = summarizeSession(
    { id: 36925878, timeStart: '15:30', timeEnd: '17:00', partyMin: 5, partyMax: 12, leftNum: 12 },
    { verified: true, text: '¥118' }
  );
  assert.match(s, /场次 36925878/);
  assert.match(s, /15:30-17:00/);
  assert.match(s, /5-12人/);
  assert.match(s, /剩余 12 名额/);
  assert.match(s, /价格 ¥118/);
});

test('summarizeSession: null 场次返回占位文案', () => {
  assert.equal(summarizeSession(null, null), '（无场次信息）');
});

test('summarizeSession: 字段缺失时不抛错', () => {
  const s = summarizeSession({}, undefined);
  assert.match(s, /人数未知/);
  assert.match(s, /名额未知/);
});
