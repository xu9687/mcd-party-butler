/**
 * survival / track 的纯逻辑（无网络、无副作用，全部可单测）。
 */

/** 场次唯一键（与 watch 快照结构对齐） */
const KEY = (r) => `${r.spuId}:${r.storeCode}:${r.sessionId}`;

/**
 * 汇总多日历史快照，输出每个场次的存活轨迹。
 * @param {Array<{date: string, results: Array}>} days [{date:'2026-10-11', results:[...]}]
 * @returns {Array} 按存活天数降序：{key, spuName, storeName, date, timeStart, priceText,
 *   firstSeen, lastSeen, aliveDays, firstLeft, lastLeft, trajectory: [{date,leftNum}]}
 */
export function buildSurvivalTable(days) {
  const byKey = new Map();
  for (const day of [...(days ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    for (const r of day.results ?? []) {
      const k = KEY(r);
      if (!byKey.has(k)) {
        byKey.set(k, {
          key: k,
          spuName: r.spuName,
          storeName: r.storeName,
          date: r.date,
          timeStart: r.timeStart,
          priceText: r.priceText,
          firstSeen: day.date,
          lastSeen: day.date,
          firstLeft: Number(r.leftNum),
          lastLeft: Number(r.leftNum),
          trajectory: [],
        });
      }
      const s = byKey.get(k);
      s.lastSeen = day.date;
      s.lastLeft = Number(r.leftNum);
      s.trajectory.push({ date: day.date, leftNum: Number(r.leftNum) });
    }
  }
  return [...byKey.values()]
    .map((s) => ({
      ...s,
      aliveDays:
        (new Date(s.lastSeen) - new Date(s.firstSeen)) / 86400000 + 1 || 1,
    }))
    .sort((a, b) => b.aliveDays - a.aliveDays);
}

/**
 * 拼团进度：名额变化 → 上车人数 / 剩余 / 售罄预警。
 * @param {number} initialLeft 记录追踪时的剩余名额
 * @param {number} currentLeft 当前剩余名额
 * @returns {{joined: number, currentLeft: number, soldOut: boolean}}
 */
export function computeProgress(initialLeft, currentLeft) {
  const init = Number(initialLeft);
  const cur = Number(currentLeft);
  return {
    joined: Math.max(0, (isFinite(init) ? init : 0) - (isFinite(cur) ? cur : 0)),
    currentLeft: isFinite(cur) ? cur : 0,
    soldOut: isFinite(cur) && cur <= 0,
  };
}

/**
 * 生成可复制到家长群的拼团进度卡（纯文本）。
 * @param {object} item 追踪项 {name?, spuName, storeName, date, timeStart, initialLeft, priceText}
 * @param {{joined: number, currentLeft: number, soldOut: boolean}} progress
 * @returns {string}
 */
export function buildShareCard(item, progress) {
  const head = item.name ? `【${item.name}·拼团进度】` : '【麦当劳派对·拼团进度】';
  if (progress.soldOut) {
    return `${head}
${item.spuName} · ${item.storeName}
${item.date} ${item.timeStart}
名额已满 🎉 手慢无，下次趁早！`;
  }
  return `${head}
${item.spuName} · ${item.storeName}
${item.date} ${item.timeStart} · ${item.priceText}/人
已上车 ${progress.joined} 人 · 还剩 ${progress.currentLeft} 个名额
想来的抓紧，确认拼团请私信我 🙋`;
}

/**
 * 拼团黑板 Issue 文案（GitHub Issues 当零后端拼团公告板）。
 * @param {object} item 追踪项 {name?, spuName, storeName, storeCode, date, timeStart, sessionId, priceText}
 * @param {{joined:number, currentLeft:number, soldOut:boolean}} progress
 * @param {number} [target] 目标成团人数（可选）
 * @returns {string} Markdown
 */
export function buildRecruitIssue(item, progress, target = null) {
  const head = item.name ? `【拼团招募】${item.name}` : '【拼团招募】麦当劳派对同行';
  const need = target != null ? Math.max(0, target - progress.joined) : null;
  const lines = [
    `### ${head}`,
    '',
    `- **活动**：${item.spuName || '（待补）'}`,
    `- **门店**：${item.storeName || '（待补）'}（storeCode ${item.storeCode ?? '待补'}）`,
    `- **场次**：${item.date} ${item.timeStart}（场次 id ${item.sessionId ?? '待补'}）`,
    `- **价格**：${item.priceText || '待核实'}/人（已与商品详情交叉核验）`,
    `- **名额**：当前剩 ${progress.currentLeft}${target != null ? ` · 目标 ${target} 人 · 还差 ${need} 人` : ''}`,
  ];
  if (progress.soldOut) lines.push('', '> 已满员，感谢关注 🎉');
  else {
    lines.push(
      '',
      '**如何加入**：在本 Issue 下留言「+1 +人数」，满员后组织者用 `book --confirm` 统一下单（官方支持拼团 / 包场两种模式）。',
      '',
      '> 本帖由 [麦麦派对管家](https://github.com/xu9687/mcd-party-butler) `track` 命令生成 · 数据来自麦当劳官方 MCP · 价格与名额以官方实时结果为准'
    );
  }
  return lines.join('\n');
}

/**
 * 生日档案的窗口判断。
 * @param {string} birthday MM-DD
 * @param {Date} now 当前时间
 * @returns {{daysLeft: number, phase: 'far'|'recommend'|'book'|'today'}}
 *   recommend: T-10 及以内（出推荐）；book: T-3 及以内（必须预订，官方提前 3 天约束）
 */
export function birthdayPhase(birthday, now = new Date()) {
  const [mm, dd] = String(birthday ?? '').split('-').map(Number);
  if (!mm || !dd) throw new Error(`生日格式应为 MM-DD，收到 "${birthday}"`);
  const y = now.getFullYear();
  const thisYear = new Date(y, mm - 1, dd);
  const target = thisYear >= new Date(y, now.getMonth(), now.getDate()) ? thisYear : new Date(y + 1, mm - 1, dd);
  const daysLeft = Math.round((target - new Date(y, now.getMonth(), now.getDate())) / 86400000);
  if (daysLeft > 10) return { daysLeft, phase: 'far' };
  if (daysLeft > 3) return { daysLeft, phase: 'recommend' };
  if (daysLeft >= 1) return { daysLeft, phase: 'book' };
  return { daysLeft, phase: 'today' };
}
