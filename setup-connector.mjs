#!/usr/bin/env node
/**
 * 麦麦派对管家 · WorkBuddy 连接器一键配置脚本（零第三方依赖）
 *
 * 功能：
 * 1. 读取 MCP Token（环境变量 MCD_MCP_TOKEN → ~/.config/mcd/mcp_token）
 * 2. 备份 ~/.workbuddy/mcp.json 到 mcp.json.bak-<时间戳>
 * 3. 合并写入 mcd-mcp 连接器配置（保留已有其他 mcpServers 条目）
 * 4. 在线验证（initialize 握手）并报告成功/失败
 *
 * 安全：全程绝不打印 token 明文（仅显示 **** + 末 4 位）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveToken, maskToken, verifyHandshake, MCP_ENDPOINT } from './lib/mcp-client.mjs';

const WORKBUDDY_DIR = path.join(os.homedir(), '.workbuddy');
const CONFIG_PATH = path.join(WORKBUDDY_DIR, 'mcp.json');

/** 生成备份用时间戳（文件名安全格式） */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main() {
  console.log('麦麦派对管家 · WorkBuddy 连接器一键配置');
  console.log('========================================');

  // 1. 读取 token（不打印明文）
  let token;
  try {
    token = resolveToken();
  } catch (e) {
    console.error(`\n错误：${e.message}`);
    process.exit(1);
  }
  console.log(`已读取 Token：${maskToken(token)}`);

  // 2. 准备目录并备份已有配置
  fs.mkdirSync(WORKBUDDY_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    const bakPath = `${CONFIG_PATH}.bak-${timestamp()}`;
    fs.copyFileSync(CONFIG_PATH, bakPath);
    console.log(`已备份原配置到：${bakPath}`);
  }

  // 3. 读取已有配置并合并（保留其他 mcpServers 条目）
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    config = {};
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
  const otherCount = Object.keys(config.mcpServers).filter((k) => k !== 'mcd-mcp').length;

  config.mcpServers['mcd-mcp'] = {
    type: 'streamableHttp',
    url: MCP_ENDPOINT,
    headers: { Authorization: `Bearer ${token}` },
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(
    `已写入配置：${CONFIG_PATH}（mcd-mcp 已配置，另有 ${otherCount} 个已有连接器条目保留）`
  );

  // 4. 在线验证（initialize 握手）
  console.log('正在在线验证（initialize 握手）……');
  try {
    const info = await verifyHandshake(token);
    console.log(`验证成功：serverInfo = ${info.name} ${info.version ?? ''}`);
    console.log('\n完成！请重开 WorkBuddy 会话以使配置生效，然后可以直接对话：');
    console.log('  「帮我看看上海周末有什么麦当劳派对」');
  } catch (e) {
    console.error(`\n验证失败：${e.message}`);
    console.error('配置文件已写入，但未能通过在线验证。请检查 Token 是否有效后重试。');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n错误：${e.message}`);
  process.exit(1);
});
