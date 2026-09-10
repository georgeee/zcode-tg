// Unit coverage for the namespace-safe store lock (2026-09-10 handout,
// crash-loop bug): identity via boot id + /proc start time, legacy bare-pid
// locks, and the reclaim decision. All pure functions; no real locking here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lockIdentity, readBootId, readProcStartTime, parseLockFile, lockIsHeld } from '../bridge/store.js';

test('lockIdentity carries pid + bootId + startTime of a live process', () => {
  const id = lockIdentity();
  assert.equal(id.pid, process.pid);
  assert.ok(id.bootId && id.bootId.length >= 32, 'boot_id is a uuid');
  assert.ok(String(id.startTime).match(/^\d+$/), 'startTime is numeric ticks');
  assert.equal(readProcStartTime(process.pid), String(id.startTime));
});

test('readBootId/readProcStartTime agree with /proc directly', () => {
  assert.ok(readBootId().length >= 32);
  assert.notEqual(readProcStartTime(1), '');
  assert.equal(readProcStartTime(999999999), ''); // no such process
});

test('parseLockFile: new JSON, legacy bare pid, garbage', () => {
  const ident = lockIdentity();
  const parsed = parseLockFile(JSON.stringify(ident));
  assert.equal(parsed.pid, ident.pid);
  assert.equal(parsed.bootId, ident.bootId);

  assert.deepEqual(parseLockFile('12345\n'), { pid: 12345 }); // legacy format
  // Number('') is 0, not NaN -- garbage and empty both fall to the invalid
  // bucket via pid<=0 handling downstream, but pin the actual shapes:
  assert.ok(Number.isNaN(parseLockFile('not a pid').pid));
  assert.deepEqual(parseLockFile(''), { pid: 0 });
});

test('lockIsHeld: own identity is held; a different boot is stale', () => {
  assert.ok(lockIsHeld(lockIdentity()), 'our own lock is held');

  const otherBoot = { ...lockIdentity(), bootId: '00000000-0000-0000-0000-000000000000' };
  assert.ok(!lockIsHeld(otherBoot), 'different boot id = different container/boot = stale');
});

test('lockIsHeld: same pid different startTime (recycled across namespaces) is stale', () => {
  const recycled = { ...lockIdentity(), startTime: Number(lockIdentity().startTime) + 12345 };
  assert.ok(!lockIsHeld(recycled), 'pid exists in this namespace but is a DIFFERENT process -- reclaim');
});

test('lockIsHeld: legacy bare-pid lock of a live pid stays conservative', () => {
  assert.ok(lockIsHeld({ pid: process.pid }), 'no identity info -- cannot prove staleness, keep old behaviour');
  assert.ok(!lockIsHeld({ pid: 999999999 }), 'dead pid is stale regardless of format');
  assert.ok(!lockIsHeld({ pid: NaN }), 'garbage is stale');
});
