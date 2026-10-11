#!/usr/bin/env node
/**
 * 麦麦派对管家 CLI（零第三方依赖，Node >= 18）
 *
 * 全部子命令均为只读查询，唯一例外是 book：
 * - book 不带 --confirm 时只打印订单预览（dry-run），绝不调用 party-order-create
 * - book 带 --confirm 时才真正提交订单，并生成 .ics 日历邀请
 *
 * 铁律：本 CLI 的任何路径都不会调用 create-order / mall-create-order /
 * draw-lottery / auto-bind-coupons / cancel-order 等写操作工具。
 */

import fs from 'node:fs';
import path from 'node:path';
import { callTool, resolveToken, MCP_ENDPOINT } from './lib/mcp-client.mjs';
import { sortByDistance, formatDistanceM } from './lib/geo.mjs';
import { verifyPrice, summarizeSession } from './lib/price.mjs';
import { table, clip } from './lib/format.mjs';
import { buildIcs } from './lib/ics.mjs';
import { filterSessions, sortResults, pickDate, buildBookHint, mapLimit, diffSnapshots } from './lib/plan.mjs';
import { buildHtmlReport } from './lib/html-report.mjs';
import { buildSurvivalTable, computeProgress, buildShareCard, buildRecruitIssue, birthdayPhase } from './lib/track.mjs';
import { buildWeekly, renderWeeklyMarkdown } from './lib/weekly.mjs';

const VERSION = '1.3.0';
const BANNER = `麦麦派对管家 v${VERSION} · 数据来自麦当劳官方 MCP · 仅供参考`;

const HELP_TEXT = `用法：node party.mjs <子命令> [参数]

子命令（除 book 外全部只读）：
  categories
      列出全部派对类目及商品（spuId、名称、卖点、积分）

  cities --spu <id> [--keyword <关键词>]
      查询某派对商品可举办的城市（--keyword 过滤，如 --keyword 上海）

  stores --spu <id> --city <城市code> [--near "纬度,经度"] [--limit <n>]
      查询某城市可举办该派对的门店；--near 时按直线距离排序

  dates --spu <id> --store <门店code>
      查询门店未来可订日期

  sessions --spu <id> --store <门店code> --date <YYYY-MM-DD> [--available]
      查询场次（含与商品详情交叉核验后的价格、剩余名额）；--available 只显示有余量场次

  plan --city <城市code> [--spu <id|all>] [--guests <n>] [--budget <元>]
       [--date <YYYY-MM-DD>] [--near "纬度,经度"] [--limit <n>] [--format text|json|html]
      一句话智能规划：自动串「类目→门店→日期→场次」全链路，按价格与距离
      排序输出可订场次推荐表，并给出可直接粘贴的 book 预览命令。
      - --spu all（默认）：每个在售类目取第 1 个商品；--spu <id> 指定单个商品
      - --guests：按人数过滤（场次人数区间 + 剩余名额）
      - --budget：人均预算上限（元）
      - --format：text（默认）/ json（机器可读）/ html（交互决策页，写出 .html 文件）

  watch --city <城市code[,code2...]> [--spu <id|all>] [--out <文件>]
      场次稀缺性快照：全量扫描并写入快照文件，与上次快照对比输出信号
      （新释出场次 / 售罄 / 名额减少）。配合 GitHub Actions 定时任务可持续追踪。
      - 默认快照文件：docs/watch-latest.json
      - watch 不做人数/预算过滤（记录全量库存）
      - 每次运行自动归档到 docs/watch-history/YYYY-MM-DD.json（存活曲线数据地基）

  survival
      场次存活统计：基于历史快照输出每个场次的初始/当前名额、存活天数、
      消失场次数——「不盯就没了」的实证。

  weekly [--out <文件.md>]
      麦门派对周报：聚合 watch 历史快照，生成分城战报、最抢手时段、
      名额消亡榜与叙事摘要。输出 docs/weekly-latest.json（展示页与
      Actions 周报 Issue 的数据源）；--out 可同时导出 Markdown。
      配套 GitHub Actions 每周一 09:00（北京时间）自动更新并发 Issue。

  birthday add --name <名字> --date <MM-DD> --city <code> --guests <n> [--budget <元>]
  birthday list | remove --name <名字> | check
      生日管家：档案仅存本地 birthdays.local.json（隐私不进仓库）。
      check 自动判断窗口：T-10 出比价推荐，T-3 强提醒（官方要求提前 3 天预订）。

  track --spu <id> --store <code> --date <日期> --session <场次id> [--name <局名>]
  track
      拼团进度卡：记录场次后，随时对比最新快照输出「已上车 X 人 · 还剩 Y 名额」，
      并生成可直接复制到家长群的分享文案（档案存本地 tracked.local.json）。

  book --spu <id> --sku <id> --store <门店code> --date <YYYY-MM-DD>
       --session <场次id> --party-type 1|2 --count <n> [--confirm] [--city <城市code>]
      订单预览 / 提交：
      - 不带 --confirm：仅打印完整订单预览，绝不调用 party-order-create
      - 带 --confirm：真正提交订单，并在当前目录生成 .ics 日历邀请
      - --party-type：1=包场，2=拼团；--city 可选，用于显示门店名称与地址

通用说明：
  - Token 读取顺序：环境变量 MCD_MCP_TOKEN → 文件 ~/.config/mcd/mcp_token
  - 若未配置 Token，请访问 https://open.mcd.cn/mcp 申请
  - 数据来自麦当劳官方 MCP（${MCP_ENDPOINT}），仅供参考，以官方实时结果为准`;

