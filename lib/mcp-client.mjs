/**
 * 麦麦派对管家 · 极简 MCP JSON-RPC 客户端（零第三方依赖）
 *
 * - 端点：https://mcp.mcd.cn/mcp-servers/mcd-mcp（Streamable HTTP，普通 POST JSON-RPC）
 * - 鉴权：Authorization: Bearer <token>，token 来自环境变量 MCD_MCP_TOKEN
 *   或文件 ~/.config/mcd/mcp_token
 * - 响应兼容两种格式：
 *   1) result.structuredContent.data（直接 JSON）
 *   2) result.content[0].text 中 "## Original Response" 之后的 JSON 字符串
 * - 任何日志/错误信息中绝不输出 token 明文（统一脱敏）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** MCP Server 端点 */
export const MCP_ENDPOINT = 'https://mcp.mcd.cn/mcp-servers/mcd-mcp';

/** Token 文件的默认路径 */
export const TOKEN_FILE = path.join(os.homedir(), '.config', 'mcd', 'mcp_token');

/** Token 申请指引 */
export const TOKEN_GUIDE =
  '未找到麦当劳官方 MCP Token。请访问 https://open.mcd.cn/mcp 申请，' +
  '然后设置环境变量 MCD_MCP_TOKEN，或将 Token 保存到文件 ' +
  TOKEN_FILE +
  '（文件内容为 Token 本身，无换行）。';

/**
 * 读取 MCP Token：优先环境变量 MCD_MCP_TOKEN，其次 ~/.config/mcd/mcp_token。
 * @returns {string} token
 * @throws {Error} 两处都取不到时抛出含申请指引的中文错误
 */
export function resolveToken() {
  const fromEnv = process.env.MCD_MCP_TOKEN;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();

  try {
    const fromFile = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (fromFile !== '') return fromFile;
  } catch {
    // 文件不存在或不可读，继续走抛错分支
  }

  throw new Error(TOKEN_GUIDE);
}

/**
 * 对 token 做脱敏显示：**** + 末 4 位。
 * @param {string} token
 * @returns {string}
 */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length <= 4) return '****';
  return '****' + token.slice(-4);
}

/**
 * 将文本中出现的 token 替换为脱敏形式（防御性兜底）。
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  let out = String(text ?? '');
  const envToken = process.env.MCD_MCP_TOKEN;
  if (envToken && envToken.trim() !== '') {
    out = out.split(envToken.trim()).join(maskToken(envToken.trim()));
  }
  try {
    const fileToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (fileToken !== '') out = out.split(fileToken).join(maskToken(fileToken));
  } catch {
    // 忽略：文件不存在时无需脱敏
  }
  return out;
}

/** 进程内自增的 JSON-RPC 请求 id */
let seqId = 100;

/** initialize 握手 Promise（进程内缓存一次；缓存 Promise 而非布尔值，保证并发安全） */
let initPromise = null;

/**
 * 发送一条 JSON-RPC 请求（底层传输）。
 * 兼容响应 content-type 为 application/json 或 text/event-stream（SSE 按 data: 行解析）。
 * @param {string} method JSON-RPC 方法名
 * @param {object} params JSON-RPC 参数
 * @returns {Promise<object>} JSON-RPC result
 */
async function rpc(method, params) {
  let token;
  try {
    token = resolveToken();
  } catch (e) {
    throw new Error(redact(e.message));
  }

  const body = JSON.stringify({ jsonrpc: '2.0', id: ++seqId, method, params });

  let res;
  try {
    res = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body,
    });
  } catch (e) {
    throw new Error(redact(`无法连接 MCP 服务（${MCP_ENDPOINT}）：${e.message}`));
  }

  if (!res.ok) {
    throw new Error(redact(`MCP 请求失败：HTTP ${res.status} ${res.statusText}`));
  }

  const contentType = String(res.headers.get('content-type') ?? '').toLowerCase();
  const bodyText = await res.text();
  let payload;

  if (contentType.includes('text/event-stream')) {
    // 防御：SSE 格式按 data: 行解析，取最后一条可解析的 JSON
    const dataLines = bodyText
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    payload = null;
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        payload = JSON.parse(dataLines[i]);
        break;
      } catch {
        // 继续尝试上一条 data 行
      }
    }
    if (!payload) {
      throw new Error('MCP 返回的 event-stream 中未找到有效 JSON 数据');
    }
  } else {
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new Error(redact(`MCP 返回内容不是合法 JSON：${bodyText.slice(0, 200)}`));
    }
  }

  if (payload.error) {
    throw new Error(
      redact(`MCP 协议错误（code ${payload.error.code ?? '未知'}）：${payload.error.message ?? '无详细信息'}`)
    );
  }

  if (!payload.result) {
    throw new Error('MCP 响应缺少 result 字段');
  }
  return payload.result;
}

