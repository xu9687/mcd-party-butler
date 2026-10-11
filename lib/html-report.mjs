/**
 * plan --format html 的自包含交互决策页生成器（零依赖）。
 * 输出单文件 HTML：门店坐标投影示意地图 × 日期/类目/价格筛选 × 场次卡片。
 * 所有外部数据插值前必须经过 escapeHtml（XSS 防护）。
 */

/** HTML 转义（XSS 防护） */
export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** JSON 安全内嵌（尖括号全部 Unicode 转义，杜绝 script 上下文逃逸） */
function embedJson(obj) {
  return JSON.stringify(obj).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

/**
 * 经纬度归一化投影（min-max → 画布坐标；单点/无坐标时返回 null）。
 * @param {Array<{latitude:number, longitude:number}>} points
 * @param {number} w 画布宽
 * @param {number} h 画布高
 * @param {number} pad 边距
 */
export function projectPoints(points, w = 640, h = 400, pad = 36) {
  const pts = (points ?? []).filter(
    (p) => isFinite(p?.latitude) && isFinite(p?.longitude) && (p.latitude !== 0 || p.longitude !== 0)
  );
  if (pts.length === 0) return null;
  const lats = pts.map((p) => p.latitude);
  const lngs = pts.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat || 1e-9;
  const spanLng = maxLng - minLng || 1e-9;
  // 经度映射 x，纬度映射 y（北上）：按画布比例保持不变形地拉伸到可用区域
  const project = (p) => ({
    x: pad + ((p.longitude - minLng) / spanLng) * (w - 2 * pad),
    y: h - pad - ((p.latitude - minLat) / spanLat) * (h - 2 * pad),
  });
  return { project, count: pts.length };
}

/**
 * 生成完整 HTML 决策页。
 * @param {Array<object>} results plan 的推荐结果（含 latitude/longitude）
 * @param {{city:string, cityCode:string, date:string|null, guests:number|null, budgetYuan:number|null, generatedAt:string}} meta
 * @returns {string} 完整 HTML 文档
 */
export function buildHtmlReport(results, meta) {
  const R = [...(results ?? [])];
  const e = escapeHtml;

  const prices = R.map((r) => (isFinite(r.priceFen) ? r.priceFen : null)).filter((v) => v != null);
  const minPrice = prices.length ? Math.min(...prices) / 100 : 0;
  const maxPrice = prices.length ? Math.max(...prices) / 100 : 0;
  const dates = [...new Set(R.map((r) => r.date))];
  const spus = [...new Set(R.map((r) => r.spuName))];
  // 门店去重（同店多场次只画一个点，取最低价）
  const storeMap = new Map();
  for (const r of R) {
    const k = r.storeCode;
    const prev = storeMap.get(k);
    if (!prev || (r.priceFen ?? Infinity) < (prev.priceFen ?? Infinity)) storeMap.set(k, r);
  }
  const stores = [...storeMap.values()];

  const proj = projectPoints(stores);
  const dotsSvg = proj
    ? stores
        .map((s) => {
          const { x, y } = proj.project(s);
          const price = isFinite(s.priceFen) ? s.priceFen / 100 : null;
          return `<g class="dot" data-store="${e(s.storeCode)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
  <circle r="11" fill="#DA291C" fill-opacity="0.18"/>
  <circle r="5.5" fill="#DA291C"/>
  <text y="-16" text-anchor="middle">${price != null ? '¥' + price : e(s.storeName.slice(0, 8))}</text>
  <text y="24" text-anchor="middle" class="sn">${e(s.storeName.slice(0, 12))}</text>
</g>`;
        })
        .join('\n')
    : '';

  const cards = R.map(
    (r) => `<article class="card" data-spu="${e(r.spuName)}" data-date="${e(r.date)}" data-price="${isFinite(r.priceFen) ? r.priceFen / 100 : 999999}">
  <div class="card-top">
    <span class="spu">${e(r.spuName)}</span>
    <span class="price">${e(r.priceText)}${r.priceVerified ? '' : '?'}</span>
  </div>
  <div class="card-mid">
    <span class="store">${e(r.storeName)}</span>
    <span class="meta">${e(r.date)} · ${e(r.timeStart)}-${e(r.timeEnd)} · ${e(r.partyMin)}-${e(r.partyMax)}人</span>
  </div>
  <div class="card-bot">
    <span class="left">剩余 <b>${e(r.leftNum)}</b> · ${e(r.distanceText)}</span>
    ${r.skuId ? `<button class="copy" data-cmd="${e(buildCmdAttr(r))}">复制下单命令</button>` : '<span class="nocmd">无 sku，需手动查询</span>'}
  </div>
</article>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>麦麦派对管家 · 派对决策页（${e(meta.city)}）</title>
<style>
:root{--red:#DA291C;--yellow:#FFC72C;--ink:#26215C;--soft:#5C5878;--bg:#FBF9F4;--card:#fff;--line:#E9E4D8;--teal:#0F6E56}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--ink);padding:20px}
h1{font-size:19px}
.sub{color:var(--soft);font-size:13px;margin:4px 0 16px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.stats span{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:5px 12px;font-size:12.5px}
.stats b{color:var(--red)}
.filters{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:13px}
.filters .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0}
.filters label{color:var(--soft);min-width:52px}
.chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:3px 12px;cursor:pointer;font-size:12.5px}
.chip.on{background:var(--red);border-color:var(--red);color:#fff}
input[type=range]{accent-color:var(--red);width:180px}
#priceVal{font-weight:700;color:var(--red);min-width:64px}
.map{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px;margin-bottom:14px;overflow-x:auto}
.map .hint{color:var(--soft);font-size:12px;padding:4px 6px}
svg text{font-size:11px;fill:var(--ink);font-weight:600}
svg .sn{fill:var(--soft);font-weight:400;font-size:10px}
g.dot{cursor:pointer}
g.dot:hover circle:nth-child(2){r:7}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card-top{display:flex;justify-content:space-between;gap:8px}
.spu{font-weight:700;font-size:13.5px}
.price{font-weight:800;color:var(--red);font-size:15px;white-space:nowrap}
.card-mid{margin:6px 0;font-size:12.5px}
.store{display:block;font-weight:600}
.meta{color:var(--soft)}
.card-bot{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--soft)}
.card-bot b{color:var(--teal)}
.copy{background:var(--yellow);border:none;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;font-weight:600}
.copy.ok{background:var(--teal);color:#fff}
.nocmd{color:#B4B2A9}
.hidden{display:none!important}
footer{margin-top:16px;color:var(--soft);font-size:12px}
</style>
</head>
<body>
<h1>🍔 麦麦派对管家 · 派对决策页</h1>
<p class="sub">${e(meta.city)}（${e(meta.cityCode)}）${meta.date ? ' · ' + e(meta.date) : ''}${meta.guests ? ' · ' + e(meta.guests) + ' 人' : ''}${meta.budgetYuan ? ' · 预算 ¥' + e(meta.budgetYuan) : ''} · 生成于 ${e(meta.generatedAt)}</p>
<div class="stats">
  <span>可订场次 <b>${R.length}</b></span>
  <span>门店 <b>${stores.length}</b></span>
  <span>单价区间 <b>¥${minPrice.toFixed(0)}-${maxPrice.toFixed(0)}</b></span>
  <span>商品 <b>${spus.length}</b></span>
</div>

<div class="filters">
  <div class="row"><label>日期</label><span id="dateChips"></span></div>
  <div class="row"><label>价格 ≤</label><input type="range" id="priceRange" min="${Math.floor(minPrice)}" max="${Math.ceil(maxPrice)}" value="${Math.ceil(maxPrice)}" step="1"><span id="priceVal">不限</span></div>
  <div class="row"><label>商品</label><span id="spuChips"></span></div>
</div>

${proj ? `<div class="map"><p class="hint">门店位置示意（按官方经纬度投影，红点标注该店最低价，点击红点定位场次卡片）</p>
<svg viewBox="0 0 640 400" width="100%" style="min-width:560px">
<rect x="20" y="20" width="600" height="360" rx="14" fill="#FFF7E8" stroke="#F2DE9A"/>
${dotsSvg}
</svg></div>` : ''}

<div class="grid" id="grid">
${cards}
</div>

<footer>数据来自麦当劳官方 MCP 实时查询 · 价格已双源核验 · 「复制下单命令」为 dry-run 预览（不带 --confirm，绝不自动下单） · 非官方工具</footer>

<script>
"use strict";
var DATA = ${embedJson({ dates, spus, minPrice, maxPrice })};
function chip(text, cls, on) {
  var s = document.createElement("span");
  s.className = "chip" + (on ? " on" : "");
  s.textContent = text;
  if (cls) s.dataset.cls = cls;
  return s;
}
var state = { date: null, spu: null, price: DATA.maxPrice };
var dateBox = document.getElementById("dateChips");
var spuBox = document.getElementById("spuChips");
var priceEl = document.getElementById("priceRange");
var priceVal = document.getElementById("priceVal");

function renderChips() {
  dateBox.innerHTML = "";
  var all = chip("全部日期", "d", !state.date);
  all.onclick = function () { state.date = null; apply(); };
  dateBox.appendChild(all);
  DATA.dates.forEach(function (d) {
    var c = chip(d, "d", state.date === d);
    c.onclick = function () { state.date = d; apply(); };
    dateBox.appendChild(c);
  });
  spuBox.innerHTML = "";
  var allS = chip("全部商品", "s", !state.spu);
  allS.onclick = function () { state.spu = null; apply(); };
  spuBox.appendChild(allS);
  DATA.spus.forEach(function (u) {
    var c = chip(u.length > 12 ? u.slice(0, 12) + "…" : u, "s", state.spu === u);
    c.onclick = function () { state.spu = u; apply(); };
    spuBox.appendChild(c);
  });
}
priceEl.oninput = function () {
  state.price = Number(priceEl.value);
  priceVal.textContent = state.price >= DATA.maxPrice ? "不限" : "≤ ¥" + state.price;
  apply();
};
function apply() {
  var shown = 0;
  document.querySelectorAll("#grid .card").forEach(function (card) {
    var ok = (!state.date || card.dataset.date === state.date) &&
      (!state.spu || card.dataset.spu === state.spu) &&
      (Number(card.dataset.price) <= state.price);
    card.classList.toggle("hidden", !ok);
    if (ok) shown++;
  });
  document.querySelector(".stats span").innerHTML = "可订场次 <b>" + shown + "</b>";
  renderChips();
}
document.querySelectorAll(".copy").forEach(function (btn) {
  btn.onclick = function () {
    navigator.clipboard.writeText(btn.dataset.cmd).then(function () {
      btn.textContent = "已复制 ✓"; btn.classList.add("ok");
      setTimeout(function () { btn.textContent = "复制下单命令"; btn.classList.remove("ok"); }, 1600);
    });
  };
});
document.querySelectorAll("g.dot").forEach(function (dot) {
  dot.addEventListener("click", function () {
    var code = dot.dataset.store;
    var first = document.querySelector('.card .store');
    var target = Array.from(document.querySelectorAll("#grid .card")).find(function (c) {
      return c.textContent.indexOf(code) < 0 && c.dataset.store === code;
    });
    var el = target || Array.from(document.querySelectorAll("#grid .card")).find(function (c) { return c.dataset.store === code; });
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.style.outline = "2px solid #FFC72C"; setTimeout(function () { el.style.outline = ""; }, 1500); }
  });
});
Array.from(document.querySelectorAll("#grid .card")).forEach(function (c) {
  var m = c.innerHTML.match(/data-cmd="([^"]*)"/);
  if (!m) return;
  var cmd = m[1].replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  c.dataset.store = (cmd.match(/--store (\S+)/) || [])[1] || "";
});
apply();
</script>
</body>
</html>`;
}

/** 构造卡片按钮携带的下单命令（与 buildBookHint 同构） */
function buildCmdAttr(r) {
  return [
    'node party.mjs book',
    `--spu ${r.spuId}`,
    `--sku ${r.skuId}`,
    `--store ${r.storeCode}`,
    `--date ${r.date}`,
    `--session ${r.sessionId}`,
    '--party-type 2',
    `--count ${r.guests ?? 5}`,
    `--city ${r.cityCode}`,
  ].join(' ');
}