/** 派对类目（实测 2026-10-10）：麦麦体验营与积分兑换活动当前为空，列表时自动略过 */
const PARTY_CATEGORIES = [
  { catRuleIds: '1>6>20', name: '生日类派对' },
  { catRuleIds: '1>6>21', name: '主题类派对' },
  { catRuleIds: '1>6>22', name: '麦麦体验营' },
  { catRuleIds: '1>6>25', name: '品鉴会' },
  { catRuleIds: '1>6>34', name: '读书会' },
  { catRuleIds: '1>6>40', name: '积分兑换活动' },
];

/**
 * 把工具返回的数据规整为数组（防御性兼容 list/data 等包装结构）。
 * @param {*} data 工具返回数据
 * @returns {Array}
 */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['list', 'data', 'records', 'items', 'rows']) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

/**
 * 解析命令行参数：--key value 形式，紧跟的值归入该 flag，无值则为 true。
 * @param {string[]} argv 参数数组
 * @returns {{flags: Object<string, string|boolean>}}
 */
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

/**
 * 校验必填参数。
 * @param {object} flags 已解析参数
 * @param {string[]} names 必填 flag 名
 */
function requireFlags(flags, names) {
  for (const n of names) {
    if (flags[n] === undefined || flags[n] === true) {
      throw new Error(`缺少必填参数 --${n}。执行 node party.mjs --help 查看用法。`);
    }
  }
}

/**
 * 解析 --near "纬度,经度"。
 * @param {string|boolean|undefined} v 参数值
 * @returns {{lat: number, lng: number}|null}
 */
function parseNear(v) {
  if (v === undefined || v === true || v === null || v === '') return null;
  const [lat, lng] = String(v).split(',').map((s) => Number(s.trim()));
  if (!isFinite(lat) || !isFinite(lng)) {
    throw new Error('--near 参数格式应为 "纬度,经度"，例如 --near "31.2304,121.4737"');
  }
  return { lat, lng };
}

/** categories 子命令：列出全部派对类目及商品 */
async function cmdCategories() {
  let total = 0;
  for (const cat of PARTY_CATEGORIES) {
    const products = asArray(await callTool('mall-points-products', { catRuleIds: cat.catRuleIds }));
    if (products.length === 0) {
      console.log(`\n【${cat.name}】（${cat.catRuleIds}）当前无商品，已略过`);
      continue;
    }
    total += products.length;
    console.log(`\n【${cat.name}】（${cat.catRuleIds}，${products.length} 个商品）`);
    console.log(
      table(
        ['spuId', '商品名称', '卖点', '积分'],
        products.map((p) => [p.spuId, clip(p.spuName, 24), clip(p.selling, 30), p.point ?? 0])
      )
    );
  }
  console.log(`\n共 ${total} 个派对商品（当前有货类目 4 个；价格在场次层，商品层积分仅作展示）`);
}

/** cities 子命令：查询可举办城市 */
async function cmdCities(flags) {
  requireFlags(flags, ['spu']);
  const spuId = Number(flags.spu);
  const list = asArray(await callTool('query-party-city', { spuId }));
  const keyword = typeof flags.keyword === 'string' ? flags.keyword : '';
  const filtered = keyword ? list.filter((c) => String(c.name ?? '').includes(keyword)) : list;
  console.log(
    `spuId=${spuId} 可举办城市共 ${list.length} 个${keyword ? `，匹配「${keyword}」${filtered.length} 个` : ''}：`
  );
  console.log(
    table(
      ['城市', 'code', '首字母', '排序'],
      filtered.slice(0, 30).map((c) => [c.name, c.code, c.initial ?? '-', c.sortNo ?? '-'])
    )
  );
  if (filtered.length > 30) console.log(`（仅显示前 30 个，可用 --keyword 收窄）`);
  console.log('提示：code 为市级码（如上海市 310100），请勿使用省级码查询门店。');
}

/** stores 子命令：查询门店列表 */
async function cmdStores(flags) {
  requireFlags(flags, ['spu', 'city']);
  const spuId = Number(flags.spu);
  const cityCode = String(flags.city);
  const limit = Number(flags.limit ?? 10) || 10;
  const near = parseNear(flags.near);

  let stores = asArray(await callTool('query-party-store', { code: cityCode, spuId }));
  if (near) stores = sortByDistance(stores, near.lat, near.lng);

  const shown = stores.slice(0, limit);
  const headers = ['门店code', '门店名称', near ? '直线距离' : '距离', '地址', '状态/线上'];
  const rows = shown.map((s) => [
    s.code,
    clip(s.name, 20),
    near ? formatDistanceM(s.calcDistance) : (s.distanceText ?? '-'),
    clip(s.address, 34),
    `${s.businessStatus ?? '-'}/${s.onlineBusinessStatus ?? '-'}`,
  ]);
  console.log(
    `城市 ${cityCode}、spuId=${spuId} 可举办门店共 ${stores.length} 家` +
      `${near ? '（已按距输入坐标的直线距离排序）' : ''}，显示前 ${shown.length} 家：`
  );
  console.log(table(headers, rows));
}