/** initialize 握手参数（进程内只做一次） */
function handshakeParams() {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcd-party-butler', version: '1.0.0' },
  };
}

/**
 * 独立的握手验证（不依赖进程内缓存，供 setup-connector 等场景使用）。
 * @param {string} token 用于验证的 token
 * @returns {Promise<{name: string, version: string}>} serverInfo
 * @throws {Error} 握手失败时抛出（错误信息不含 token 明文）
 */
export async function verifyHandshake(token) {
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: handshakeParams() }),
  });
  if (!res.ok) {
    throw new Error(`握手失败：HTTP ${res.status} ${res.statusText}（请检查 Token 是否有效）`);
  }
  const payload = JSON.parse(await res.text());
  if (payload.error) {
    throw new Error(`握手失败：${payload.error.message ?? '协议错误'}`);
  }
  const info = payload?.result?.serverInfo;
  if (!info || info.name !== 'mcd-mcp') {
    throw new Error('握手失败：未返回预期的 serverInfo（mcd-mcp）');
  }
  return info;
}

/**
 * 从 MCP 工具响应中提取业务数据（统一适配两种返回格式）。
 * @param {object} result JSON-RPC result
 * @returns {*} 解析后的业务数据
 */
function extractData(result) {
  // 格式 1：structuredContent.data
  if (result?.structuredContent && result.structuredContent.data !== undefined) {
    return result.structuredContent.data;
  }
  // 格式 2：content[0].text 中 "## Original Response" 之后的 JSON
  const text = result?.content?.[0]?.text;
  if (typeof text === 'string') {
    const marker = '## Original Response';
    const idx = text.indexOf(marker);
    if (idx >= 0) {
      const jsonPart = text.slice(idx + marker.length).trim();
      try {
        return JSON.parse(jsonPart);
      } catch {
        // 解析失败则继续尝试其他途径
      }
    }
    try {
      return JSON.parse(text);
    } catch {
      // 纯文本内容，原样返回
      return text;
    }
  }
  // 兜底：直接返回 result
  return result;
}

/**
 * 检查业务层 success=false 的情况（如 code 600050 收藏餐厅为空）。
 * @param {*} data 业务数据
 * @throws {Error} success=false 时抛出可读中文错误
 */
function checkBusiness(data) {
  if (data && typeof data === 'object' && data.success === false) {
    throw new Error(
      `MCP 业务错误（code ${data.code ?? '未知'}）：${data.message ?? data.msg ?? '无详细信息'}`
    );
  }
}

/** 确保握手完成（并发安全：多个 callTool 并发时只会触发一次 initialize） */
function ensureInit() {
  if (!initPromise) {
    initPromise = rpc('initialize', handshakeParams()).then((info) => {
      if (info?.serverInfo?.name !== 'mcd-mcp') {
        // 握手失败时清除缓存，允许下次重试
        initPromise = null;
        throw new Error('MCP 握手失败：未返回预期的 serverInfo（mcd-mcp）');
      }
      return info;
    });
  }
  return initPromise;
}

/**
 * 调用一个 MCP 工具，返回解析后的业务数据。
 * 首次调用前会自动完成 initialize 握手（进程内缓存一次，并发安全）。
 * @param {string} name 工具名，如 "query-party-store"
 * @param {object} args 工具参数
 * @returns {Promise<*>} 解析后的业务数据（优先 structuredContent.data，其次 Original Response）
 * @throws {Error} HTTP 非 200、协议错误、业务 success=false 时抛出可读中文错误（已脱敏）
 */
export async function callTool(name, args = {}) {
  await ensureInit();

  const result = await rpc('tools/call', { name, arguments: args });

  if (result?.isError) {
    const text = result?.content?.[0]?.text ?? '无详细信息';
    throw new Error(redact(`MCP 工具 ${name} 执行出错：${String(text).slice(0, 300)}`));
  }

  const data = extractData(result);
  checkBusiness(data);
  if (result?.structuredContent) checkBusiness(result.structuredContent);
  return data;
}
