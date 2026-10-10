/**
 * 麦麦派对管家 · 零依赖终端表格（等宽填充，中文按显示宽度 2 对齐）
 */

/**
 * 计算字符串的终端显示宽度：CJK 等全角字符按 2，其余按 1；
 * 省略号（U+2026）在终端中按窄字符渲染，计为 1。
 * @param {string} s 输入字符串
 * @returns {number} 显示宽度
 */
export function displayWidth(s) {
  const str = String(s ?? '');
  let w = 0;
  for (const ch of str) {
    if (ch === '…') {
      w += 1;
      continue;
    }
    // 全角区间：CJK 标点/汉字、平假名/片假名/谚文、全角符号等
    w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  }
  return w;
}

/**
 * 按显示宽度左对齐填充空格。
 * @param {string} s 输入字符串
 * @param {number} width 目标宽度
 * @returns {string} 填充后的字符串
 */
function pad(s, width) {
  const str = String(s ?? '');
  const rest = width - displayWidth(str);
  return rest > 0 ? str + ' '.repeat(rest) : str;
}

/**
 * 按显示宽度截断字符串，超长时以 "…" 结尾（省略号计入宽度）。
 * @param {string} s 输入字符串
 * @param {number} n 最大显示宽度
 * @returns {string} 截断后的字符串
 */
export function clip(s, n) {
  const str = String(s ?? '');
  if (displayWidth(str) <= n) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = displayWidth(ch);
    if (w + cw > Math.max(n - 1, 0)) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/**
 * 生成零依赖的终端表格（等宽边框，中文按显示宽度 2 对齐）。
 * @param {string[]} headers 表头
 * @param {Array<Array<*>>} rows 数据行
 * @returns {string} 表格字符串
 */
export function table(headers, rows) {
  const headerCells = headers.map((h) => String(h ?? ''));
  const body = (rows ?? []).map((r) => r.map((c) => String(c ?? '')));
  const widths = headerCells.map((h, i) =>
    Math.max(displayWidth(h), ...body.map((r) => displayWidth(r[i] ?? '')))
  );

  const border = (left, mid, right) =>
    left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
  const line = (cells) =>
    '│' + cells.map((c, i) => ` ${pad(c, widths[i])} `).join('│') + '│';

  const out = [border('┌', '┬', '┐'), line(headerCells), border('├', '┼', '┤')];
  for (const r of body) out.push(line(r));
  out.push(border('└', '┴', '┘'));
  return out.join('\n');
}