/** dates 子命令：查询可订日期 */
async function cmdDates(flags) {
  requireFlags(flags, ['spu', 'store']);
  const spuId = Number(flags.spu);
  const storeCode = String(flags.store);
  const list = asArray(await callTool('query-party-store-date', { spuId, storeCode }));
  const dates = list.map((d) => d.date).filter(Boolean);
  console.log(`门店 ${storeCode}（spuId=${spuId}）未来可订日期共 ${dates.length} 天：`);
  console.log(table(['日期'], dates.map((d) => [d])));
  console.log('提示：选定日期后执行 sessions 子命令查看具体场次。');
}

/** sessions 子命令：查询场次（含价格核验） */
async function cmdSessions(flags) {
  requireFlags(flags, ['spu', 'store', 'date']);
  const spuId = Number(flags.spu);
  const storeCode = String(flags.store);
  const dateStr = String(flags.date);

  const sessions = asArray(await callTool('query-party-store-session', { spuId, storeCode, dateStr }));

  // 自动调 mall-product-detail 做价格交叉核验（分 → 元 ×100 倍率）
  let sku = null;
  let spuName = '';
  let detailError = null;
  try {
    const detail = await callTool('mall-product-detail', { spuId });
    spuName = detail?.spuName ?? '';
    sku = (detail?.skuList ?? [])[0] ?? null;
  } catch (e) {
    detailError = e.message;
  }

  const rows = [];
  for (const s of sessions) {
    if (flags.available && !(Number(s.leftNum) > 0)) continue;
    const verified = verifyPrice(s.price, sku);
    rows.push([
      s.id,
      `${s.timeStart ?? '?'}-${s.timeEnd ?? '?'}`,
      `${s.partyMin ?? '?'}-${s.partyMax ?? '?'}人`,
      s.leftNum ?? '-',
      verified.text,
      verified.verified ? '✓ 已核验' : '待核实',
    ]);
  }

  console.log(
    `门店 ${storeCode} · ${dateStr} · ${spuName || `spuId=${spuId}`} 的场次：` +
      `共 ${sessions.length} 场，显示 ${rows.length} 场${flags.available ? '（仅剩余名额>0）' : ''}`
  );
  console.log(table(['场次id', '时段', '人数范围', '剩余名额', '价格', '核验'], rows));
  if (rows.length > 0) {
    const first = sessions.find((s) => !(flags.available && !(Number(s.leftNum) > 0))) ?? sessions[0];
    console.log(`\n示例摘要：${summarizeSession(first, verifyPrice(first.price, sku))}`);
  }
  if (detailError) console.log(`\n（价格核验未完成：${detailError}）`);
}

/** book 子命令：订单预览 / 提交（安全门实现） */
async function cmdBook(flags) {
  requireFlags(flags, ['spu', 'sku', 'store', 'date', 'session', 'count']);
  const spuId = Number(flags.spu);
  const skuId = Number(flags.sku);
  const storeCode = String(flags.store);
  const dateStr = String(flags.date);
  const sessionId = Number(flags.session);
  const count = Number(flags.count);
  const partyType = flags['party-type'] !== undefined ? Number(flags['party-type']) : 2;

  if (partyType !== 1 && partyType !== 2) {
    throw new Error('--party-type 只能是 1（包场）或 2（拼团）');
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('--count 必须是正整数');
  }

  // 只读查询：回拉场次详情用于回显与参数组装（失败则降级预览）
  let session = null;
  try {
    const list = asArray(await callTool('query-party-store-session', { spuId, storeCode, dateStr }));
    session = list.find((s) => Number(s.id) === sessionId) ?? null;
  } catch {
    // 预览降级：继续用用户输入的参数
  }

  // 可选：通过 --city 换取门店名称与地址（只读查询，失败不影响预览）
  let store = null;
  if (typeof flags.city === 'string' && flags.city !== '') {
    try {
      const stores = asArray(await callTool('query-party-store', { code: String(flags.city), spuId }));
      store = stores.find((s) => String(s.code) === storeCode) ?? null;
    } catch {
      // 降级：仅显示门店编码
    }
  }

  // 只读查询：商品详情用于价格核验与名称回显
  let sku = null;
  let spuName = '';
  try {
    const detail = await callTool('mall-product-detail', { spuId });
    spuName = detail?.spuName ?? '';
    sku = (detail?.skuList ?? [])[0] ?? null;
  } catch {
    // 降级：价格按待核实处理
  }

  const verified = verifyPrice(session?.price, sku);
  const unitFen = session?.price ?? null;
  const subtotalFen = unitFen != null ? unitFen * count : null;
  const fmtYuan = (fen) => (fen != null ? `¥${(fen / 100).toFixed(2)}` : '待核实');
  const typeText = partyType === 1 ? '包场' : '拼团';

  if (!flags.confirm) {
    // 安全门：dry-run 只打印预览，绝不调用 party-order-create
    console.log('==================== 订单预览（dry-run，未下单） ====================');
    console.log(`商品：${spuName || `spuId=${spuId}`}（skuId=${skuId}）`);
    console.log(
      `门店：${store ? `${store.name}（${store.address}）` : `编码 ${storeCode}（可用 --city <城市code> 显示门店详情）`}`
    );
    console.log(`日期：${dateStr}`);
    console.log(`时段：${session ? `${session.timeStart} - ${session.timeEnd}` : '（未获取到场次时段）'}`);
    console.log(`形式：${typeText}`);
    console.log(
      `人数：${count} 人（场次范围 ${session ? `${session.partyMin}-${session.partyMax} 人` : '未知'}，适用 4-12 岁）`
    );
    console.log(
      `单价：${fmtYuan(unitFen)}${verified.verified ? '（已与商品详情核验一致）' : `（${verified.text}）`}`
    );
    console.log(`小计：${fmtYuan(subtotalFen)}`);
    console.log(`场次：id=${sessionId}，剩余名额 ${session?.leftNum ?? '未知'}`);
    console.log('--------------------------------------------------------------------');
    console.log('提醒：派对需提前 3 天预订，适用 4-12 岁儿童；价格与名额以官方 MCP 实时结果为准。');
    console.log('本次未调用 party-order-create，未产生任何订单。');
    console.log('如确认无误，请追加 --confirm 后重新执行本命令以提交订单。');
    return;
  }

  // 真实下单路径（仅在显式 --confirm 时执行）
  const orderArgs = {
    partyType,
    spuId,
    skuId,
    storeCode,
    dateStr,
    count,
    id: sessionId,
  };
  if (session?.leftNum != null) orderArgs.leftNum = session.leftNum;
  if (session?.timeStart) orderArgs.timeStart = session.timeStart;
  if (session?.timeEnd) orderArgs.timeEnd = session.timeEnd;
  if (typeof flags.city === 'string' && flags.city !== '') orderArgs.code = String(flags.city);
  // partyTimeInfo 结构以官方文档为准，当前实现未包含该字段

  const result = await callTool('party-order-create', orderArgs);
  console.log('订单已提交，返回结果：');
  console.log(JSON.stringify(result, null, 2));

  const icsPath = `mcd-party-${storeCode}-${dateStr}-${sessionId}.ics`;
  fs.writeFileSync(
    icsPath,
    buildIcs({
      date: dateStr,
      timeStart: session?.timeStart ?? '00:00',
      timeEnd: session?.timeEnd ?? '00:00',
      storeName: store?.name ?? `门店 ${storeCode}`,
      address: store?.address ?? '',
      spuName: spuName || `spuId ${spuId}`,
      priceText: fmtYuan(unitFen),
      peopleRange: session ? `${session.partyMin}-${session.partyMax} 人 · 实际 ${count} 人` : `${count} 人`,
    }),
    'utf8'
  );
  console.log(`已生成日历邀请：${icsPath}`);
}

