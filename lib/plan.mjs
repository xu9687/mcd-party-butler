/**
 * plan 子命令的纯逻辑（无网络、无副作用，全部可单测）。
 * party.mjs 负责取数与输出，本模块负责过滤、排序与命令生成。
 */

/**
 * 过滤场次：只保留有余量、满足人数区间与预算（单位：分）的场次。
 * @param {Array<object>} sessions 场次数组（id/timeStart/timeEnd/partyMin/partyMax/price/leftNum）
 * @param {{guests?: number|null, budgetFen?: number|null}} opt 过滤条件
 * @returns {Array<object>}
 */
export function filterSessions(sessions, opt = {}) {
  const { guests = null, budgetFen = null } = opt;
  return (sessions ?? []).filter((s) => {
    if (!(Number(s.leftNum) > 0)) return false;
    if (guests != null) {
      const min = Number(s.partyMin);
      const max = Number(s.partyMax);
      if (isFinite(min) && isFinite(max) && (guests < min || guests > max)) return false;
      if (Number(s.leftNum) < guests) return false;
    }
    if (budgetFen != null) {
      const p = Number(s.price);
      if (isFinite(p) && p > budgetFen) return false;
    }
    return true;
  });
}

/**
 * 结果排序：价格升序优先，同价按门店距离升序。
 * @param {Array<object>} results 已组装的推荐结果
 * @returns {Array<object>}
 */
export function sortResults(results) {
  return [...(results ?? [])].sort((a, b) => {
    const pa = a.priceFen ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priceFen ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    const da = a.distanceM ?? Number.MAX_SAFE_INTEGER;
    const db = b.distanceM ?? Number.MAX_SAFE_INTEGER;
    return da - db;
  });
}

/**
 * 从可订日期中选择目标日期。
 * @param {Array<{date: string}>} dates 可订日期列表
 * @param {string|null} preferred 用户指定的日期（YYYY-MM-DD）
 * @returns {{date: string|null, warned: boolean}} warned 表示指定日期不在可订列表中
 */
export function pickDate(dates, preferred = null) {
  const list = (dates ?? []).map((d) => String(d.date ?? '')).filter(Boolean);
  if (preferred) {
    return { date: preferred, warned: !list.includes(preferred) };
  }
  return { date: list[0] ?? null, warned: false };
}

/**
 * 生成可直接粘贴执行的 book 预览命令（刻意不带 --confirm，符合安全门设计）。
 * @param {object} r 推荐结果项
 * @returns {string}
 */
export function buildBookHint(r) {
  const parts = [
    'node party.mjs book',
    `--spu ${r.spuId}`,
    `--sku ${r.skuId}`,
    `--store ${r.storeCode}`,
    `--date ${r.date}`,
    `--session ${r.sessionId}`,
    '--party-type 2',
    `--count ${r.guests}`,
    '--city ' + r.cityCode,
  ];
  return parts.join(' ');
}

/**
 * 有上限的并发 map（零依赖版 p-limit + Promise.all 组合）。
 * @param {Array} items 输入数组
 * @param {number} limit 最大并发数（<=0 视为 1）
 * @param {(item, index) => Promise} fn 异步映射函数（fn 内抛错会让整体 reject）
 * @returns {Promise<Array>} 与输入顺序一致的结果数组
 */
export async function mapLimit(items, limit, fn) {
  const list = [...(items ?? [])];
  const n = Number.isInteger(limit) && limit > 0 ? limit : 1;
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(n, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 快照中的场次唯一键 */
const SNAP_KEY = (r) => `${r.spuId}:${r.storeCode}:${r.sessionId}`;

/**
 * 对比两份场次快照，输出稀缺性变化信号（watch 子命令的核心）。
 * @param {Array<object>|null} prev 上一份快照（null 表示首次，全部视为新增）
 * @param {Array<object>} next 当前快照
 * @returns {{newSessions: Array, soldOut: Array, dropped: Array, decreased: Array}}
 *   - newSessions：本次新出现的场次
 *   - soldOut：上次有量、本次剩余 0
 *   - dropped：上次存在、本次消失（可能已下架或日期变更）
 *   - decreased：剩余名额减少的场次（含 delta）
 */
export function diffSnapshots(prev, next) {
  const nextList = [...(next ?? [])];
  const prevList = Array.isArray(prev) ? prev : null;
  const nextMap = new Map(nextList.map((r) => [SNAP_KEY(r), r]));

  const newSessions = [];
  const decreased = [];
  if (prevList) {
    const prevMap = new Map(prevList.map((r) => [SNAP_KEY(r), r]));
    for (const r of nextList) {
      const p = prevMap.get(SNAP_KEY(r));
      if (!p) {
        newSessions.push(r);
      } else if (Number(r.leftNum) < Number(p.leftNum)) {
        decreased.push({ ...r, delta: Number(p.leftNum) - Number(r.leftNum) });
      }
    }
    const soldOut = [];
    const dropped = [];
    for (const p of prevList) {
      if (!nextMap.has(SNAP_KEY(p))) {
        if (Number(p.leftNum) > 0) soldOut.push(p);
        dropped.push(p);
      }
    }
    return { newSessions, soldOut, decreased, dropped };
  }
  // 首次快照：全部视为新增
  return { newSessions: nextList, soldOut: [], decreased: [], dropped: [] };
}
