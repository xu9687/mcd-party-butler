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
import { callTool, resolveToken, MCP_ENDPOINT } from './lib/mcp-client.mjs';
import { sortByDistance, formatDistanceM } from './lib/geo.mjs';
import { verifyPrice, summarizeSession } from './lib/price.mjs';
import { table, clip } from './lib/format.mjs';
import { buildIcs } from './lib/ics.mjs';
import { filterSessions, sortResults, pickDate, buildBookHint } from './lib/plan.mjs';

const VERSION = '1.1.0';
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
       [--date <YYYY-MM-DD>] [--near "纬度,经度"] [--limit <n>] [--json]
      一句话智能规划：自动串「类目→门店→日期→场次」全链路，按价格与距离
      排序输出可订场次推荐表，并给出可直接粘贴的 book 预览命令。
      - --spu all（默认）：每个在售类目取第 1 个商品；--spu <id> 指定单个商品
      - --guests：按人数过滤（场次人数区间 + 剩余名额）
      - --budget：人均预算上限（元）
      - --json：输出机器可读 JSON（供 Agent / 程序化调用）

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

/** plan 子命令：一句话智能规划（全链路只读编排，输出推荐场次表） */
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
  const storeLimit = Number(flags.limit ?? 3) || 3;
  const dateStr = typeof flags.date === 'string' && flags.date !== '' ? flags.date : null;
  const near = parseNear(flags.near);
  const wantJson = flags.json === true;

  const log = wantJson ? () => {} : (s) => process.stderr.write(s + '\n');
  log(`规划条件：城市 ${cityCode}${guests ? ` · ${guests} 人` : ''}${budgetYuan ? ` · 人均预算 ¥${budgetYuan}` : ''}${dateStr ? ` · ${dateStr}` : ''}`);

  // 1) 确定候选商品：--spu <id> 单个，否则每类目第 1 个商品
  const spuIds = [];
  const spuNames = {};
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

  if (flags.spu !== undefined && flags.spu !== true && flags.spu !== 'all') {
    spuIds.push(Number(flags.spu));
  } else {
    for (const cat of PARTY_CATEGORIES) {
      const products = asArray(await callTool('mall-points-products', { catRuleIds: cat.catRuleIds }));
      if (products.length === 0) continue;
      const p = products[0];
      spuIds.push(Number(p.spuId));
      spuNames[p.spuId] = `${cat.name} · ${p.spuName}`;
      log(`候选：${cat.name} → ${p.spuName}（spuId ${p.spuId}）`);
    }
  }

  // 2) 逐商品扫门店 → 日期 → 场次
  const results = [];
  const warnedDates = [];
  for (const spuId of spuIds) {
    let stores = [];
    try {
      stores = asArray(await callTool('query-party-store', { code: cityCode, spuId }));
    } catch {
      continue;
    }
    if (stores.length === 0) {
      log(`spuId ${spuId} 在城市 ${cityCode} 暂无可办门店，跳过`);
      continue;
    }
    if (near) stores = sortByDistance(stores, near.lat, near.lng);
    const scanned = stores.slice(0, storeLimit);

    for (const st of scanned) {
      let dates = [];
      try {
        dates = asArray(await callTool('query-party-store-date', { spuId, storeCode: String(st.code) }));
      } catch {
        continue;
      }
      const picked = pickDate(dates, dateStr);
      if (!picked.date) continue;
      if (picked.warned) warnedDates.push(`${picked.date}（门店 ${st.code}）`);

      let sessions = [];
      try {
        sessions = asArray(
          await callTool('query-party-store-session', { spuId, storeCode: String(st.code), dateStr: picked.date })
        );
      } catch {
        continue;
      }
      const matched = filterSessions(sessions, { guests, budgetFen });
      if (matched.length === 0) continue;

      const { sku, name } = await loadDetail(spuId);
      for (const s of matched) {
        const verified = verifyPrice(s.price, sku);
        results.push({
          spuId,
          spuName: name || spuNames[spuId] || `spuId ${spuId}`,
          skuId: sku?.skuId ?? null,
          storeCode: String(st.code),
          storeName: st.name ?? '',
          address: st.address ?? '',
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
          guests: guests ?? null,
          cityCode,
        });
      }
    }
  }

  const ranked = sortResults(results).slice(0, 10);

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          city: cityCode,
          filters: { guests, budgetYuan, date: dateStr },
          count: ranked.length,
          results: ranked,
        },
        null,
        2
      )
    );
    return;
  }

  if (ranked.length === 0) {
    console.log(`\n城市 ${cityCode} 未找到满足条件的可订场次。`);
    console.log('建议：放宽 --budget / 更换 --date / 去掉 --guests 限制后重试。');
    return;
  }

  console.log(
    `\n城市 ${cityCode} 推荐场次（共 ${ranked.length} 个，按价格升序 · 价格已与商品详情交叉核验）：`
  );
  console.log(
    table(
      ['商品', '门店', '日期', '时段', '人数', '剩余', '单价', '距离'],
      ranked.map((r) => [
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
  if (warnedDates.length > 0) {
    console.log(`注意：指定日期不在部分门店可订列表中，返回可能为空：${[...new Set(warnedDates)].join('、')}`);
  }
  const best = ranked[0];
  console.log('\n最划算方案（可直接粘贴执行，先预览再决定是否下单）：');
  console.log('  ' + buildBookHint(best));
  console.log('\n提示：以上命令默认为 dry-run 预览；确认无误后再追加 --confirm 提交订单。');
}

/** CLI 主入口 */
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  // --json 模式下 stdout 必须是纯 JSON：BANNER 改走 stderr
  if (flags.json === true) {
    process.stderr.write(BANNER + '\n');
  } else {
    console.log(BANNER);
  }

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  // 除 help 外均需要 token（callTool 内部也会校验，这里提前给出明确指引）
  resolveToken();

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