/**
 * plan/watch 共用的全链路数据采集（只读）。
 * 并发策略：商品层 2 路 × 门店层 4 路（对官方接口保持礼貌的上限）。
 * @param {object} opts { cityCode, guests, budgetFen, dateStr, near, storeLimit, spuIds, log }
 * @returns {Promise<{results: Array}>}
 */
async function collectPlanData(opts) {
  const { cityCode, guests = null, budgetFen = null, dateStr = null, near = null } = opts;
  const storeLimit = opts.storeLimit ?? 3;
  const log = opts.log ?? (() => {});
  const skuCache = new Map();

  const loadDetail = async (spuId) => {
    if (skuCache.has(spuId)) return skuCache.get(spuId);
    let sku = null;
    let name = '';
    try {
      const detail = await callTool('mall-product-detail', { spuId });
      name = detail?.spuName ?? '';
      sku = (detail?.skuList ?? [])[0] ?? null;
    } catch {
      // 降级：价格按待核实处理
    }
    const v = { sku, name };
    skuCache.set(spuId, v);
    return v;
  };

  // 1) 确定候选商品：外部指定或每个类目第 1 个商品
  let spuIds = opts.spuIds;
  if (!Array.isArray(spuIds)) {
    const catProducts = await mapLimit(PARTY_CATEGORIES, 2, async (cat) => {
      const products = asArray(await callTool('mall-points-products', { catRuleIds: cat.catRuleIds }));
      return products.length === 0 ? null : { cat: cat.name, p: products[0] };
    });
    spuIds = catProducts.filter(Boolean).map((x) => Number(x.p.spuId));
    for (const x of catProducts) {
      if (x) log(`候选：${x.cat} → ${x.p.spuName}（spuId ${x.p.spuId}）`);
    }
  }

  // 2) 商品层并发 2 路：每商品查门店；门店层并发 4 路：查日期→场次
  const perSpu = await mapLimit(spuIds, 2, async (spuId) => {
    let stores = [];
    try {
      stores = asArray(await callTool('query-party-store', { code: cityCode, spuId }));
    } catch {
      return [];
    }
    if (stores.length === 0) {
      log(`spuId ${spuId} 在城市 ${cityCode} 暂无可办门店，跳过`);
      return [];
    }
    if (near) stores = sortByDistance(stores, near.lat, near.lng);
    const scanned = stores.slice(0, storeLimit);

    const perStore = await mapLimit(scanned, 4, async (st) => {
      let dates = [];
      try {
        dates = asArray(await callTool('query-party-store-date', { spuId, storeCode: String(st.code) }));
      } catch {
        return [];
      }
      const picked = pickDate(dates, dateStr);
      if (!picked.date) return [];

      let sessions = [];
      try {
        sessions = asArray(
          await callTool('query-party-store-session', { spuId, storeCode: String(st.code), dateStr: picked.date })
        );
      } catch {
        return [];
      }
      const matched = filterSessions(sessions, { guests, budgetFen });
      if (matched.length === 0) return [];

      const { sku, name } = await loadDetail(spuId);
      return matched.map((s) => {
        const verified = verifyPrice(s.price, sku);
        return {
          spuId,
          spuName: name || `spuId ${spuId}`,
          skuId: sku?.skuId ?? null,
          storeCode: String(st.code),
          storeName: st.name ?? '',
          address: st.address ?? '',
          latitude: st.latitude ?? null,
          longitude: st.longitude ?? null,
          distanceM: near ? (st.calcDistance ?? st.distance ?? null) : (st.distance ?? null),
          distanceText: near ? formatDistanceM(st.calcDistance) : (st.distanceText ?? '-'),
          date: picked.date,
          sessionId: s.id,
          timeStart: s.timeStart,
          timeEnd: s.timeEnd,
          partyMin: s.partyMin,
          partyMax: s.partyMax,
          leftNum: Number(s.leftNum),
          priceFen: s.price != null ? Number(s.price) : null,
          priceText: verified.text,
          priceVerified: verified.verified,
          guests,
          cityCode,
        };
      });
    });
    return perStore.flat();
  });

  return { results: perSpu.flat(), skuCache };
}

