#!/usr/bin/env node
// Standalone E2E verification for turn-error fix round (E1 - E5)
// Spawns real bridge/index.js against fake Telegram and fake-agy.mjs.
//
// E1: AGY-503-EMPTY returns error:true + lastError; subsequent turn clears lastError (F5); replies_get marks error:true.
// E2: AGY-SLOW + 2 rapid prompts within inputMergeMs; neither merged, all 3 receive own reply (F2 + H2 attribution).
// E3: AGY-SLOW + queued prompt + /clearqueue; queued call rejected within 5s naming /clearqueue (F3).
// E4: AGY-SLOW + /stop; active call ends within 5s naming /stop (F3).
// E5: Handover note for F1 resumed-session fallback (zcode deferred model adapter failure path).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const FIXTURES = path.join(REPO, "test", "fixtures");
const AGY_FIXTURE = path.join(FIXTURES, "fake-agy.mjs");
const TMP = `/tmp/zbridge-e2e-turnerr-${Date.now()}`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const CHAT = -100888, USER = 42;
let nextMsgId = 100, nextThreadId = 900, nextUpdateId = 1;
const calls = { send: [], edit: [], topicCreated: [] };
const pendingUpdates = [];
const waitingGetUpdates = new Set();

function pushTelegramUpdate(update) {
  pendingUpdates.push(update);
  for (const cb of waitingGetUpdates) cb();
  waitingGetUpdates.clear();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const method = req.url.split("/").pop();
  const ok = (result = {}) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  };
  if (method === "getUpdates") {
    const p = JSON.parse(body || "{}");
    while (pendingUpdates.length && pendingUpdates[0].update_id < p.offset) {
      pendingUpdates.shift();
    }
    let answered = false;
    const answer = () => {
      if (answered) return;
      answered = true;
      ok(pendingUpdates.splice(0, 10));
    };
    if (pendingUpdates.length) return answer();
    const timer = setTimeout(() => {
      waitingGetUpdates.delete(answer);
      answer();
    }, 1000);
    waitingGetUpdates.add(() => {
      clearTimeout(timer);
      answer();
    });
    return;
  }
  if (method === "sendMessage") {
    const p = JSON.parse(body || "{}");
    calls.send.push(p);
    return ok({ message_id: nextMsgId++ });
  }
  if (method === "editMessageText") {
    const p = JSON.parse(body || "{}");
    calls.edit.push(p);
    return ok({ message_id: p.message_id });
  }
  if (method === "createForumTopic") {
    const p = JSON.parse(body || "{}");
    const tid = nextThreadId++;
    calls.topicCreated.push({ ...p, message_thread_id: tid });
    return ok({ message_thread_id: tid, chat_id: p.chat_id, name: p.name });
  }
  if (method === "getMe") return ok({ id: 4242, is_bot: true });
  if (method === "getChat") return ok({ id: JSON.parse(body || "{}").chat_id, type: "supergroup", title: "E2E Home", is_forum: true });
  if (method === "getChatMember") return ok({ status: "administrator" });
  if (method === "closeForumTopic") return ok(true);
  if (method === "setMyCommands") return ok(true);
  return ok();
});

await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const tgPort = srv.address().port;

