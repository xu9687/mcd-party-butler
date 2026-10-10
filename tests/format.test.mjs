/**
 * 麦麦派对管家 · 终端表格/截断单元测试（node:test，零依赖）
 * 运行：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { table, clip, displayWidth } from '../lib/format.mjs';

test('displayWidth: 全角字符按 2、半角按 1 计宽', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('中a文b'), 6);
  assert.equal(displayWidth(''), 0);
  assert.equal(displayWidth(null), 0);
});

/** 提取数据行（│ 开头），返回按 │ 切分后的单元格数组 */
function dataRows(out) {
  return out
    .split('\n')
    .filter((l) => l.startsWith('│'))
    .map((l) => l.split('│').slice(1, -1));
}

/** 校验每列所有单元格显示宽度一致（列对齐不串列） */
function assertColumnsAligned(out, label) {
  const rows = dataRows(out);
  assert.ok(rows.length >= 2, `${label}：应至少有表头和数据两行`);
  const ncols = rows[0].length;
  for (let i = 0; i < ncols; i++) {
    const ws = new Set(rows.map((r) => displayWidth(r[i] ?? '')));
    assert.equal(ws.size, 1, `${label}：第 ${i} 列宽度不一致：${[...ws].join(',')}`);
  }
}

test('table: 中文列对齐——每列显示宽度一致不串列', () => {
  const out = table(
    ['spuId', '商品名称', '卖点'],
    [
      ['11308', '麦当劳过家家派对尊享版', '沉浸式角色扮演'],
      ['11309', 'abc', 'xyz'],
    ]
  );
  assertColumnsAligned(out, '中文表格');
});

test('table: 中英混排列宽取最大值，短内容右补空格', () => {
  const out = table(['名称'], [['中文很长很长'], ['ab']]);
  assertColumnsAligned(out, '中英混排');
  const abLine = out.split('\n').find((l) => l.startsWith('│') && l.includes('ab'));
  assert.ok(/│ ab +│/.test(abLine), 'ab 应右补空格');
  // 列宽应取最大内容宽度（中文很长很长 = 12；单元格含前后各 1 空格 padding，需 trim）
  const allCells = dataRows(out).flat().map((c) => c.trim());
  const maxW = Math.max(...allCells.map((c) => displayWidth(c)));
  assert.equal(maxW, 12);
});

test('table: 空行数据与 null/undefined 单元格不抛错', () => {
  const out = table(['a', 'b'], [[null, undefined], ['x']]);
  assert.ok(out.includes('│ x'));
});

test('table: 单元格为数字时正常渲染', () => {
  const out = table(['积分'], [[0], [118]]);
  assert.match(out, /│ 0(\s+)│/);
  assert.match(out, /│ 118(\s+)│/);
});

test('clip: 半角超长截断并以 … 结尾', () => {
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abcdef', 6), 'abcdef'); // 恰好不截断
  assert.equal(clip('abcdef', 10), 'abcdef');
});

test('clip: 中文超长截断，追加省略号且省略号计入宽度', () => {
  const r = clip('中文测试', 5); // 内容截到宽 4（中文）+ 省略号（宽度 1）
  assert.equal(r, '中文…');
  assert.ok(r.startsWith('中文') && r.endsWith('…'));
  // 省略号计入宽度：结果总显示宽度不得超过 n
  assert.ok(displayWidth(r) <= 5, `clip 结果显示宽度应 ≤ 5，实际 ${displayWidth(r)}`);
  assert.equal(displayWidth(r), 5);
});

test('clip: 边界输入', () => {
  assert.equal(clip('', 5), '');
  assert.equal(clip(null, 5), '');
  assert.equal(clip('中文', 0), '…'); // n=0 → 最大宽度 0，直接省略号
});
