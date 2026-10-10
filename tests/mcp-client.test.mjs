/**
 * 麦麦派对管家 · MCP 客户端单元测试（node:test，零依赖，不发起真实网络请求）
 *
 * 通过 mock 全局 fetch 验证 callTool 的响应解析、错误处理与 token 脱敏。
 * 运行：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool, redact, maskToken } from '../lib/mcp-client.mjs';

// 使用假 token 覆盖环境变量（环境变量优先于文件，避免真实 token 参与测试）。
// 刻意混入小写字母，确保不匹配「32 位大写字母+数字」的真实 token 形态，
// 保持全仓库 token 形态扫描的干净（该假值仅为测试夹具，非真实凭证）。
const FAKE_TOKEN = 'AaBbCcDdEeFf00112233445566778899zZ';
process.env.MCD_MCP_TOKEN = FAKE_TOKEN;

/** mock 全局 fetch，按 JSON-RPC method 分发；返回恢复函数 */
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    const payload = handler(body, url, opts);
    if (payload && payload.__raw) return payload.value; // 允许直接返回自定义响应对象
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () => JSON.stringify(payload),
    };
  };
  return () => {
    globalThis.fetch = original;
  };
}

/** 标准握手响应（initialize） */
function handshakeOk() {
  return {
    jsonrpc: '2.0',
    id: 0,
    result: { serverInfo: { name: 'mcd-mcp', version: '1.0.0' } },
  };
}

const INIT = 'initialize';
const CALL = 'tools/call';

test('callTool: structuredContent.data 优先于 content[0].text', async () => {
  const restore = mockFetch((body) => {
    if (body.method === INIT) return handshakeOk();
    assert.equal(body.params.name, 'query-demo');
    return {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [
          { type: 'text', text: '说明文字\n## Original Response\n{"from":"text"}' },
        ],
        structuredContent: { data: { from: 'structured' } },
      },
    };
  });
  try {
    const data = await callTool('query-demo', {});
    assert.deepEqual(data, { from: 'structured' });
  } finally {
    restore();
  }
});

test('callTool: text 含 "## Original Response" 时截取其后 JSON 解析', async () => {
  const restore = mockFetch((body) => {
    if (body.method === INIT) return handshakeOk();
    return {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [
          {
            type: 'text',
            text: '以下是原始响应：\n## Original Response\n\n{"list":[{"code":"310100"}]}',
          },
        ],
      },
    };
  });
  try {
    const data = await callTool('query-demo', {});
    assert.deepEqual(data, { list: [{ code: '310100' }] });
  } finally {
    restore();
  }
});

test('callTool: 纯文本（无 marker 且非 JSON）原样返回', async () => {
  const restore = mockFetch((body) => {
    if (body.method === INIT) return handshakeOk();
    return {
      jsonrpc: '2.0',
      id: body.id,
      result: { content: [{ type: 'text', text: '这只是普通文本说明' }] },
    };
  });
  try {
    const data = await callTool('query-demo', {});
    assert.equal(data, '这只是普通文本说明');
  } finally {
    restore();
  }
});

test('callTool: 业务 success=false（code 600050）抛出中文错误', async () => {
  const restore = mockFetch((body) => {
    if (body.method === INIT) return handshakeOk();
    return {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{ type: 'text', text: 'x' }],
        structuredContent: {
          data: { success: false, code: 600050, message: '收藏餐厅为空' },
        },
      },
    };
  });
  try {
    await assert.rejects(
      () => callTool('query-favorite', {}),
      (e) => {
        assert.match(e.message, /MCP 业务错误（code 600050）/);
        assert.match(e.message, /收藏餐厅为空/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('callTool: JSON-RPC error 抛出协议错误（且信息被脱敏）', async () => {
  const restore = mockFetch((body) => {
    if (body.method === INIT) return handshakeOk();
    return {
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32000, message: `bad request for ${FAKE_TOKEN}` },
    };
  });
  try {
    await assert.rejects(
      () => callTool('query-demo', {}),
      (e) => {
        assert.match(e.message, /MCP 协议错误（code -32000）/);
        assert.ok(!e.message.includes(FAKE_TOKEN), '错误信息不得包含 token 明文');
        assert.match(e.message, /\*\*\*\*99zZ/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('callTool: result.isError 时抛出工具执行错误并脱敏', async () => {
  const restore = mockFetch((body) => {
    if (body.method === INIT) return handshakeOk();
    return {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        isError: true,
        content: [
          { type: 'text', text: `upstream error: Authorization: Bearer ${FAKE_TOKEN} rejected` },
        ],
      },
    };
  });
  try {
    await assert.rejects(
      () => callTool('query-demo', {}),
      (e) => {
        assert.match(e.message, /MCP 工具 query-demo 执行出错/);
        assert.ok(!e.message.includes(FAKE_TOKEN), '错误信息不得包含 token 明文');
        assert.match(e.message, /\*\*\*\*99zZ/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('callTool: 握手 serverInfo 不符时抛错（独立模块实例，绕过 initialize 缓存）', async () => {
  // callTool 的 initialize 握手在模块级缓存后不再重复执行，
  // 这里用带 query 的动态 import 拿到全新模块实例以触发握手路径
  const { callTool: freshCallTool } = await import('../lib/mcp-client.mjs?fresh=handshake-mismatch');
  const restore = mockFetch((body) => {
    if (body.method === INIT) {
      return {
        jsonrpc: '2.0',
        id: body.id,
        result: { serverInfo: { name: 'other-server' } },
      };
    }
    return handshakeOk();
  });
  try {
    await assert.rejects(
      () => freshCallTool('query-demo', {}),
      /MCP 握手失败：未返回预期的 serverInfo/
    );
  } finally {
    restore();
  }
});

test('callTool: HTTP 非 2xx 抛出可读错误（独立模块实例）', async () => {
  const { callTool: freshCallTool } = await import('../lib/mcp-client.mjs?fresh=http401');
  const restore = mockFetch(() => ({
    __raw: true,
    value: {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: { get: () => 'application/json' },
      text: async () => '{"error":"unauthorized"}',
    },
  }));
  try {
    await assert.rejects(
      () => freshCallTool('query-demo', {}),
      (e) => {
        assert.match(e.message, /MCP 请求失败：HTTP 401/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('redact: 替换环境变量中的 token 为脱敏形式', () => {
  const out = redact(`Authorization: Bearer ${FAKE_TOKEN} failed`);
  assert.ok(!out.includes(FAKE_TOKEN), '不应包含 token 明文');
  assert.match(out, /\*\*\*\*99zZ/);
});

test('redact: 无 token 输入原样返回', () => {
  assert.equal(redact('普通错误信息'), '普通错误信息');
  assert.equal(redact(null), '');
});

test('maskToken: 只显示末 4 位', () => {
  assert.equal(maskToken(FAKE_TOKEN), '****99zZ');
  assert.equal(maskToken('abc'), '****');
  assert.equal(maskToken(undefined), '****');
});
