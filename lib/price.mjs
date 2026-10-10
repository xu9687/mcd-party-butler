/**
 * 麦麦派对管家 · 价格核验（分 ↔ 元 自适应交叉核验，零依赖）
 *
 * 实测事实：
 * - 场次接口 query-party-store-session 的 price 单位是「分」（如 11800）
 * - 商品详情接口 mall-product-detail 的 skuList[].price 单位是「元」的字符串（如 "118"）
 * - 两者换算倍率 ×100 成立时，认为价格已核验
 */

/**
 * 核验场次价格（分）与商品详情 SKU 价格（元）是否一致。
 * @param {number|string|null} sessionPriceFen 场次价格（分），如 11800
 * @param {{price: string|number}|null} detailSku 商品详情 SKU（price 为元字符串，如 "118"）
 * @returns {{verified: boolean, text: string}} verified 为是否核验通过；text 为展示文本
 */
export function verifyPrice(sessionPriceFen, detailSku) {
  if (sessionPriceFen == null || sessionPriceFen === '') {
    return { verified: false, text: '单位待核实（原始价格缺失）' };
  }
  const fen = Number(sessionPriceFen);
  if (!isFinite(fen)) {
    return { verified: false, text: `单位待核实（原始 ${sessionPriceFen}）` };
  }
  // 商品详情缺失或 SKU 价格缺失时同样回退为待核实
  if (!detailSku || detailSku.price == null) {
    return { verified: false, text: `单位待核实（原始 ${fen}）` };
  }
  const skuYuan = Number(detailSku.price);
  if (!isFinite(skuYuan)) {
    return { verified: false, text: `单位待核实（原始 ${fen}）` };
  }
  const yuan = fen / 100;
  if (Math.abs(yuan - skuYuan) < 0.01) {
    return { verified: true, text: `¥${yuan}` };
  }
  return { verified: false, text: `单位待核实（原始 ${fen}）` };
}

/**
 * 生成一个场次的单行人类可读摘要。
 * @param {{id: number|string, timeStart: string, timeEnd: string, partyMin: number, partyMax: number, leftNum: number}} session 场次对象
 * @param {{verified: boolean, text: string}} verified verifyPrice 的返回值
 * @returns {string} 摘要文本，如 "场次 36925878 · 15:30-17:00 · 5-12人 · 剩余 12 名额 · 价格 ¥118"
 */
export function summarizeSession(session, verified) {
  if (!session) return '（无场次信息）';
  const people =
    session.partyMin != null && session.partyMax != null
      ? `${session.partyMin}-${session.partyMax}人`
      : '人数未知';
  const left = session.leftNum != null ? `剩余 ${session.leftNum} 名额` : '名额未知';
  return `场次 ${session.id ?? '?'} · ${session.timeStart ?? '?'}-${session.timeEnd ?? '?'} · ${people} · ${left} · 价格 ${verified?.text ?? '未知'}`;
}
