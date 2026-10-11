---
name: mcd-party-butler
description: 麦麦派对管家——基于麦当劳官方 MCP 的派对场次查询与预订闭环 Skill，支持类目/城市/门店/日期/场次五级查询、价格交叉核验与确认式下单，并生成 .ics 日历邀请。
---

# 麦麦派对管家（mcd-party-butler）

## 能力概述

帮用户把麦当劳派对场次真正「订上」：查询派对类目与商品 → 可举办城市 → 门店 →
可订日期 → 具体场次（价格/剩余名额透明化），确认后代为下单并生成日历邀请。
与 mcd-event-radar（负责发现活动）定位互补：它管发现，本 Skill 管成交。

数据来源：麦当劳官方 MCP（`mcd-mcp`，端点 `https://mcp.mcd.cn/mcp-servers/mcd-mcp`，
Streamable HTTP，`Authorization: Bearer <token>` 鉴权）。价格、场次、名额一律以
官方 MCP 实时返回为准。

## 三级自检（使用前必须逐条检查）

1. **Token 是否存在？** 检查环境变量 `MCD_MCP_TOKEN`，或文件
   `~/.config/mcd/mcp_token`。两者都不存在时，引导用户访问
   https://open.mcd.cn/mcp 申请，或运行 `node setup-connector.mjs` 前先完成申请。
2. **mcp.json 是否已配置 mcd-mcp？** 检查 `~/.workbuddy/mcp.json` 的
   `mcpServers` 中是否有 `mcd-mcp` 条目。没有则运行
   `node setup-connector.mjs` 一键配置（脚本会自动备份并合并，不破坏已有条目）。
3. **本会话是否已生效？** 在会话中实际调用一次 `now-time-info` 之类的只读工具
   验证连通性。若未生效，提示用户重开 WorkBuddy 会话；仍不生效时给出兜底路径：
   在项目目录执行 `node party.mjs <子命令>`（CLI 与 MCP 能力等价）。

## 六步调用链（查询 → 下单）

| 步骤 | 工具 | 关键入参 | 说明 |
| --- | --- | --- | --- |
| 1 | `mall-points-products` | `catRuleIds` | 派对类目：`1>6>20` 生日类、`1>6>21` 主题类、`1>6>25` 品鉴会、`1>6>34` 读书会（`1>6>22` 体验营与 `1>6>40` 积分兑换当前为空）。返回 `spuId/spuName/point/selling`。商品层 point 显示 0，真实价格在场次层 |
| 2 | `query-party-city` | `spuId` | 返回约 279 个城市（`name/code`）。**坑：code 是市级码（上海市 310100），传省级码（310000）返回空** |
| 3 | `query-party-store` | `code, spuId` | 返回门店 `name/code/address/distance/distanceText`。**坑：字段是 name/code，不是文档写的 storeName/storeCode** |
| 4 | `query-party-store-date` | `spuId, storeCode` | 返回 `[{date, storeCode}]`，实测未来 9 天 |
| 5 | `query-party-store-session` | `spuId, storeCode, dateStr` | 返回 `[{id, timeStart, timeEnd, partyMin, partyMax, price, leftNum}]`。**price 单位是分** |
| 6 | `mall-product-detail` | `spuId` | 返回 `spuName/skuList[].price`（元字符串）。用于与场次 price 交叉核验（×100 倍率一致才算核验通过） |

下单用 `party-order-create`（见下方安全门）。

## 下单安全门（必须遵守）

1. 生成订单前，必须先向用户**回显完整订单明细**：商品、门店（名称/地址/编码）、
   日期、时段、形式（包场/拼团）、人数、单价、小计、剩余名额。
2. 必须获得用户**明确确认**（如「确认下单」的肯定答复）后，才能带 `--confirm`
   执行 `node party.mjs book ...`。
3. **无明确确认时绝不产生订单**——不带 `--confirm` 执行 book 只输出预览，
   不会调用 `party-order-create`，可放心用于展示。
4. 绝不调用与派对无关的写操作工具（create-order、mall-create-order、
   draw-lottery、auto-bind-coupons、cancel-order 等）。

## CLI 用法（与 MCP 能力等价的兜底路径）

```bash
node party.mjs categories
node party.mjs cities --spu 11308 --keyword 上海
node party.mjs stores --spu 11308 --city 310100 --limit 10
node party.mjs dates --spu 11308 --store 1450713
node party.mjs sessions --spu 11308 --store 1450713 --date 2026-10-17 --available
node party.mjs book --spu 11308 --sku 11936 --store 1450713 --date 2026-10-17 \
  --session <场次id> --party-type 2 --count 5          # 先预览
node party.mjs book ... --confirm                       # 用户确认后才执行
```

