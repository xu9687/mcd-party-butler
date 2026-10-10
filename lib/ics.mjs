/**
 * 麦麦派对管家 · .ics 日历邀请生成（零依赖）
 *
 * 生成符合 RFC 5545 基本结构的 VCALENDAR/VEVENT 文本：
 * - DTSTART/DTEND 使用浮动本地时间格式（如 20261017T153000），无时区折叠
 * - SUMMARY / LOCATION / DESCRIPTION 按规则转义
 * - 行以 CRLF 分隔，超长行按 75 字节规则折叠
 */

/**
 * 转义 ICS 文本字段中的特殊字符。
 * @param {string} s 原始文本
 * @returns {string} 转义后的文本
 */
function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * 将超长行按 RFC 5545 折叠为多行（续行以空格开头，每行最多 75 字节）。
 * @param {string} line 原始行
 * @returns {string} 折叠后的多行文本（不含行分隔符）
 */
function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 73) return line;
  const parts = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const chLen = enc.encode(ch).length;
    if (curLen + chLen > 73) {
      parts.push(cur);
      cur = ' ' + ch;
      curLen = 1 + chLen;
    } else {
      cur += ch;
      curLen += chLen;
    }
  }
  parts.push(cur);
  return parts.join('\r\n');
}

/**
 * 生成派对日历邀请（VEVENT）的 .ics 文件内容。
 * @param {object} opts
 * @param {string} opts.date 派对日期，YYYY-MM-DD
 * @param {string} opts.timeStart 开始时间，HH:mm
 * @param {string} opts.timeEnd 结束时间，HH:mm
 * @param {string} opts.storeName 门店名称
 * @param {string} opts.address 门店地址
 * @param {string} opts.spuName 派对商品名称
 * @param {string} [opts.priceText] 价格文本（可选，用于 DESCRIPTION）
 * @param {string} [opts.peopleRange] 人数范围文本（可选，用于 DESCRIPTION）
 * @returns {string} .ics 文件内容（CRLF 行分隔）
 */
export function buildIcs({ date, timeStart, timeEnd, storeName, address, spuName, priceText, peopleRange }) {
  const compactDate = String(date ?? '').replaceAll('-', '');
  const compactTime = (t) => String(t ?? '00:00').replace(':', '') + '00';
  const dtStart = `${compactDate}T${compactTime(timeStart)}`;
  const dtEnd = `${compactDate}T${compactTime(timeEnd)}`;

  // DTSTAMP 使用当前 UTC 时间
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const dtStamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(
    now.getUTCHours()
  )}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;

  const uid = `mcd-party-${compactDate}-${compactTime(timeStart)}-${Date.now()}@mcd-party-butler`;

  const descParts = [
    `派对：${spuName ?? '麦当劳派对'}`,
    priceText ? `价格：${priceText}` : '',
    peopleRange ? `人数：${peopleRange}` : '',
    '提醒：派对需提前 3 天预订，适用 4-12 岁儿童。',
    '信息来自麦当劳官方 MCP，如有出入以官方为准。',
  ].filter(Boolean);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mcd-party-butler//CN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${icsEscape(`麦当劳派对：${spuName ?? '主题派对'}`)}`,
    `LOCATION:${icsEscape(`${storeName ?? ''}${address ? ' ' + address : ''}`.trim())}`,
    `DESCRIPTION:${icsEscape(descParts.join('\n'))}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.map(foldLine).join('\r\n') + '\r\n';
}
