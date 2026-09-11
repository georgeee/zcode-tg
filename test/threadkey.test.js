// bridge/index.js carries two different values under one name, and every bug
// this file guards came from confusing them:
//
//   a CONVERSATION KEY   "c-1004443979813:t12" (or "12" when the chat is the
//                        configured one) -- what keyFor() makes, what the store
//                        and sessionToTopic are keyed by, what chatOf()/
//                        threadOf() parse
//   a THREAD ID          12 -- an integer, the only thing Telegram accepts as
//                        message_thread_id
//
// sessionToTopic stores the KEY in a field called `threadId`, so `topic.threadId`
// reads exactly like a thread id and is not one. Handed to Telegram it cannot be
// parsed as an integer, is dropped, and the message lands in the group's General
// topic -- silently, with no API error. Measured on a live fleet: subagent
// progress and milestone posts in #General while ordinary replies landed right.
//
// index.js calls main() at import and exports nothing, so none of this is
// reachable by an ordinary unit test. These read the source instead. That is
// weaker than executing it and still stronger than what was there before, which
// was nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'index.js');
const lines = fs.readFileSync(SRC, 'utf8').split('\n');

// Reads of the BARE identifier, as opposed to `topic.threadId` or `threadId:`.
const BARE_READ = /chatOf\(threadId\)|threadOf\(threadId\)|messageThreadId:\s*threadId\b/;

// Scopes that bind `threadId`: a parameter list containing it, or a declaration.
const opensScope = /(?:function\s*[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|\b[\w$]+\s*=>)/;
const declares = /(?:const|let|var)\s+(?:\{[^}]*\bthreadId\b[^}]*\}|threadId)\b|for\s*\(\s*(?:const|let)\s*\[\s*threadId\b/;

function unboundReads(source) {
  const stack = [{ binds: false, depth: 0 }];
  let depth = 0;
  const found = [];
  source.forEach((line, i) => {
    // Comments describe these patterns (this bug is worth explaining at its
    // sites), so scanning them would make the guard un-writable.
    const code = line.replace(/\/\/.*$/, '');
    const m = code.match(opensScope);
    if (m) {
      const params = (m[1] ?? m[2] ?? '') || '';
      stack.push({ binds: /\bthreadId\b/.test(params), depth });
    }
    if (declares.test(code)) stack[stack.length - 1].binds = true;
    if (BARE_READ.test(code) && !stack.some((s) => s.binds)) {
      found.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
    }
    depth += (code.match(/{/g) || []).length - (code.match(/}/g) || []).length;
    while (stack.length > 1 && depth <= stack[stack.length - 1].depth) stack.pop();
  });
  return found;
}

// A bare `threadId` read inside a scope that never bound one is a ReferenceError
// in an ES module, not an undefined -- the function throws the first time that
// branch runs. Four shipped that way, all on the background-task/subagent paths
// (adoptUnclaimedTurn, handleBackgroundTaskFinished, finalizeTurn, shutdown) plus
// the two interaction callbacks, which is why they went unnoticed for so long:
// none of them is on the ordinary reply path anyone exercises by hand.
test('no function reads a `threadId` it never bound', () => {
  assert.deepEqual(unboundReads(lines), []);
});

// The scanner has to actually catch that shape, or the test above is decoration.
test('the scan detects an unbound read when one is introduced', () => {
  const broken = ['async function f(sessionId) {', '  const topic = m.get(sessionId);', '  send({ chatId: chatOf(threadId) });', '}'];
  assert.equal(unboundReads(broken).length, 1);
  const fixed = ['async function f(sessionId) {', '  const topic = m.get(sessionId);', '  send({ chatId: chatOf(topic.threadId) });', '}'];
  assert.deepEqual(unboundReads(fixed), []);
});

// `topic` in this file always comes from sessionToTopic, so `topic.threadId` is
// always a KEY. Telegram wants the integer, so it has to go through threadOf().
test('message_thread_id is never handed a conversation key', () => {
  const offenders = lines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /messageThreadId:\s*(?:topic|t)\.threadId\b/.test(l))
    .map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`);
  assert.deepEqual(offenders, [], 'pass threadOf(topic.threadId), not the key itself');
});

// attachTurnView is where the reported bug actually lived: it takes a key, uses
// it correctly for chatOf(), and used to pass the same value on to the progress
// and streamer views, which send it as message_thread_id.
test('attachTurnView converts the key before handing it to a view', () => {
  const line = lines.find((l) => l.includes('const common = { tg, chatId: chatOf(threadId)'));
  assert.ok(line, 'attachTurnView common-options line not found -- update this test');
  assert.match(line, /threadId:\s*threadOf\(threadId\)/);
});
