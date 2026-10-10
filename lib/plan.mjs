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
