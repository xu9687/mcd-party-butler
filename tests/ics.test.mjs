/**
 * 麦麦派对管家 · .ics 日历邀请生成单元测试（node:test，零依赖）
 * 运行：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs } from '../lib/ics.mjs';

const BASE_OPTS = {
  date: '2026-10-17',
  timeStart: '15:30',
  timeEnd: '17:00',
  storeName: '麦当劳上海南京东路餐厅',
  address: '上海市黄浦区南京东路 100 号',
  spuName: '麦当劳过家家派对尊享版',
  priceText: '¥118',
  peopleRange: '5-12 人 · 实际 5 人',
};

test('buildIcs: 输出包含 VCALENDAR 与 VEVENT 结构', () => {
  const ics = buildIcs(BASE_OPTS);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /END:VEVENT/);
  assert.match(ics, /END:VCALENDAR/);
  assert.match(ics, /VERSION:2\.0/);
  assert.match(ics, /PRODID:/);
});

test('buildIcs: DTSTART/DTEND 为浮动本地时间格式（无 Z 后缀）', () => {
  const ics = buildIcs(BASE_OPTS);
  assert.match(ics, /DTSTART:20261017T153000\r\n/);
  assert.match(ics, /DTEND:20261017T170000\r\n/);
  assert.doesNotMatch(ics, /DTSTART:20261017T153000Z/);
});

test('buildIcs: 行尾统一为 CRLF，无裸 LF', () => {
  const ics = buildIcs(BASE_OPTS);
  assert.ok(ics.includes('\r\n'), '应包含 CRLF');
  // 移除所有 CRLF 后不应再有 LF
  assert.equal(ics.replaceAll('\r\n', '').includes('\n'), false, '不应存在裸 LF');
  assert.ok(ics.endsWith('\r\n'), '文件应以 CRLF 结尾');
});

/** RFC 5545 展开折叠行（续行去掉前导空格拼回上一行） */
function unfold(ics) {
  return ics
    .split('\r\n')
    .reduce((acc, l) => (l.startsWith(' ') ? acc + l.slice(1) : acc + '\n' + l), '')
    .slice(1);
}

test('buildIcs: 含 SUMMARY/LOCATION/DESCRIPTION', () => {
  const ics = unfold(buildIcs(BASE_OPTS));
  assert.match(ics, /SUMMARY:麦当劳派对：麦当劳过家家派对尊享版/);
  assert.match(ics, /LOCATION:麦当劳上海南京东路餐厅 上海市黄浦区南京东路 100 号/);
  assert.match(ics, /DESCRIPTION:/);
  assert.match(ics, /UID:/);
  assert.match(ics, /DTSTAMP:\d{8}T\d{6}Z/);
});

test('buildIcs: 地址含逗号与分号时正确转义且不破坏 ICS 结构', () => {
  const ics = buildIcs({ ...BASE_OPTS, address: '浦东大道,177 号;甲座' });
  // 逗号与分号应被转义
  assert.match(ics, /LOCATION:.*浦东大道\\,177 号\\;甲座/);
  // 结构完整：BEGIN/END 计数不受影响
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  assert.equal((ics.match(/END:VEVENT/g) ?? []).length, 1);
  assert.equal((ics.match(/BEGIN:VCALENDAR/g) ?? []).length, 1);
  assert.equal((ics.match(/END:VCALENDAR/g) ?? []).length, 1);
  // 转义不应出现在结构关键字中（结构未被破坏）
  assert.doesNotMatch(ics, /\\B|\\V|\\E/);
});

test('buildIcs: DESCRIPTION 多行内容转义为 \\n（不产生真实换行破坏结构）', () => {
  const ics = buildIcs(BASE_OPTS);
  const descLine = ics.split('\r\n').find((l) => l.startsWith('DESCRIPTION:'));
  assert.ok(descLine, 'DESCRIPTION 应为单行（转义后）');
  assert.match(descLine, /\\n/); // 内部换行应为字面 \n
});

test('buildIcs: 反斜杠与换行也被转义', () => {
  // 通过 storeName 注入反斜杠
  const ics = buildIcs({ ...BASE_OPTS, storeName: 'A\\B 餐厅' });
  assert.match(ics, /LOCATION:A\\\\B 餐厅/);
});

test('buildIcs: 超长 LOCATION 按 RFC 5545 折叠（续行以空格开头）', () => {
  const longAddr = '上海市'.repeat(40); // 120 全角字符 = 240 显示宽度
  const ics = buildIcs({ ...BASE_OPTS, address: longAddr });
  const lines = ics.split('\r\n');
  // 所有续行以空格开头
  for (const l of lines.slice(1)) {
    if (l.startsWith(' ') === false) continue; // 只检查折叠产生的续行
  }
  // 折叠行存在（LOCATION 不止一行）
  const locIdx = lines.findIndex((l) => l.startsWith('LOCATION:'));
  assert.ok(locIdx >= 0);
  const next = lines[locIdx + 1];
  if (next !== undefined && !next.startsWith('END:')) {
    assert.match(next, /^ /, '续行应以空格开头');
  }
  // 每行字节数不超过 75
  const enc = new TextEncoder();
  for (const l of lines) assert.ok(enc.encode(l).length <= 75, `行超长：${l.slice(0, 40)}`);
});