/** plan 子命令：一句话智能规划（text / json / html 三种输出） */
async function cmdPlan(flags) {
  requireFlags(flags, ['city']);
  const cityCode = String(flags.city);
  const guests = flags.guests !== undefined && flags.guests !== true ? Number(flags.guests) : null;
  const budgetYuan = flags.budget !== undefined && flags.budget !== true ? Number(flags.budget) : null;
  if (guests != null && (!Number.isFinite(guests) || guests <= 0)) {
    throw new Error('--guests 必须是正整数');
  }
  if (budgetYuan != null && (!Number.isFinite(budgetYuan) || budgetYuan <= 0)) {
    throw new Error('--budget 必须是正数（单位：元）');
  }
  const budgetFen = budgetYuan != null ? Math.round(budgetYuan * 100) : null;
  const dateStr = typeof flags.date === 'string' && flags.date !== '' ? flags.date : null;
  const near = parseNear(flags.near);
  const format = String(flags.format ?? (flags.json === true ? 'json' : 'text'));
  if (!['text', 'json', 'html'].includes(format)) {
    throw new Error('--format 只支持 text / json / html');
  }
  const wantJson = format === 'json';
  const log = wantJson ? () => {} : (s) => process.stderr.write(s + '\n');
  log(
    `规划条件：城市 ${cityCode}${guests ? ` · ${guests} 人` : ''}${budgetYuan ? ` · 人均预算 ¥${budgetYuan}` : ''}${dateStr ? ` · ${dateStr}` : ''}`
  );

  const spuIds =
    flags.spu !== undefined && flags.spu !== true && flags.spu !== 'all' ? [Number(flags.spu)] : null;

  const { results } = await collectPlanData({
    cityCode,
    guests,
    budgetFen,
    dateStr,
    near,
    storeLimit: Number(flags.limit ?? 3) || 3,
    spuIds,
    log,
  });
  const ranked = sortResults(results).slice(0, 50);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });

  if (wantJson) {
    console.log(
      JSON.stringify({ generatedAt, city: cityCode, filters: { guests, budgetYuan, date: dateStr }, count: ranked.length, results: ranked }, null, 2)
    );
    return;
  }

  if (format === 'html') {
    const html = buildHtmlReport(ranked, { city: `${CITY_NAME_HINT(cityCode)}`, cityCode, date: dateStr, guests, budgetYuan, generatedAt });
    const file = `mcd-party-plan-${cityCode}-${dateStr ?? 'next'}.html`;
    fs.writeFileSync(file, html, 'utf8');
    console.log(`\n交互决策页已生成：${file}（双击用浏览器打开，可筛选/比价/复制下单命令）`);
    return;
  }

  if (ranked.length === 0) {
    console.log(`\n城市 ${cityCode} 未找到满足条件的可订场次。`);
    console.log('建议：放宽 --budget / 更换 --date / 去掉 --guests 限制后重试。');
    return;
  }

  console.log(`\n城市 ${cityCode} 推荐场次（共 ${ranked.length} 个，按价格升序 · 价格已与商品详情交叉核验）：`);
  console.log(
    table(
      ['商品', '门店', '日期', '时段', '人数', '剩余', '单价', '距离'],
      ranked.slice(0, 10).map((r) => [
        clip(r.spuName, 16),
        clip(r.storeName, 14),
        r.date,
        `${r.timeStart}-${r.timeEnd}`,
        `${r.partyMin}-${r.partyMax}人`,
        r.leftNum,
        r.priceText + (r.priceVerified ? '' : '?'),
        r.distanceText,
      ])
    )
  );
  const best = ranked[0];
  console.log('\n最划算方案（可直接粘贴执行，先预览再决定是否下单）：');
  console.log('  ' + buildBookHint(best));
  console.log('\n提示：以上命令默认为 dry-run 预览；确认无误后再追加 --confirm 提交订单。');
  console.log('想看交互式决策页？加 --format html 试试。');
}

