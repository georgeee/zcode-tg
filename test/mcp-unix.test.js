// The unix-socket transport: line-delimited JSON-RPC on a per-fleet socket,
// the production path. The socket FILE is the authentication — 0600, inside
// the caller's state dir — so the assertions here cover the protocol AND the
// file permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpGateway } from '../bridge/mcp.js';

test('the unix listener speaks line JSON-RPC and locks the socket to 0600', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-unix-'));
  fs.mkdirSync(path.join(dir, 'state', 'zcode-tg'), { recursive: true, mode: 0o700 });
  const sock = path.join(dir, 'state', 'zcode-tg', 'mcp.sock');
  const gw = createMcpGateway({ unixSocket: sock, log: () => {} });
  gw.wire({ modelGet: () => ({ model: 'zai/glm-5.3-flash', switchable: false }) });
  await gw.ready;
  t.after(() => gw.close());

  const st = fs.statSync(sock);
  assert.equal(st.mode & 0o777, 0o600, `socket mode is ${st.mode & 0o777}, want 600`);

  const reply = await new Promise((resolve, reject) => {
    const c = net.connect(sock, () => {
      c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
      c.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      c.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'model_get', arguments: {} } }) + '\n');
    });
    let buf = '';
    const lines = [];
    c.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        if (lines.length === 2) {
          c.end();
          resolve(lines);
          return;
        }
      }
    });
    c.on('error', reject);
  });

  assert.equal(reply[0].result.tools.length, 6, 'tools/list over the socket');
  assert.equal(reply[1].id, 2);
  assert.equal(reply[1].result.content[0].text.includes('zai/glm-5.3-flash'), true, 'model_get over the socket');
  // two requests, two responses: the notification in the middle produced none
  assert.equal(reply.length, 2);
});
