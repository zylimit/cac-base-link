// .cac/hooks/lib/root.mjs — Self-contained project root, Git boundary, stdin I/O, and link self-healer.
// Zero npm dependencies; completely independent of `scripts/lib/*` so downstream `.cac/` runs standalone.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isatty } from 'node:tty';

const STDIN_WAIT_MAX_MS = 3000;
const STDIN_RETRY_MS = 5;

export function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

export function readTextFile(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), absent: false, error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { text: null, absent: true, error: null };
    return { text: null, absent: false, error: e };
  }
}

/**
 * Synchronously drain fd 0 to EOF, retrying with `Atomics.wait` on `EAGAIN`/`EWOULDBLOCK`
 * so large hook event JSON payloads are never truncated mid-pipe.
 */
export function readStdinRaw() {
  if (isatty(0)) return '';
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let waited = 0;
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const again = e && (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK');
      if (again && waited < STDIN_WAIT_MAX_MS) {
        Atomics.wait(sleeper, 0, 0, STDIN_RETRY_MS);
        waited += STDIN_RETRY_MS;
        continue;
      }
      break;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse raw stdin string into an event object: empty -> `{}`, invalid/non-object -> `null`.
 */
export function parseEventJson(raw) {
  if (!String(raw ?? '').trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function readStdinJson() {
  return parseEventJson(readStdinRaw());
}

/**
 * Extract subagent identifier from hook event; returns empty string for main Agent calls.
 */
export function subagentIdOf(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (ev.agent_id) return String(ev.agent_id);
  const tp = toPosix(String(ev.agent_transcript_path || ev.transcript_path || ''));
  const m = /(?:^|\/)subagents\/([^/]+?)(?:\.jsonl)?$/.exec(tp);
  if (m) return m[1];
  if (ev.parent_tool_call_id) return String(ev.parent_tool_call_id);
  return '';
}

export function runCmd(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    ...opts,
  });
  return {
    status: r.status === null || r.status === undefined ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
  };
}

export function git(args, opts = {}) {
  return runCmd('git', args, opts);
}

function resolveRealPathBestEffort(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      try {
        const realFallback = fs.realpathSync(cur);
        return tail.length ? path.join(realFallback, ...tail) : realFallback;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return abs;
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
}

function normDirKey(p) {
  if (!p) return '';
  const real = resolveRealPathBestEffort(p);
  const posix = toPosix(real).replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

export function sameDir(a, b) {
  if (!a || !b) return false;
  return normDirKey(a) === normDirKey(b);
}

/**
 * Dual lexical + `realpath` upward search for the nearest project root containing `.cac` or `.claude`,
 * explicitly excluding `os.homedir()` (`~/.cac` / `~/.claude`) and `os.tmpdir()`.
 */
export function findProjectRoot(startDir, stopAt = null) {
  if (!startDir) return null;
  const resolvedStart = path.resolve(String(startDir));
  const stopKey = stopAt ? normDirKey(stopAt) : '';
  const homeKey = normDirKey(os.homedir());
  const tmpKey = normDirKey(os.tmpdir());

  const hasScaffoldDir = (dir) => {
    try {
      return (
        (fs.existsSync(path.join(dir, '.cac')) && fs.statSync(path.join(dir, '.cac')).isDirectory()) ||
        (fs.existsSync(path.join(dir, '.claude')) && fs.statSync(path.join(dir, '.claude')).isDirectory())
      );
    } catch {
      return false;
    }
  };

  const walkUp = (fromAbs, preserveRawStart) => {
    let cur = fromAbs;
    for (;;) {
      const curKey = normDirKey(cur);
      if (curKey === homeKey || curKey === tmpKey) break;
      if (hasScaffoldDir(cur)) {
        return preserveRawStart && cur === fromAbs && hasScaffoldDir(String(startDir))
          ? String(startDir)
          : cur;
      }
      if (stopKey && curKey === stopKey) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  };

  const direct = walkUp(resolvedStart, true);
  if (direct) return direct;

  const realStart = resolveRealPathBestEffort(resolvedStart);
  const lexA = toPosix(resolvedStart).replace(/\/+$/, '') || '/';
  const lexB = toPosix(realStart).replace(/\/+$/, '') || '/';
  const sameSpelling = process.platform === 'win32'
    ? lexA.toLowerCase() === lexB.toLowerCase()
    : lexA === lexB;
  if (!sameSpelling) {
    return walkUp(realStart, false);
  }
  return null;
}

/**
 * Resolve project root directory without escaping upward past `.cac/` or `.claude/` into an unowned outer `.git`.
 */
export function projectDir(ev = null) {
  const envDir = process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
  if (ev && typeof ev === 'object' && typeof ev.cwd === 'string' && ev.cwd.trim()) {
    const rawCwd = ev.cwd.trim();
    return findProjectRoot(rawCwd) || rawCwd;
  }
  const cwd = process.cwd();
  const directRoot = findProjectRoot(cwd, cwd);
  if (directRoot) return directRoot;
  const top = git(['-c', 'core.quotePath=false', 'rev-parse', '--show-toplevel'], { cwd });
  const topDir = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : null;
  const foundRoot = findProjectRoot(cwd, topDir);
  if (foundRoot) return foundRoot;
  if (topDir) return topDir;
  return cwd;
}

/**
 * Inspect Git repository boundary state for `root`:
 * - `ownRepo`: `topLevel` matches `root`, or `<root>/.git` exists
 * - `trackedSubdir`: `!ownRepo` and `git ls-files --error-unmatch .` succeeds (intentional monorepo package)
 * - `inheritedParentGit`: `inGit && !ownRepo && !trackedSubdir` (unowned outer parent `.git`)
 */
export function gitStateOf(root) {
  const target = root ? String(root) : process.cwd();
  const rev = git(['-c', 'core.quotePath=false', 'rev-parse', '--show-toplevel', '--show-prefix'], { cwd: target });
  if (rev.status !== 0) {
    return {
      inGit: false,
      ownRepo: false,
      topLevel: null,
      prefix: '',
      inheritedParentGit: false,
      trackedSubdir: false,
      status: rev.status,
      error: rev.error,
      stderr: rev.stderr,
    };
  }
  const lines = String(rev.stdout || '').replace(/\r/g, '').split('\n');
  const topLevel = (lines[0] || '').trim() || null;
  const prefix = toPosix(lines[1] || '');
  if (!topLevel) {
    return {
      inGit: false,
      ownRepo: false,
      topLevel: null,
      prefix: '',
      inheritedParentGit: false,
      trackedSubdir: false,
      status: rev.status,
      error: rev.error,
      stderr: rev.stderr,
    };
  }
  const ownRepo = sameDir(topLevel, target) || fs.existsSync(path.join(target, '.git'));
  const trackedSubdir = !ownRepo
    ? git(['ls-files', '--error-unmatch', '.'], { cwd: target }).status === 0
    : false;
  const hasScaffold = fs.existsSync(path.join(target, '.cac')) || fs.existsSync(path.join(target, '.claude'));
  const inheritedParentGit = Boolean(!ownRepo && !trackedSubdir && hasScaffold);
  return {
    inGit: true,
    ownRepo,
    topLevel,
    prefix: ownRepo ? '' : prefix,
    inheritedParentGit,
    trackedSubdir,
    status: 0,
    error: null,
    stderr: '',
  };
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return null;
  }
}

function resolveRealPathOrNull(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  }
}

function normRealKey(realPath) {
  if (!realPath) return '';
  const posix = toPosix(realPath).replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

function detachLinkOnly(absLink) {
  let lst;
  try {
    lst = fs.lstatSync(absLink);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw e;
  }
  if (!lst.isSymbolicLink()) {
    throw new Error(`拒绝拆除物理非链接路径：${absLink}`);
  }
  if (process.platform === 'win32') {
    try {
      fs.rmdirSync(absLink);
      return;
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      try {
        fs.unlinkSync(absLink);
        return;
      } catch (e2) {
        if (e2 && e2.code === 'ENOENT') return;
        throw e2;
      }
    }
  } else {
    try {
      fs.unlinkSync(absLink);
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      throw e;
    }
  }
}

function createOsLink(absLink, absTarget) {
  fs.mkdirSync(path.dirname(absLink), { recursive: true });
  if (process.platform === 'win32') {
    fs.symlinkSync(absTarget, absLink, 'junction');
  } else {
    fs.symlinkSync(path.relative(path.dirname(absLink), absTarget), absLink, 'dir');
  }
}

function ensureOneCcLink(root, name, stamp) {
  const absLink = path.join(root, '.cac', name);
  const absTarget = path.join(root, '.claude', name);

  if (lstatOrNull(path.dirname(absLink))?.isSymbolicLink()) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'parent-is-symlink',
      linkPath: absLink,
      targetPath: absTarget,
    };
  }

  try {
    if (!fs.existsSync(absTarget) || !fs.statSync(absTarget).isDirectory()) {
      return 'missing-target';
    }
  } catch {
    return 'missing-target';
  }

  let lst = null;
  try {
    lst = fs.lstatSync(absLink);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return 'error';
  }

  if (!lst) {
    try {
      createOsLink(absLink, absTarget);
      return 'created';
    } catch {
      return 'error';
    }
  }

  if (lst.isSymbolicLink()) {
    try {
      const st = fs.statSync(absLink);
      if (st.isDirectory() && sameDir(absLink, absTarget)) {
        return 'unchanged';
      }
    } catch {
      // Broken link -> repair below
    }
    try {
      detachLinkOnly(absLink);
      createOsLink(absLink, absTarget);
      return 'repaired';
    } catch {
      return 'error';
    }
  }

  // Guard before migrating physical non-link directory: never vacate if parent is symlink or same realpath as target!
  if (lstatOrNull(path.dirname(absLink))?.isSymbolicLink()) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'parent-is-symlink',
      linkPath: absLink,
      targetPath: absTarget,
    };
  }
  const realLink = resolveRealPathOrNull(absLink);
  const realTarget = resolveRealPathOrNull(absTarget);
  if (realLink && realTarget && normRealKey(realLink) === normRealKey(realTarget)) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'same-realpath-as-target',
      linkPath: absLink,
      targetPath: absTarget,
    };
  }

  // Physical non-link directory (e.g. leftover standalone cac-base) -> archive into .cac/.runtime/migrated-standalone-*
  try {
    let backupDest = path.join(root, '.cac', '.runtime', `migrated-standalone-${stamp}`, name);
    let seq = 1;
    while (fs.existsSync(backupDest)) {
      backupDest = path.join(root, '.cac', '.runtime', `migrated-standalone-${stamp}-${seq}`, name);
      seq++;
    }
    fs.mkdirSync(path.dirname(backupDest), { recursive: true });
    fs.renameSync(absLink, backupDest);
    createOsLink(absLink, absTarget);
    return 'migrated';
  } catch {
    return 'error';
  }
}

/**
 * Millisecond-fast self-healing of `.cac/skills -> .claude/skills` and `.cac/agents -> .claude/agents`.
 * Safe no-op when `.claude/{skills,agents}` is absent (e.g. inside `cac-base-link` source repo).
 */
export function ensureCcLinks(root) {
  if (!root) return { skills: 'skipped', agents: 'skipped' };
  const absRoot = path.resolve(String(root));
  if (!lstatOrNull(path.join(absRoot, '.cac'))) {
    return { skills: 'skipped', agents: 'skipped' };
  }
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return {
    skills: ensureOneCcLink(absRoot, 'skills', stamp),
    agents: ensureOneCcLink(absRoot, 'agents', stamp),
  };
}