/** watch 子命令：场次稀缺性快照 + 与上次对比的信号输出 */
async function cmdWatch(flags) {
  requireFlags(flags, ['city']);
  const cities = String(flags.city)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const outPath = typeof flags.out === 'string' && flags.out !== '' ? flags.out : 'docs/watch-latest.json';
  const spuIds =
    flags.spu !== undefined && flags.spu !== true && flags.spu !== 'all' ? [Number(flags.spu)] : null;

  console.log(`快照城市：${cities.join('、')}（全量库存，不做人数/预算过滤）`);
  const perCity = await mapLimit(cities, 2, (cityCode) =>
    collectPlanData({ cityCode, guests: null, budgetFen: null, dateStr: null, near: null, storeLimit: 2, spuIds, log: () => {} })
  );
  const all = perCity.map((r) => r.results).flat();

  let prev = null;
  if (fs.existsSync(outPath)) {
    try {
      prev = JSON.parse(fs.readFileSync(outPath, 'utf8')).results ?? null;
    } catch {
      prev = null; // 快照损坏时当作首次
    }
  }
  const diff = diffSnapshots(prev, all);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    cities,
    stats: { sessions: all.length, stores: new Set(all.map((r) => r.storeCode)).size },
    diff: {
      newCount: diff.newSessions.length,
      soldOutCount: diff.soldOut.length,
      decreasedCount: diff.decreased.length,
    },
    results: all,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 1), 'utf8');

  // 历史归档：按日存 docs/watch-history/YYYY-MM-DD.json（当日多次运行覆盖，保留最新）
  // 这是 survival 存活曲线的数据地基——从现在开始积累，定榜前即有完整时序
  const histDir = path.join(path.dirname(outPath), 'watch-history');
  fs.mkdirSync(histDir, { recursive: true });
  const histFile = path.join(histDir, new Date().toISOString().slice(0, 10) + '.json');
  fs.writeFileSync(histFile, JSON.stringify({ generatedAt: snapshot.generatedAt, results: all }, null, 1), 'utf8');

  const first = prev == null;
  console.log(`\n快照已写入 ${outPath}：${all.length} 场 / ${snapshot.stats.stores} 家门店${first ? '（首次基线）' : ''}`);
  if (!first) {
    console.log(`信号：新释出 ${diff.newSessions.length} 场 · 售罄/下架 ${diff.soldOut.length} 场 · 名额减少 ${diff.decreased.length} 场`);
    for (const s of diff.newSessions.slice(0, 5)) {
      console.log(`  [新] ${s.spuName} · ${s.storeName} · ${s.date} ${s.timeStart} · ${s.priceText}`);
    }
    for (const s of diff.decreased.slice(0, 5)) {
      console.log(`  [减] ${s.spuName} · ${s.storeName} · ${s.date} ${s.timeStart} 剩余 ${s.leftNum}（-${s.delta}）`);
    }
    for (const s of diff.soldOut.slice(0, 3)) {
      console.log(`  [光] ${s.spuName} · ${s.storeName} · ${s.date} ${s.timeStart} 已售罄`);
    }
  }
}

