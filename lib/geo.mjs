/**
 * 麦麦派对管家 · 地理工具（haversine 直线距离，零依赖）
 */

const EARTH_RADIUS_M = 6371000;

/** 角度转弧度 */
function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * 计算两个经纬度坐标之间的 haversine 直线距离。
 * @param {number} lat1 纬度 1
 * @param {number} lng1 经度 1
 * @param {number} lat2 纬度 2
 * @param {number} lng2 经度 2
 * @returns {number} 距离（米，四舍五入取整）
 */
export function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)));
}

/**
 * 按距离排序门店列表（基于 haversine 计算距离）。
 * 无有效坐标输入时原样返回（保留服务端 distance 排序）。
 * 会为每个门店附加 calcDistance（米）字段。
 * @param {Array<{latitude: number|string, longitude: number|string}>} stores 门店列表
 * @param {number|null} lat 用户纬度
 * @param {number|null} lng 用户经度
 * @returns {Array} 排序后的门店列表（原数组不被修改）
 */
export function sortByDistance(stores, lat, lng) {
  if (!Array.isArray(stores)) return [];
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
    return stores;
  }
  return stores
    .map((s) => ({
      ...s,
      calcDistance: haversineM(lat, lng, Number(s.latitude), Number(s.longitude)),
    }))
    .sort((a, b) => a.calcDistance - b.calcDistance);
}

/**
 * 把米数格式化为人类可读距离文本。
 * @param {number} m 距离（米）
 * @returns {string} 如 "1.2km" / "350m"，无效时返回 "-"
 */
export function formatDistanceM(m) {
  if (m == null || !isFinite(Number(m))) return '-';
  const n = Number(m);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}km` : `${Math.round(n)}m`;
}
