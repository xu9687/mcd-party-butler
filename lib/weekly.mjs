/**
 * 「麦门派对周报」叙事引擎：把 watch 多日快照聚合成可传播的数据叙事。
 * 纯逻辑（无网络、无文件 IO），全部可单测。
 *
 * 输入 days 结构与 docs/watch-history/*.json 对齐：
 *   [{ date: '2026-10-11', results: [{cityCode, spuId, spuName, storeCode, storeName,
 *       sessionId, date, timeStart, priceFen, priceText, leftNum}, ...] }]
 */

const KEY = (r) => `${r.spuId}:${r.storeCode}:${r.sessionId}`;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function weekdayOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
}

/** 分 → 元展示文本（整数免小数点，异常返回 null） */
export function fmtYuanText(fen) {
  const n = Number(fen);
  if (!Number.isFinite(n) || n <= 0) return null;
  const yuan = n / 100;
  return Number.isInteger(yuan) ? `¥${yuan}` : `¥${yuan.toFixed(1)}`;
}

function spanDays(firstDate, lastDate) {
  const ms = new Date(`${lastDate}T12:00:00`) - new Date(`${firstDate}T12:00:00`);
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

/**
 * 聚合多日快照 → 周报数据。
 * @param {Array<{date:string, results:Array}>} days
 * @param {{cityNames?: Record<string,string>}} [opts]
 * @returns {object|null} 周报数据（无有效输入时返回 null）
 */
export function buildWeekly(days, opts = {}) {
  const sorted = [...(days ?? [])]
    .filter((d) => d && Array.isArray(d.results) && d.results.length > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (sorted.length === 0) return null;

  const cityNames = opts.cityNames ?? {};
  const from = sorted[0].date;
  const to = sorted[sorted.length - 1].date;

  // 全局轨迹：key → {meta..., points[]}
  const tracks = new Map();
  for (const day of sorted) {
    for (const r of day.results) {
      const k = KEY(r);
      if (!tracks.has(k)) {
        tracks.set(k, {
          key: k,
          spuName: r.spuName ?? '',
          storeName: r.storeName ?? '',
          spuId: r.spuId,
          storeCode: r.storeCode,
          sessionId: r.sessionId,
          date: r.date,
          timeStart: r.timeStart ?? '',
          priceFen: r.priceFen,
          priceText: r.priceText ?? '',
          cityCode: r.cityCode ?? '',
          firstDate: day.date,
          lastDate: day.date,
          firstLeft: Number(r.leftNum),
          lastLeft: Number(r.leftNum),
          points: [],
        });
      }
      const t = tracks.get(k);
      t.lastDate = day.date;
      t.lastLeft = Number(r.leftNum);
      t.points.push({ date: day.date, leftNum: Number(r.leftNum) });
    }
  }
  for (const t of tracks.values()) {
    t.gone = t.lastDate < to || t.lastLeft <= 0;
    t.isNew = t.firstDate > from;
  }

  // ---- 分城聚合 ----
  let observed = 0;
  const cityMap = new Map();
  const touchCity = (code) => {
    if (!cityMap.has(code)) {
      cityMap.set(code, {
        code,
        name: cityNames[code] ?? `城市 ${code}`,
        distinct: new Set(),
        observed: 0,
        goneKeys: new Set(),
        newKeys: new Set(),
        minFen: Infinity,
        minItem: null,
      });
    }
    return cityMap.get(code);
  };
  for (const day of sorted) {
    for (const r of day.results) {
      observed++;
      const c = touchCity(r.cityCode ?? '');
      c.observed++;
      const k = KEY(r);
      c.distinct.add(k);
      const t = tracks.get(k);
      if (t.gone) c.goneKeys.add(k);
      if (t.isNew) c.newKeys.add(k);
      const fen = Number(r.priceFen);
      if (Number.isFinite(fen) && fen > 0 && fen < c.minFen) {
        c.minFen = fen;
        c.minItem = r;
      }
    }
  }

  const cities = [...cityMap.values()].map((c) => {
    // 最抢手时段：退场场次按「场次星期 + 开场时间」聚合
    const slotCount = new Map();
    for (const t of tracks.values()) {
      if (t.cityCode === c.code && t.gone) {
        const slot = `${weekdayOf(t.date)} ${t.timeStart}`.trim();
        slotCount.set(slot, (slotCount.get(slot) ?? 0) + 1);
      }
    }
    let hottest = null;
    let hottestCount = 0;
    for (const [slot, n] of slotCount) {
      if (n > hottestCount) {
        hottest = slot;
        hottestCount = n;
      }
    }
    return {
      code: c.code,
      name: c.name,
      observed: c.observed,
      distinct: c.distinct.size,
      gone: c.goneKeys.size,
      newCount: c.newKeys.size,
      minPriceText: Number.isFinite(c.minFen) ? fmtYuanText(c.minFen) : null,
      minPriceItem: c.minItem ? { spuName: c.minItem.spuName, storeName: c.minItem.storeName } : null,
      hottest,
      hottestCount,
    };
  });

  // ---- 名额消亡榜（曲线数据）：降幅 + 退场加权，取前 6 ----
  const curves = [...tracks.values()]
    .map((t) => ({ ...t, score: (t.firstLeft - t.lastLeft) + (t.gone ? 5 : 0) }))
    .filter((t) => t.points.length >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((t) => ({
      key: t.key,
      title: `${t.spuName} · ${t.storeName}`,
      slot: `${t.date} ${t.timeStart}`.trim(),
      priceText: t.priceText,
      cityCode: t.cityCode,
      gone: t.gone,
      firstLeft: t.firstLeft,
      lastLeft: t.lastLeft,
      spanDays: spanDays(t.firstDate, t.lastDate),
      points: t.points,
    }));

  const totalDistinct = tracks.size;
  const goneTotal = [...tracks.values()].filter((t) => t.gone).length;
  const newTotal = [...tracks.values()].filter((t) => t.isNew).length;

  // ---- 叙事句子 ----
  const cityList = cities.map((c) => c.name).join('/');
  const headline = `一周追踪 ${cities.length} 城（${cityList}）${totalDistinct} 个真实场次：${goneTotal} 个已退场，${newTotal} 个新释出`;
  const bullets = cities.map((c) => {
    const parts = [`${c.name}：观测 ${c.distinct} 场，退场 ${c.gone} 场`];
    if (c.newCount > 0) parts.push(`新释出 ${c.newCount} 场`);
    if (c.minPriceText) parts.push(`最低 ${c.minPriceText}（${c.minPriceItem?.spuName ?? ''}）`);
    if (c.hottest) parts.push(`最抢手时段「${c.hottest}」退场 ${c.hottestCount} 场`);
    return parts.join('，') + '。';
  });
  const fastest = curves.find((c) => c.gone) ?? curves[0] ?? null;
  const killer = fastest
    ? `消亡最快：${fastest.title} ${fastest.slot}（${fastest.priceText}），名额 ${fastest.firstLeft} → ${fastest.lastLeft} 只用了 ${fastest.spanDays} 天${fastest.gone ? '，现已退场' : ''}`
    : null;
  const sampleNote =
    sorted.length < 3
      ? `样本积累中（仅 ${sorted.length} 天快照）：数字尚小，趋势请以两周后的完整曲线为准。`
      : null;

  return {
    period: { from, to, days: sorted.length },
    totals: { observed, distinct: totalDistinct, gone: goneTotal, newCount: newTotal },
    cities: cities.map(({ code, name, observed, distinct, gone, newCount, minPriceText, minPriceItem, hottest, hottestCount }) => ({
      code, name, observed, distinct, gone, newCount, minPriceText, minPriceItem, hottest, hottestCount,
    })),
    curves,
    narrative: { headline, bullets, killer, sampleNote },
  };
}

/**
 * 周报 → 可直接发 GitHub Issue 的 Markdown。
 * @param {object} report buildWeekly 的返回
 * @param {{pagesUrl?: string, repoUrl?: string}} [opts]
 * @returns {string}
 */
export function renderWeeklyMarkdown(report, opts = {}) {
  if (!report) throw new Error('renderWeeklyMarkdown: report 为空');
  const pages = opts.pagesUrl ?? 'https://xu9687.github.io/mcd-party-butler/';
  const repo = opts.repoUrl ?? 'https://github.com/xu9687/mcd-party-butler';
  const L = [];
  L.push(`# 麦门派对周报（${report.period.from} ~ ${report.period.to}）`);
  L.push('');
  L.push(`> 数据来自「麦麦派对管家」每日自动快照，覆盖 ${report.cities.map((c) => c.name).join('/')} 的真实场次库存。非官方数据，以麦当劳官方渠道为准。`);
  L.push('');
  L.push(`**${report.narrative.headline}**`);
  L.push('');
  for (const b of report.narrative.bullets) L.push(`- ${b}`);
  if (report.narrative.killer) L.push(`- ${report.narrative.killer}`);
  L.push('');
  L.push('## 分城战报');
  L.push('');
  L.push('| 城市 | 观测场次 | 退场 | 新释出 | 最低价 | 最抢手时段 |');
  L.push('|---|---|---|---|---|---|');
  for (const c of report.cities) {
    L.push(
      `| ${c.name} | ${c.distinct} | ${c.gone} | ${c.newCount} | ${c.minPriceText ?? '-'} | ${c.hottest ? `${c.hottest}（退场 ${c.hottestCount} 场）` : '-'} |`
    );
  }
  if (report.curves.length > 0) {
    L.push('');
    L.push('## 名额消亡榜');
    L.push('');
    L.push('| 场次 | 时段 | 价格 | 名额变化 | 状态 |');
    L.push('|---|---|---|---|---|');
    for (const c of report.curves) {
      L.push(`| ${c.title} | ${c.slot} | ${c.priceText} | ${c.firstLeft} → ${c.lastLeft} | ${c.gone ? '已退场' : '在售'} |`);
    }
  }
  if (report.narrative.sampleNote) {
    L.push('');
    L.push(`> ${report.narrative.sampleNote}`);
  }
  L.push('');
  L.push('## 追踪与预订');
  L.push('');
  L.push(`- 互动决策页（地图 × 价格滑块）：${pages}`);
  L.push(`- 30 秒上手：${repo}#30-秒上手`);
  L.push('- 数据快照每日更新：`docs/watch-latest.json` · 历史归档：`docs/watch-history/`');
  L.push('');
  L.push('---');
  L.push('*本报告由 `node party.mjs weekly` 自动生成 · 每周一 09:00（北京时间）更新 · 麦门！*');
  return L.join('\n');
}
