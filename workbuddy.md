# WorkBuddy 开发记录（workbuddy.md）

本仓库的全部代码在 **WorkBuddy Agent 模式**下由 WorkBuddy 编写完成。
以下为本次参赛项目真实的开发会话记录整理，敏感信息（如 MCP Token）一律以 `****` 脱敏。

## 时间线

### 2026-10-10 上午 · 赛制梳理

用户提供大赛台账页
https://www.mcdonalds.com.cn/page/20261009-M-CODE-Competition 。
WorkBuddy 抓取页面（正文为 5 张海报图片，带 Referer 下载后逐张读图），梳理出赛制要点：

- 排名按 GitHub Star 数；截止 2026-10-25；
- 官方仓库：M-China/mcd-developer-innovation-challenge；
- 前 100 名且仓库含 workbuddy.md（本文件）的项目，可获 WorkBuddy 3000 积分专项奖励。

### 2026-10-10 13:48 · MCP 真机打通

用户提供 MCP Token（脱敏为 `****`），WorkBuddy 完成实测：

- `initialize` 握手成功（serverInfo：mcd-mcp 1.0.0）；
- `tools/list` 拉到 35 个工具，逐类实测（营养表 160 项、积分账户、优惠券、
  活动日历、积分商城 24 款等）；
- 配置写入本机 `~/.workbuddy/mcp.json`，期间发现 `type` 需用驼峰
  `streamableHttp` 的兼容性细节。

### 2026-10-10 下午 · 方向决策

WorkBuddy 分析了全网 15 个竞品的 Star 分布，识别出四条拥挤赛道：
优惠券（37★）、积分（17★）、热量点餐（16★）、活动发现（50★）。
据此选定空位——**「派对预订管家」**（`party-order-create` 调用链全网几乎无人做），
并与头部作品 mcd-event-radar 定位互补：它管发现、本作品管成交。

### 2026-10-10 14:11-14:20 · 六步调用链真机全链路走通

按「类目 → 城市 → 门店 → 日期 → 场次 → 商品详情」真机走通：

- 4 个类目共 26 个派对商品；
- 279 个可举办城市；上海过家家派对 174 家门店；未来 9 天可订日期；
- 场次实测（price 11800 分 / partyMin 5 / leftNum 12）；
- `mall-product-detail`（sku price 118 元）与场次价格交叉核验，×100 倍率成立；
- 过程中发现并记录两个坑：**省级城市码返回空数组**、**门店字段实测为
  name/code 而非文档所写 storeName/storeCode**。

### 2026-10-10 15:33 · 代码实现

本代码实现会话：本仓库全部代码（CLI、MCP 客户端、价格核验、表格渲染、
.ics 生成、WorkBuddy 连接器配置脚本与全部文档）在 WorkBuddy Agent 模式下
由 WorkBuddy 编写，全程零第三方依赖。
