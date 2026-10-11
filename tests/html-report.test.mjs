import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, projectPoints, buildHtmlReport } from '../lib/html-report.mjs';

test('escapeHtml: 五类字符全部转义', () => {
  assert.equal(escapeHtml('<script>&"\'</script>'), '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
});

test('escapeHtml: XSS payload 不以明文保留标签', () => {
  const out = escapeHtml('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
});

test('projectPoints: 正常坐标投影到画布范围内', () => {
  const pts = [
    { latitude: 31.24, longitude: 121.47 },
    { latitude: 31.22, longitude: 121.50 },
  ];
  const proj = projectPoints(pts, 640, 400, 36);
  for (const p of pts) {
    const { x, y } = proj.project(p);
    assert.ok(x >= 36 && x <= 604, `x=${x} 应在 [36,604]`);
    assert.ok(y >= 36 && y <= 364, `y=${y} 应在 [36,364]`);
  }
});

test('projectPoints: 单点/零跨度不产生除零 NaN', () => {
  const proj = projectPoints([{ latitude: 31.23, longitude: 121.47 }]);
  const { x, y } = proj.project({ latitude: 31.23, longitude: 121.47 });
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
});

test('projectPoints: 空输入与坐标全 0 返回 null', () => {
  assert.equal(projectPoints([]), null);
  assert.equal(projectPoints(null), null);
  assert.equal(projectPoints([{ latitude: 0, longitude: 0 }]), null);
});

const META = { city: '上海', cityCode: '310100', date: '2026-10-17', guests: 6, budgetYuan: 150, generatedAt: '2026-10-11T01:12:04' };
const RESULTS = [
  {
    spuId: 11308, spuName: '过家家派对<script>alert(1)</script>', skuId: 11936,
    storeCode: '1450713', storeName: '黄浦华旭餐厅', address: '南京东路336号',
    latitude: 31.2338, longitude: 121.4758, distanceM: 415, distanceText: '415m',
    date: '2026-10-17', sessionId: 36925878, timeStart: '15:30', timeEnd: '17:00',
    partyMin: 5, partyMax: 12, leftNum: 12, priceFen: 11800, priceText: '¥118',
    priceVerified: true, guests: 6, cityCode: '310100',
  },
];

test('buildHtmlReport: XSS payload 被转义（门店商品名注入无存活）', () => {
  const html = buildHtmlReport(RESULTS, META);
  assert.ok(!html.includes('<script>alert(1)'), '不应存在未转义的注入标签');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('buildHtmlReport: 核心结构齐全', () => {
  const html = buildHtmlReport(RESULTS, META);
  for (const kw of ['<svg', 'class="dot"', 'priceRange', 'dateChips', '¥118', '复制下单命令', 'watch-latest' === 'x' ? 'x' : 'dry-run']) {
    assert.ok(html.includes(kw), `缺少 ${kw}`);
  }
});

test('buildHtmlReport: 空结果不崩溃且给出兜底结构', () => {
  const html = buildHtmlReport([], { ...META, date: null });
  assert.ok(html.includes('<!DOCTYPE html>'));
});

test('buildHtmlReport: </script> 在内嵌 JSON 中被安全化', () => {
  const html = buildHtmlReport(
    [{ ...RESULTS[0], spuName: 'party</script><script>alert(1)</script>' }],
    META
  );
  assert.ok(!html.includes('</script><script>alert'), 'script 逃逸未防住');
});
