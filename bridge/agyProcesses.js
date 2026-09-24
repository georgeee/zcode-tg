// /proc introspection for the agy process GC (C4/C6): the boot-time orphan
// sweep and the per-pid RSS reader. Everything here reads only same-uid
// process data under /proc and is written to TOLERATE entries it cannot
// read (hidepid mounts, ProtectProc=invisible, a pid that exited between
// two reads): the sweep only needs the processes it can see, so an
// unreadable entry is skipped, never fatal.
//
// WHY A MARKER: agy children can outlive the bridge -- a SIGKILLed bridge
// (or a crash) leaves them orphaned, still holding their 93-181 MB and
// their credential HOME. There is no pidfile and no supervisor for them
// (the bridge is not their parent any more), so every child carries
// CAGE_AGY_BRIDGE=<bridge marker> in its environment at spawn, and the
// sweep at bridge start kills same-uid processes carrying OUR marker whose
// parent is not this bridge. The marker value is a hash of the bridge's
// state dir path (see index.js), so two bridges sharing a host never sweep
// each other's children.

import { readFileSync, readdirSync } from 'node:fs';

const MARKER_ENV = 'CAGE_AGY_BRIDGE';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Total resident memory of one pid, from VmRSS in /proc/<pid>/status
// (kB -> bytes). null when anything is unreadable or absent (a kernel
// thread, a just-exited pid, hidepid) -- callers add null-safely.
export function readProcRssBytes(pid, procRoot = '/proc') {
  if (!pid) return null;
  try {
    const m = readFileSync(`${procRoot}/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

// Real uid from /proc/<pid>/status's Uid line (first field = real uid).
function procUid(statusText) {
  const m = statusText.match(/^Uid:\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

// Parent pid from /proc/<pid>/stat: the comm field can contain spaces and
// ')' itself, so parse AFTER the last ')' -- the fields are then state
// (3rd), ppid (4th).
function procPpid(statText) {
  const after = statText.slice(statText.lastIndexOf(')') + 1).trim();
  const ppid = Number(after.split(' ')[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

// The marker must match a WHOLE environ entry -- CAGE_AGY_BRIDGE=abc must
// not be satisfied by CAGE_AGY_BRIDGE=abcdef.
function carriesMarker(pid, marker, procRoot) {
  const environ = readFileSync(`${procRoot}/${pid}/environ`);
  return environ.toString('utf8').split('\0').includes(`${MARKER_ENV}=${marker}`);
}

// Kill every same-uid process carrying our marker whose parent is not
// `ourPid`: SIGTERM first, then SIGKILL for anything that survives
// termGraceMs. Resolves with the pids it signalled. Errors reading any
// single /proc entry are that entry's problem, not the sweep's.
export async function reapOrphanAgyChildren({ marker, ourPid = process.pid, uid = typeof process.getuid === 'function' ? process.getuid() : null, termGraceMs = 3_000, log = () => {}, procRoot = '/proc' } = {}) {
  if (!marker) return [];
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch (e) {
    log(`orphan sweep: ${procRoot} unreadable (${e.message}); skipping`);
    return [];
  }
  const orphans = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === ourPid) continue;
    let statText;
    let statusText;
    try {
      statText = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
      statusText = readFileSync(`${procRoot}/${pid}/status`, 'utf8');
    } catch {
      continue;
    }
    if (uid != null && procUid(statusText) !== uid) continue;
    const ppid = procPpid(statText);
    if (ppid == null || ppid === ourPid) continue; // our own live child
    try {
      if (!carriesMarker(pid, marker, procRoot)) continue;
    } catch {
      continue; // environ is owner-only; unreadable to us != ours to kill
    }
    orphans.push({ pid, ppid });
  }
  for (const { pid, ppid } of orphans) {
    // The pid could in principle have exited (or, after long delays, been
    // recycled) since the listing -- re-check the marker in the same breath
    // as the signal to narrow that window; a stale read throws and skips.
    try {
      if (!carriesMarker(pid, marker, procRoot)) continue;
      process.kill(pid, 'SIGTERM');
      log(`orphan sweep: SIGTERM to orphaned agy child pid=${pid} (ppid=${ppid})`);
    } catch (e) {
      log(`orphan sweep: pid=${pid} vanished before TERM (${e.message})`);
    }
  }
  if (orphans.length) {
    await sleep(termGraceMs);
    for (const { pid, ppid } of orphans) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) continue;
      try {
        process.kill(pid, 'SIGKILL');
        log(`orphan sweep: SIGKILL to pid=${pid} (ppid=${ppid}) -- survived SIGTERM`);
      } catch (e) {
        log(`orphan sweep: pid=${pid} unkillable (${e.message})`);
      }
    }
  }
  return orphans.map((o) => o.pid);
}