## 常见错误排查

| 现象/错误 | 原因 | 处理 |
| --- | --- | --- |
| `MCP 业务错误（code 600050）` | 收藏餐厅为空等业务空态 | 属正常业务返回，引导用户换查询条件（换城市/门店/日期） |
| 城市查询返回空数组 | 传了省级码（如 310000） | 改用市级码（如上海市 310100），先跑 `cities --keyword` 确认 |
| 价格显示「单位待核实（原始 11800）」 | 场次 price 与商品详情 SKU 价对不上（倍率≠100）或详情拉取失败 | 不要自行猜测单位；向用户展示原始数值并说明待核实，以官方渠道为准 |
| 握手失败 / HTTP 401 | Token 缺失或失效 | 走三级自检第 1 步；重新申请或更新 Token（绝不把 Token 写入任何仓库文件） |
| 客户端连不上 mcd-mcp（连接错误） | 不同客户端对 `type` 字段大小写实现有差异（WorkBuddy 接受驼峰 `streamableHttp`，部分客户端只认全小写） | 把 `mcp.json` 中 `type` 改为全小写 `streamablehttp`（或反之），改完重开会话 |

## 对话式向导工作流（推荐给 Agent 使用）

用户表达模糊意向（如「想给娃办生日派对」「周末有什么活动」）时，按以下多轮流程推进，
每一步用 AskUserQuestion 或自然提问确认，不要一次抛出所有选项：

1. **定位城市**：用户未给城市时询问；给出城市后用 `query-party-city` 校验市级码
   （常见：上海 310100 / 北京 110100 / 广州 440100 / 深圳 440300）。
2. **定位偏好**：人数（几大几小）、预算上限、期望日期。任一项缺失就问，问完调用
   `party.mjs plan --city <code> --guests <n> --budget <元> [--date <日期>]`（或按六步链
   逐工具调用），拿到排序后的推荐场次。
3. **呈现推荐**：最多给 3 个方案（价格升序），每个方案一行：商品 · 门店 · 日期时段 ·
   单价 · 剩余名额。价格必须带核验状态（✓ 已核验 / 待核实）。
4. **用户选中后**：先展示完整订单预览（dry-run：`book` 不带 --confirm 的输出），
   明确询问「确认按此下单吗？」。
5. **获得明确确认**（用户回复「确认/下单/可以」等肯定语义）后，才执行
   `party.mjs book ... --confirm`。用户犹豫、追问、或话题转移时视为未确认。
6. **下单完成后**：告知 .ics 日历文件已生成，提醒提前 3 天、4-12 岁适用等官方约束。

硬约束：第 5 步之前绝不调用 `party-order-create` / `book --confirm`。

## watch：稀缺性快照（可选进阶）

用户问「最近有没有便宜场次释出」「名额还多吗」时，可运行
`node party.mjs watch --city <code>`（读 `docs/watch-latest.json` 的上次快照并对比），
向用户报告：新释出场次、剩余名额变化、已售罄场次。

## 进阶能力（v1.3+）

### 生日管家
用户提到"孩子的生日""每年都要办"时，建议保存生日档案：
`node party.mjs birthday add --name <名> --date <MM-DD> --city <code> --guests <n> [--budget <元>]`。
`birthday check` 自动判断窗口：T-10 出比价推荐、T-3 强提醒预订（官方要求提前 3 天）。
档案存本地 birthdays.local.json，绝不让用户把生日写进公开仓库。

### 拼团进度卡
用户订下场次后，主动建议：`node party.mjs track --spu ... --session ... [--name <局名>]`。
之后每次 `track` 输出名额变化与可分享文案；若用户反馈"要发群里招人"，直接把 track 的
分享卡输出给用户复制。

### 存活统计
用户问"场次会不会很快没""现在订还是等等"时，运行 `node party.mjs survival` 给出
历史存活数据；数据不足 3 天时如实告知"样本积累中"，不编造概率。

## 周报与拼团黑板（v1.4+ 叙事能力）

- 用户问「最近派对市场怎么样」「哪个时段最抢手」时：`node party.mjs weekly` 生成
  数据叙事周报（分城战报/最抢手时段/名额消亡榜），摘要点句给用户；完整版在
  docs/weekly-latest.md（Actions 每周一 09:00 自动发到仓库 Issues，标签 weekly-report）。
- 用户订下场次想招人拼团时：`track` 输出的「拼团黑板」Markdown 可直接贴到本仓库
  Issues（评论区 +1 报名，满员后 book --confirm 统一下单）——零后端撮合。
- 消亡曲线：快照累计满 2 天后展示页自动绘制；样本 <3 天时如实告知"样本积累中"，
  绝不编造概率或趋势。