/** 本地档案读写（生日/追踪，均不入公开仓库，见 .gitignore） */
function readLocalJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeLocalJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/** 读取 watch 历史归档（含 watch-latest 作为最新观测），按日期升序 */
function readHistoryDays() {
  const histDir = 'docs/watch-history';
  let days = [];
  try {
    days = fs
      .readdirSync(histDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ date: f.slice(0, 10), results: readLocalJson(path.join(histDir, f), {}).results ?? [] }))
      .filter((d) => d.results.length > 0);
  } catch {
    // 目录不存在
  }
  try {
    const latest = readLocalJson('docs/watch-latest.json', {});
    if (latest.results?.length) {
      const d = latest.generatedAt.slice(0, 10);
      if (!days.some((x) => x.date === d)) days.push({ date: d, results: latest.results });
    }
  } catch {
    // 忽略
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** survival 子命令：基于历史快照的场次存活统计（数据地基：watch 每日自动归档） */
async function cmdSurvival() {
  const days = readHistoryDays();
  if (days.length === 0) {
    console.log('尚无历史快照。先运行 node party.mjs watch --city <code>，定时任务会每日自动归档。');
    return;
  }
  const survTable = buildSurvivalTable(days);
  const alive = survTable.filter((s) => s.aliveDays === days.length);
  const gone = survTable.filter((s) => s.aliveDays < days.length);
  console.log(`已积累 ${days.length} 天快照（${days[0].date} ~ ${days[days.length - 1].date}）：共观测 ${survTable.length} 个场次`);
  if (days.length < 3) console.log('（数据积累中：满 3 天后本表开始有统计意义，两周后可拟合存活曲线）');

  const rows = survTable.slice(0, 10).map((s) => [
    clip(s.spuName, 14),
    clip(s.storeName, 12),
    `${s.date} ${s.timeStart}`,
    s.firstLeft,
    s.lastLeft,
    `${s.aliveDays}天`,
    s.aliveDays === days.length ? '在售' : '已消失',
  ]);
  console.log(
    table(['商品', '门店', '场次', '初始名额', '当前名额', '存活', '状态'], rows)
  );
  if (gone.length > 0) {
    console.log(`\n消失场次 ${gone.length} 个（已售罄/下架/日期滚动）——这些就是「不盯就没了」的证据。`);
  }
}

/** weekly 子命令：麦门派对周报（数据叙事，展示页与 Actions 周报 Issue 的数据源） */
async function cmdWeekly(flags) {
  const days = readHistoryDays();
  if (days.length === 0) {
    console.log('尚无历史快照。先运行 node party.mjs watch --city <code> 积累数据，周报才有原料。');
    return;
  }
  const cityNames = {};
  for (const d of days) for (const r of d.results) if (r.cityCode) cityNames[r.cityCode] ??= CITY_NAME_HINT(r.cityCode);
  const report = buildWeekly(days, { cityNames });
  if (!report) {
    console.log('历史快照均为空，无法生成周报。');
    return;
  }
  report.generatedAt = new Date().toISOString();

  // 写 JSON（展示页数据源）+ Markdown（Issue 正文）
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/weekly-latest.json', JSON.stringify(report, null, 1), 'utf8');
  const md = renderWeeklyMarkdown(report);
  const outMd = typeof flags.out === 'string' && flags.out !== '' ? flags.out : null;
  if (outMd) fs.writeFileSync(outMd, md + '\n', 'utf8');

  console.log(`周报已生成：docs/weekly-latest.json${outMd ? ` + ${outMd}` : ''}（追踪 ${report.period.days} 天：${report.period.from} ~ ${report.period.to}）`);
  console.log('\n—— 本期周报预览 ——\n');
  console.log(md);
}

/** birthday 子命令：生日管家（本地存储，隐私不入仓库） */
async function cmdBirthday(flags, action) {
  const FILE = 'birthdays.local.json';
  const list = readLocalJson(FILE, []);

  if (action === 'add') {
    requireFlags(flags, ['name', 'date', 'city', 'guests']);
    const entry = {
      name: String(flags.name),
      date: String(flags.date),
      city: String(flags.city),
      guests: Number(flags.guests),
      budget: flags.budget !== undefined && flags.budget !== true ? Number(flags.budget) : null,
    };
    if (!/^\d{2}-\d{2}$/.test(entry.date)) throw new Error('--date 格式应为 MM-DD，如 05-20');
    const phase = birthdayPhase(entry.date);
    const i = list.findIndex((x) => x.name === entry.name);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    writeLocalJson(FILE, list);
    console.log(`已保存生日档案：${entry.name}（${entry.date} · ${entry.city} · ${entry.guests} 人）`);
    console.log(`距离下一个生日还有 ${phase.daysLeft} 天。档案仅存本地 ${FILE}，不会进入公开仓库。`);
    return;
  }

  if (action === 'remove') {
    requireFlags(flags, ['name']);
    const next = list.filter((x) => x.name !== String(flags.name));
    if (next.length === list.length) throw new Error(`未找到档案 "${flags.name}"`);
    writeLocalJson(FILE, next);
    console.log(`已删除 ${flags.name} 的生日档案。`);
    return;
  }

  // list / check：逐个评估窗口
  if (list.length === 0) {
    console.log(`暂无生日档案。添加：node party.mjs birthday add --name 小宝 --date 05-20 --city 310100 --guests 8`);
    return;
  }
  for (const b of list) {
    const phase = birthdayPhase(b.date);
    const head = `${b.name}（${b.date} · ${b.city} · ${b.guests} 人）→ 还有 ${phase.daysLeft} 天`;
    if (action === 'list' || phase.phase === 'far') {
      console.log(`  ${head}${phase.phase === 'far' ? '（尚未到推荐窗口，T-10 时自动出方案）' : ''}`);
      continue;
    }
    if (phase.phase === 'today') {
      console.log(`  ${head} · 今天就是生日！🎉 直接用 plan 命令找当日场次，或联系门店。`);
      continue;
    }
    // recommend（T-10）/ book（T-3）：自动出推荐
    const tag = phase.phase === 'book' ? '⚠️ 预订窗口（官方要求提前 3 天，立即锁定）' : '推荐窗口（提前比价）';
    console.log(`\n  ${head} · ${tag}`);
    const { results } = await collectPlanData({
      cityCode: b.city,
      guests: b.guests,
      budgetFen: b.budget ? Math.round(b.budget * 100) : null,
      dateStr: null,
      near: null,
      storeLimit: 3,
      spuIds: null,
      log: () => {},
    });
    const ranked = sortResults(results).slice(0, 3);
    if (ranked.length === 0) {
      console.log('  未找到满足条件的场次，建议放宽预算或更换城市。');
      continue;
    }
    for (const r of ranked) {
      console.log(`    · ${r.spuName} | ${r.storeName} | ${r.date} ${r.timeStart}-${r.timeEnd} | ${r.priceText}/人 | 剩${r.leftNum}`);
    }
    console.log(`    下一步（dry-run 预览）：${buildBookHint(ranked[0])}`);
  }
}

/** track 子命令：拼团进度卡（记录场次 → 对比最新快照 → 可分享文案） */
async function cmdTrack(flags) {
  const FILE = 'tracked.local.json';
  const list = readLocalJson(FILE, []);
  const latest = readLocalJson('docs/watch-latest.json', {});
  const latestByKey = new Map((latest.results ?? []).map((r) => [`${r.spuId}:${r.storeCode}:${r.sessionId}`, r]));

  if (flags.spu !== undefined) {
    // 记录新追踪项
    requireFlags(flags, ['spu', 'store', 'date', 'session']);
    const key = `${flags.spu}:${flags.store}:${flags.session}`;
    const cur = latestByKey.get(key);
    const entry = {
      name: typeof flags.name === 'string' ? flags.name : null,
      spuId: Number(flags.spu),
      storeCode: String(flags.store),
      date: String(flags.date),
      sessionId: Number(flags.session),
      spuName: cur?.spuName ?? '',
      storeName: cur?.storeName ?? '',
      timeStart: cur?.timeStart ?? '',
      priceText: cur?.priceText ?? '',
      initialLeft: cur != null ? Number(cur.leftNum) : null,
      addedAt: new Date().toISOString(),
    };
    const i = list.findIndex((x) => `${x.spuId}:${x.storeCode}:${x.sessionId}` === key);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    writeLocalJson(FILE, list);
    console.log(
      `已开始追踪：${entry.spuName || key} · ${entry.storeName} · ${entry.date} ${entry.timeStart}（记录时名额 ${entry.initialLeft ?? '未知'}）`
    );
    console.log(`之后随时运行 node party.mjs track 查看进度。追踪档案仅存本地 ${FILE}。`);
    return;
  }

  if (list.length === 0) {
    console.log('暂无追踪项。添加：node party.mjs track --spu 1830 --store 1450713 --date 2026-10-17 --session 36935759 [--name 小宝生日局]');
    return;
  }
  for (const item of list) {
    const key = `${item.spuId}:${item.storeCode}:${item.sessionId}`;
    const cur = latestByKey.get(key);
    const label = item.name ? `${item.name} · ` : '';
    if (!cur) {
      console.log(`\n${label}${item.spuName || key}（${item.date} ${item.timeStart}）：已从最新快照消失——大概率售罄或下架，去 App 确认吧。`);
      continue;
    }
    const progress = computeProgress(item.initialLeft ?? cur.leftNum, cur.leftNum);
    console.log(`\n${label}${item.spuName} · ${item.storeName} · ${item.date} ${item.timeStart}`);
    console.log(`名额 ${item.initialLeft} → ${cur.leftNum}（${progress.joined} 人已上车${progress.soldOut ? '，已满员' : ''}）`);
    console.log('—— 复制下面这段发到群里 ——');
    console.log(buildShareCard(
      { name: item.name, spuName: cur.spuName, storeName: cur.storeName, date: cur.date, timeStart: cur.timeStart, priceText: cur.priceText },
      progress
    ));
    console.log('\n—— 或发到拼团黑板（本仓库 Issues，零后端撮合）——');
    console.log(
      buildRecruitIssue(
        { name: item.name, spuName: cur.spuName, storeName: cur.storeName, storeCode: cur.storeCode, date: cur.date, timeStart: cur.timeStart, sessionId: cur.sessionId, priceText: cur.priceText },
        progress
      )
    );
  }
}

/** 常用城市码 → 名称（仅用于展示） */
function CITY_NAME_HINT(code) {
  const map = { '310100': '上海', '110100': '北京', '440100': '广州', '440300': '深圳', '330100': '杭州' };
  return map[String(code)] ?? `城市 ${code}`;
}

/** CLI 主入口 */
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  // JSON 输出模式下 stdout 必须是纯 JSON：BANNER 改走 stderr
  if (flags.json === true || flags.format === 'json') {
    process.stderr.write(BANNER + '\n');
  } else {
    console.log(BANNER);
  }

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  // 仅需 token 的命令才提前校验（weekly/survival/track/birthday 纯本地数据，离线可用）
  if (!['weekly', 'survival', 'track', 'birthday'].includes(cmd)) {
    resolveToken();
  }

  switch (cmd) {
    case 'categories':
      return cmdCategories();
    case 'cities':
      return cmdCities(flags);
    case 'stores':
      return cmdStores(flags);
    case 'dates':
      return cmdDates(flags);
    case 'sessions':
      return cmdSessions(flags);
    case 'plan':
      return cmdPlan(flags);
    case 'watch':
      return cmdWatch(flags);
    case 'survival':
      return cmdSurvival();
    case 'weekly':
      return cmdWeekly(flags);
    case 'birthday': {
      // birthday <action> --flags：action ∈ add / list / remove / check
      const action = rest[0] && !rest[0].startsWith('--') ? rest[0] : 'check';
      const bFlags = parseArgs(rest[0] && !rest[0].startsWith('--') ? rest.slice(1) : rest);
      if (!['add', 'list', 'remove', 'check'].includes(action)) {
        throw new Error(`birthday 的动作只能是 add / list / remove / check，收到 "${action}"`);
      }
      return cmdBirthday(bFlags, action);
    }
    case 'track':
      return cmdTrack(flags);
    case 'book':
      return cmdBook(flags);
    default:
      throw new Error(`未知子命令 "${cmd}"。执行 node party.mjs --help 查看用法。`);
  }
}

main().catch((e) => {
  console.error(`\n错误：${e.message}`);
  console.error(
    '\n提示：本工具需要麦当劳官方 MCP Token。若尚未配置，请访问 https://open.mcd.cn/mcp 申请，' +
      '然后设置环境变量 MCD_MCP_TOKEN，或将 Token 写入文件 ~/.config/mcd/mcp_token。'
  );
  process.exit(1);
});