const bridge = spawn(process.execPath, [path.join(REPO, "bridge/index.js")], {
  env: {
    ...process.env,
    TELEGRAM_API_ROOT: `http://127.0.0.1:${tgPort}`,
    TELEGRAM_BOT_TOKEN: "e2e-fake-token",
    TELEGRAM_CHAT_ID: String(CHAT),
    TELEGRAM_ALLOWED_USER_ID: String(USER),
    DEFAULT_BACKEND: "antigravity",
    ZCODE_NODE_BIN: process.execPath,
    ZCODE_BIN: path.join(FIXTURES, "fake-zcode-app-server.mjs"),
    AGY_BIN: AGY_FIXTURE,
    AGY_HOME: path.join(TMP, "agy-home"),
    STORE_PATH: path.join(TMP, "sessions.json"),
    ZCODE_WORKSPACE_DIR: path.join(TMP, "ws"),
    MCP_HTTP_PORT: "0",
    INPUT_MERGE_MS: "800",
    FIXTURE_AGY_SLOW_MS: "8000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let bridgeLog = "";
bridge.stdout.on("data", (c) => { bridgeLog += c; });
bridge.stderr.on("data", (c) => { bridgeLog += c; });

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}\nbridge log: ${bridgeLog.slice(-1000)}`);
    await sleep(50);
  }
}

let nextRpcId = 1;
async function mcp(port, body, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, body: res.status === 204 ? null : JSON.parse(text) };
  } catch (err) {
    if (err.name === "AbortError") {
      return { timeout: true, error: new Error(`mcp call timed out after ${timeoutMs}ms`) };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const tool = (port, name, args, timeoutMs = 20000) =>
  mcp(port, { jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }, timeoutMs);

let failures = 0;
const report = (id, cond, detail = "") => {
  if (cond) {
    console.log(`PASS ${id}: ${detail}`);
  } else {
    console.log(`FAIL ${id}: ${detail}`);
    failures++;
  }
};

try {
  await waitFor(() => bridgeLog.match(/mcp gateway listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/), 15000, "mcp listener");
  const mcpPort = Number(bridgeLog.match(/mcp gateway listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/)[1]);

  await mcp(mcpPort, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await mcp(mcpPort, { jsonrpc: "2.0", method: "notifications/initialized" });

  // --- E1 ---
  {
    const s1 = await tool(mcpPort, "session_create", { name: "e1-topic", chat_id: CHAT });
    const key1 = JSON.parse(s1.body.result.content[0].text).key;
    // AGY-503-EMPTY retries twice (5s + 20s = 25s), so give it 35s
    const r1 = await tool(mcpPort, "message_send", { key: key1, text: "AGY-503-EMPTY" }, 35000);
    const p1 = JSON.parse(r1.body?.result?.content?.[0]?.text || "{}");
    const isErr1 = p1.error === true && (p1.reply || "").startsWith("⚠️ Turn failed");

    const prog1 = await tool(mcpPort, "progress_get", { key: key1 }, 5000);
    const progP1 = JSON.parse(prog1.body?.result?.content?.[0]?.text || "{}");
    const hasLastError1 = !!progP1.lastError;

    const r2 = await tool(mcpPort, "message_send", { key: key1, text: "ordinary message" }, 10000);
    const p2 = JSON.parse(r2.body?.result?.content?.[0]?.text || "{}");
    const isOk2 = !p2.error && (p2.reply || "").includes("ordinary message");

    const prog2 = await tool(mcpPort, "progress_get", { key: key1 }, 5000);
    const progP2 = JSON.parse(prog2.body?.result?.content?.[0]?.text || "{}");
    const clearedLastError = progP2.lastError == null;

    const rep = await tool(mcpPort, "replies_get", { key: key1 }, 5000);
    const repP = JSON.parse(rep.body?.result?.content?.[0]?.text || "{}");
    const repliesOk = repP.replies?.length === 2 && repP.replies[0].error === true && !repP.replies[1].error;

    const passE1 = isErr1 && hasLastError1 && isOk2 && clearedLastError && repliesOk;
    report("E1", passE1, `isErr1=${isErr1} hasLastError1=${hasLastError1} isOk2=${isOk2} clearedLastError=${clearedLastError} repliesOk=${repliesOk}`);
  }

  // --- E2 ---
  {
    const s2 = await tool(mcpPort, "session_create", { name: "e2-topic", chat_id: CHAT });
    const key2 = JSON.parse(s2.body.result.content[0].text).key;

    const pM1 = tool(mcpPort, "message_send", { key: key2, text: "AGY-SLOW 1" }, 20000);
    await sleep(500); // 1 is running
    const pM2 = tool(mcpPort, "message_send", { key: key2, text: "prompt 2" }, 20000);
    await sleep(100); // within inputMergeMs (800ms)
    const pM3 = tool(mcpPort, "message_send", { key: key2, text: "prompt 3" }, 20000);

    const [resM1, resM2, resM3] = await Promise.all([pM1, pM2, pM3]);
    const textM1 = JSON.parse(resM1.body?.result?.content?.[0]?.text || "{}").reply || "";
    const textM2 = JSON.parse(resM2.body?.result?.content?.[0]?.text || "{}").reply || "";
    const textM3 = JSON.parse(resM3.body?.result?.content?.[0]?.text || "{}").reply || "";

    const passE2 = !resM1.timeout && !resM2.timeout && !resM3.timeout &&
      textM1.includes("done slowly") && textM2.includes("prompt 2") && textM3.includes("prompt 3");
    report("E2", passE2, `t1=${textM1.slice(0, 20)} t2=${textM2.slice(0, 20)} t3=${textM3.slice(0, 20)}`);
  }

  // --- E3 ---
  {
    const s3 = await tool(mcpPort, "session_create", { name: "e3-topic", chat_id: CHAT });
    const c3 = JSON.parse(s3.body.result.content[0].text);
    const key3 = c3.key;
    const tid3 = c3.thread_id;

    const pSlow3 = tool(mcpPort, "message_send", { key: key3, text: "AGY-SLOW 3" }, 20000);
    await sleep(500);
    const pQueued3 = tool(mcpPort, "message_send", { key: key3, text: "prompt to drop" }, 5000);
    await sleep(200);

    // Send Telegram /clearqueue
    pushTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        message_id: nextMsgId++,
        chat: { id: CHAT, type: "supergroup" },
        message_thread_id: tid3,
        from: { id: USER },
        text: "/clearqueue",
      },
    });

    const qRes = await pQueued3;
    const bodyText = qRes.body?.result?.content?.[0]?.text || qRes.body?.error?.message || "";
    const passE3 = !qRes.timeout && (qRes.body?.result?.isError === true || /clearqueue/i.test(bodyText));
    report("E3", passE3, `timeout=${!!qRes.timeout} response=${bodyText}`);
    await pSlow3.catch(() => {});
  }

  // --- E4 ---
  {
    const s4 = await tool(mcpPort, "session_create", { name: "e4-topic", chat_id: CHAT });
    const c4 = JSON.parse(s4.body.result.content[0].text);
    const key4 = c4.key;
    const tid4 = c4.thread_id;

    const pSlow4 = tool(mcpPort, "message_send", { key: key4, text: "AGY-SLOW 4" }, 5000);
    await sleep(500);

    // Send Telegram /stop
    pushTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        message_id: nextMsgId++,
        chat: { id: CHAT, type: "supergroup" },
        message_thread_id: tid4,
        from: { id: USER },
        text: "/stop",
      },
    });

    const stopRes = await pSlow4;
    const bodyText = stopRes.body?.result?.content?.[0]?.text || stopRes.body?.error?.message || "";
    const passE4 = !stopRes.timeout && (stopRes.body?.result?.isError === true || /stop/i.test(bodyText));
    report("E4", passE4, `timeout=${!!stopRes.timeout} response=${bodyText}`);
  }

  // --- E5 (F1) ---
  console.log("NOTE E5 (not tested here): F1 is covered only by gateway waiterId unit tests; documented in HANDOVER (startTurn resumed fallback is zcode adapter-specific)");

} finally {
  bridge.kill("SIGKILL");
  srv.close();
  rmSync(TMP, { recursive: true, force: true });
}

process.exit(failures > 0 ? 1 : 0);
