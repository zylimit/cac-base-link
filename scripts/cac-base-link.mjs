#!/usr/bin/env node
// scripts/cac-base-link.mjs — Single cross-platform CLI & transactional installer kernel for cac-base-link.
// Subcommands: install (default) | upgrade | uninstall | doctor | manifest | pack-check | release | help
// Zero npm dependencies (Node >= 20 built-ins only).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPosix, validateTargetPath } from './lib/path-guard.mjs';
import {
  ensureBridgeLinks,
  inspectDirLink,
  removeBridgeLinks,
} from './lib/link-manager.mjs';
import {
  ENGINE_NAME,
  MANIFEST_REL_PATH,
  NEVER_INSTALL_ROOT,
  OPTIONAL_MANIFEST_REL_PATH,
  buildCoreManifest,
  checkManifest,
  hashLfBuffer,
  hashLfFile,
  leakScanManifest,
  scanTextForLeaks,
  walkRegularFiles,
  writeManifest,
} from './lib/manifest.mjs';
import {
  formatSettingsJson,
  mergeSettings,
  stripFrameworkHooks,
  stripFrameworkPermissions,
} from './lib/settings-merge.mjs';
import {
  BUNDLED_CC_DIRNAME,
  checkTargetCcContract,
  ensureUpstreamCcBase,
  resolveCcBaseSource,
  stageBundledCcBase,
} from './lib/cc-dep.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(SCRIPT_DIR, '..');
const LOCK_STALE_TIMEOUT_MS = 10 * 60 * 1000;

const KNOWN_COMMANDS = new Set([
  'install',
  'upgrade',
  'uninstall',
  'doctor',
  'manifest',
  'pack-check',
  'release',
  'help',
]);

const COMMON_TYPO_SUBCOMMANDS = new Map([
  ['package', 'did you mean "release <version>" or "pack-check"?'],
  ['pack', 'did you mean "release <version>" or "pack-check"?'],
  ['bundle', 'did you mean "release <version>"?'],
  ['check', 'did you mean "pack-check" or "manifest --check"?'],
  ['verify', 'did you mean "pack-check" or "doctor"?'],
  ['test', 'did you mean "pack-check"?'],
  ['tests', 'did you mean "pack-check"?'],
  ['lint', 'did you mean "pack-check"?'],
  ['audit', 'did you mean "pack-check"?'],
  ['status', 'did you mean "doctor"?'],
  ['init', 'did you mean "install"?'],
  ['update', 'did you mean "upgrade"?'],
  ['remove', 'did you mean "uninstall"?'],
  ['clean', 'did you mean "uninstall"?'],
  ['version', 'did you mean "--help"?'],
]);

const KNOWN_BOOLEAN_FLAGS = new Set([
  'dry-run',
  'force',
  'uninstall',
  'source-check',
  'with-cc',
  'no-auto-cc',
  'write',
  'check',
  'leak',
  'print',
  'json',
  'strict-syntax',
  'help',
]);

const KNOWN_VALUE_FLAGS = new Set([
  'target',
  'hook-form',
  'cc-base',
  'bundle-cc',
  'out',
]);

function usageText() {
  return [
    'cac-base-link CLI (Node >= 20, zero npm deps)',
    '',
    '用法:',
    '  node scripts/cac-base-link.mjs [install|upgrade] [--target <dir> | <dir>] [--dry-run] [--force] [--with-cc] [--no-auto-cc] [--cc-base <dir>] [--hook-form string|exec] [--json]',
    '  node scripts/cac-base-link.mjs uninstall [--target <dir> | <dir>] [--force] [--dry-run] [--json]',
    '  node scripts/cac-base-link.mjs doctor [--target <dir> | <dir>] [--source-check] [--json]',
    '  node scripts/cac-base-link.mjs manifest (--write | --check | --leak | --print)',
    '  node scripts/cac-base-link.mjs pack-check [--strict-syntax]',
    '  node scripts/cac-base-link.mjs release <version> [--out <path>] [--bundle-cc <dir>]',
    '',
    '退出码: 0=clean  1=violation/fail  2=usage/blocked  3=degraded',
  ].join('\n');
}

function usageDie(msg) {
  process.stderr.write(`cac-base-link: ${msg}\n\n${usageText()}\n`);
  process.exit(2);
}

/**
 * Parse CLI argv strictly: unknown `-*` flags and common subcommand typos always fail with exit 2.
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const flags = new Set();
  const kv = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.add('help');
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        if (KNOWN_VALUE_FLAGS.has(key)) {
          if (!val) usageDie(`选项 --${key}= 缺少参数值`);
          kv[key] = val;
        } else if (KNOWN_BOOLEAN_FLAGS.has(key)) {
          if (val === 'true' || val === '1') flags.add(key);
          else if (val !== 'false' && val !== '0') usageDie(`布尔选项 --${key} 不接受值：${val}`);
        } else {
          usageDie(`未知选项：${a}`);
        }
      } else {
        const key = a.slice(2);
        if (KNOWN_BOOLEAN_FLAGS.has(key)) {
          flags.add(key);
        } else if (KNOWN_VALUE_FLAGS.has(key)) {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) {
            usageDie(`选项 --${key} 后面缺少参数值`);
          }
          kv[key] = next;
          i++;
        } else {
          usageDie(`未知选项：${a}`);
        }
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      usageDie(`未知选项：${a}`);
    }
    positional.push(a);
  }

  let cmd = 'install';
  const restPos = [...positional];
  if (restPos.length > 0 && KNOWN_COMMANDS.has(restPos[0])) {
    cmd = restPos.shift();
  } else if (
    restPos.length > 0 &&
    /^[a-z]+$/.test(restPos[0]) &&
    COMMON_TYPO_SUBCOMMANDS.has(restPos[0])
  ) {
    const badCmd = restPos[0];
    const hint = COMMON_TYPO_SUBCOMMANDS.get(badCmd);
    usageDie(
      `unknown subcommand "${badCmd}" (${hint} To install into a folder named "${badCmd}", pass --target ./${badCmd})`,
    );
  }
  if (flags.has('uninstall')) {
    if (cmd !== 'install' && cmd !== 'uninstall') {
      usageDie(`--uninstall 不能与子命令 ${cmd} 同时使用`);
    }
    cmd = 'uninstall';
  }

  if (kv['hook-form'] !== undefined && kv['hook-form'] !== '' && kv['hook-form'] !== 'string' && kv['hook-form'] !== 'exec') {
    usageDie(`--hook-form 只支持 string 或 exec，收到：${kv['hook-form']}`);
  }

  return { cmd, flags, kv, positional: restPos };
}

function resolveTargetArg(kv, positional, cmdName) {
  if (kv.target && positional.length > 0) {
    usageDie(`${cmdName}: 同时传入了 --target (${kv.target}) 与位置参数 (${positional[0]})，请只保留一个`);
  }
  if (positional.length > 1) {
    usageDie(`${cmdName}: 多余的位置参数：${positional.slice(1).join(' ')}`);
  }
  return kv.target || positional[0] || '.';
}

// ---------------------------------------------------------------------------
// Transactional Installer / Upgrader / Standalone Migrator / Uninstaller
// ---------------------------------------------------------------------------

/**
 * Check if a process PID is currently alive (`ESRCH` -> dead; `EPERM` -> alive under another user).
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

function safeLstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Safely detach ONLY a symbolic link or Windows NTFS Junction without EVER recursing into or modifying its target.
 * @param {string} p
 * @returns {boolean}
 */
function unlinkSymlinkOrJunctionSafe(p) {
  const lst = safeLstat(p);
  if (!lst) return false;
  if (!lst.isSymbolicLink()) {
    throw new Error(`拒绝以拆链方式删除非符号链接路径：${p}`);
  }
  if (process.platform === 'win32') {
    try {
      fs.rmdirSync(p);
      return true;
    } catch {
      try {
        fs.unlinkSync(p);
        return true;
      } catch (e2) {
        if (e2 && e2.code === 'ENOENT') return false;
        throw e2;
      }
    }
  } else {
    try {
      fs.unlinkSync(p);
      return true;
    } catch (e) {
      if (e && e.code === 'ENOENT') return false;
      throw e;
    }
  }
}

function inspectExistingLock(lockPath) {
  const lst = safeLstat(lockPath);
  if (!lst) {
    return { pid: null, ts: null, mtimeMs: 0, isSymlink: false };
  }
  const mtimeMs = Number(lst.mtimeMs || 0);
  if (lst.isSymbolicLink()) {
    return { pid: null, ts: mtimeMs, mtimeMs, isSymlink: true };
  }
  if (lst.isDirectory()) {
    for (const cand of ['owner.json', 'lock.json', 'pid']) {
      const p = path.join(lockPath, cand);
      const clst = safeLstat(p);
      if (!clst || clst.isSymbolicLink() || !clst.isFile()) continue;
      try {
        const rawText = fs.readFileSync(p, 'utf8').trim();
        if (/^\d+$/.test(rawText)) return { pid: Number(rawText), ts: mtimeMs, mtimeMs, isSymlink: false };
        const parsed = JSON.parse(rawText);
        return { pid: parsed?.pid ?? null, ts: Number(parsed?.ts || mtimeMs), mtimeMs, isSymlink: false };
      } catch {
        // continue
      }
    }
    return { pid: null, ts: mtimeMs, mtimeMs, isSymlink: false };
  }
  try {
    const rawText = fs.readFileSync(lockPath, 'utf8').trim();
    if (/^\d+$/.test(rawText)) return { pid: Number(rawText), ts: mtimeMs, mtimeMs, isSymlink: false };
    const parsed = JSON.parse(rawText);
    const tsVal = Number(parsed?.ts) || (parsed?.startedAt ? Date.parse(parsed.startedAt) : mtimeMs) || mtimeMs;
    return { pid: parsed?.pid ?? null, ts: tsVal, mtimeMs, isSymlink: false };
  } catch {
    return { pid: null, ts: mtimeMs, mtimeMs, isSymlink: false };
  }
}

/**
 * Acquire atomic exclusive lock `<target>/.cac/.runtime/install.lock`.
 * Reclaims orphan locks from dead PIDs or timed-out locks (> 10 minutes), supporting both file and directory lock leftovers.
 * @param {string} runtimeDir
 * @param {string} startedAt
 */
export function acquireInstallLock(runtimeDir, startedAt) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
  } catch (mkErr) {
    return { ok: false, code: 1, error: `无法创建运行态锁目录 ${runtimeDir}: ${mkErr?.message || mkErr}` };
  }
  const lockPath = path.join(runtimeDir, 'install.lock');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, ts: Date.now(), startedAt }) + '\n',
          'utf8',
        );
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, lockPath };
    } catch (e) {
      const canReclaim = Boolean(
        e && (
          e.code === 'EEXIST' ||
          e.code === 'EISDIR' ||
          (e.code === 'EPERM' && safeLstat(lockPath))
        ),
      );
      if (!canReclaim) {
        return { ok: false, code: 1, error: `无法创建安装锁 ${lockPath}: ${e?.message || e}` };
      }
      const info = inspectExistingLock(lockPath);
      const ageMs = info.ts ? Math.max(0, Date.now() - info.ts) : LOCK_STALE_TIMEOUT_MS + 1;
      const timedOut = ageMs >= LOCK_STALE_TIMEOUT_MS;
      const alive = Boolean(info.pid && isPidAlive(info.pid) && !timedOut);
      if (alive) {
        return {
          ok: false,
          code: 2,
          error: `另一个安装进程正在写入目标目录：锁 ${lockPath} 的持有者 pid=${info.pid} 仍在运行`,
        };
      }
      process.stderr.write(
        `setup: 检测到陈旧安装锁 ${lockPath}（pid=${info.pid ?? 'unknown'} 已退出或超时），自动清理接管（第 ${attempt}/3 次）\n`,
      );
      try {
        if (safeLstat(lockPath)?.isSymbolicLink()) {
          unlinkSymlinkOrJunctionSafe(lockPath);
        } else {
          fs.rmSync(lockPath, { recursive: true, force: true });
        }
      } catch (rmErr) {
        return { ok: false, code: 1, error: `无法清除陈旧安装锁 ${lockPath}: ${rmErr?.message || rmErr}` };
      }
    }
  }

  return {
    ok: false,
    code: 2,
    error: `连续 3 次接管安装锁 ${lockPath} 仍被并发抢占，请确认无其他安装进程后再试`,
  };
}

function writeInstallMarker(markerPath, payload) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    // Best-effort during crash path
  }
}

function readManifestMaps(manifestPath) {
  const filesMap = new Map();
  let engine = '';
  let raw = null;
  const lst = safeLstat(manifestPath);
  if (!lst || lst.isSymbolicLink() || !lst.isFile()) return { engine, filesMap, raw };
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    engine = typeof raw?.engine === 'string' ? raw.engine : '';
    if (raw && Array.isArray(raw.files)) {
      for (const f of raw.files) {
        if (f && typeof f.path === 'string' && typeof f.sha256 === 'string') {
          filesMap.set(toPosix(f.path), f);
        }
      }
    }
  } catch {
    // Corrupt manifest falls back to conservative conflict protection
  }
  return { engine, filesMap, raw };
}

function collectFrameworkDirs(coreManifest) {
  const dirSet = new Set([
    '.cac',
    '.cac/.runtime',
    '.cac/hooks',
    '.cac/hooks/lib',
    '.cac/rules',
    '.cac/scripts',
  ]);
  for (const item of coreManifest?.files || []) {
    const rel = toPosix(item?.path || '');
    if (!rel.startsWith('.cac/')) continue;
    const parts = rel.split('/');
    for (let i = 2; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join('/'));
    }
  }
  return [...dirSet].sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function detectUnlinkedFrameworkDirs(targetDir, coreManifest) {
  const orderedDirs = collectFrameworkDirs(coreManifest);
  const unlinked = [];
  for (const relDir of orderedDirs) {
    if (unlinked.some((u) => relDir.startsWith(`${u}/`))) continue;
    if (safeLstat(path.join(targetDir, relDir))?.isSymbolicLink()) {
      unlinked.push(relDir);
    }
  }
  return unlinked;
}

function hasSymlinkAncestor(relPath, unlinkedDirSet) {
  const norm = toPosix(relPath);
  const parts = norm.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (unlinkedDirSet.has(parts.slice(0, i).join('/'))) return true;
  }
  return false;
}

function relocateBlockingPath(p, stamp) {
  let dest = `${p}.bak-${stamp}`;
  let seq = 1;
  while (safeLstat(dest)) {
    dest = `${p}.bak-${stamp}-${seq}`;
    seq++;
  }
  fs.renameSync(p, dest);
  return dest;
}

function clearLeafBeforeWrite(dstFull, stamp) {
  const lst = safeLstat(dstFull);
  if (!lst) return;
  if (lst.isSymbolicLink()) {
    unlinkSymlinkOrJunctionSafe(dstFull);
    return;
  }
  if (!lst.isFile()) {
    relocateBlockingPath(dstFull, stamp);
  }
}

function decideThreeWay(srcSha, dstFullPath, oldSha, force) {
  const lst = safeLstat(dstFullPath);
  if (!lst) return 'create';
  if (lst.isSymbolicLink()) {
    const st = statOrNull(dstFullPath);
    if (!st) return 'create';
    if (!st.isFile()) return force ? 'update' : 'conflict';
    if (force) return 'update';
    if (oldSha) {
      try {
        const dstSha = hashLfFile(dstFullPath).sha256;
        if (dstSha === oldSha) return 'update';
      } catch {
        return 'conflict';
      }
    }
    return 'conflict';
  }
  if (!lst.isFile()) return force ? 'update' : 'conflict';
  let dstSha;
  try {
    dstSha = hashLfFile(dstFullPath).sha256;
  } catch {
    return force ? 'update' : 'conflict';
  }
  if (dstSha === srcSha) return 'skip';
  if (force || (oldSha && dstSha === oldSha)) return 'update';
  return 'conflict';
}

function planSingleLink(targetDir, name, unlinkedDirSet = new Set(), assumeCcPresent = false) {
  const ccTarget = path.join(targetDir, '.claude', name);
  const ccStat = statOrNull(ccTarget);
  const ccExists = Boolean(assumeCcPresent || (ccStat && ccStat.isDirectory()));
  if (unlinkedDirSet.has('.cac')) {
    return ccExists ? 'create' : 'skip';
  }
  const linkPath = path.join(targetDir, '.cac', name);
  const info = inspectDirLink(linkPath, ccStat && ccStat.isDirectory() ? ccTarget : undefined);
  if (!ccExists) {
    if (info.exists && !info.isLink) return 'migrate';
    return 'skip';
  }
  if (!info.exists) return 'create';
  if (info.isLink && info.valid && info.matchesTarget) return 'skip';
  if (info.isLink) return 'update';
  return 'migrate';
}

function pruneEmptyDirsNonSymlink(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) pruneEmptyDirsNonSymlink(path.join(dir, e.name));
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* ignore */
  }
}

/**
 * Compute full installation / upgrade / standalone-migration plan with ZERO filesystem writes.
 * @param {string} srcRoot
 * @param {string} targetDir
 * @param {{ force?: boolean, hookForm?: '' | 'string' | 'exec' }} [opts]
 */
export function planInstall(srcRoot, targetDir, opts = {}) {
  const valid = validateTargetPath(targetDir);
  if (!valid.ok) {
    return { ok: false, code: 2, error: valid.message };
  }
  const srcCac = path.join(srcRoot, '.cac');
  if (!fs.existsSync(srcCac) || !fs.statSync(srcCac).isDirectory()) {
    return { ok: false, code: 2, error: `源框架目录缺失 .cac：${srcCac}` };
  }

  const force = Boolean(opts.force);
  const hookForm = opts.hookForm || '';

  const srcManifestFile = path.join(srcRoot, MANIFEST_REL_PATH);
  let coreManifest = null;
  if (fs.existsSync(srcManifestFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(srcManifestFile, 'utf8'));
      if (parsed && parsed.version === 1 && parsed.engine === ENGINE_NAME && Array.isArray(parsed.files)) {
        coreManifest = parsed;
      }
    } catch {
      coreManifest = null;
    }
  }
  if (!coreManifest) {
    coreManifest = buildCoreManifest(srcRoot);
  }

  const unlinkedDirs = detectUnlinkedFrameworkDirs(targetDir, coreManifest);
  const unlinkedDirSet = new Set(unlinkedDirs);

  const { engine: oldEngine, filesMap: oldCoreMap } = unlinkedDirSet.has('.cac')
    ? { engine: '', filesMap: new Map() }
    : readManifestMaps(path.join(targetDir, MANIFEST_REL_PATH));
  const { filesMap: oldOptMap } = unlinkedDirSet.has('.cac')
    ? { filesMap: new Map() }
    : readManifestMaps(path.join(targetDir, OPTIONAL_MANIFEST_REL_PATH));
  const newCorePaths = new Set(coreManifest.files.map((f) => toPosix(f.path)));

  const ops = [];

  // 1. Managed .cac/* bridge files
  for (const item of coreManifest.files) {
    const rel = toPosix(item.path);
    if (!rel.startsWith('.cac/') || NEVER_INSTALL_ROOT.has(rel)) continue;
    const srcFull = path.join(srcRoot, rel);
    if (!fs.existsSync(srcFull)) continue;
    const dstFull = path.join(targetDir, rel);
    const oldEntry = oldCoreMap.get(rel);
    const action = hasSymlinkAncestor(rel, unlinkedDirSet)
      ? 'create'
      : decideThreeWay(item.sha256, dstFull, oldEntry?.sha256, force);
    ops.push({
      action,
      kind: 'managed',
      relPath: rel,
      srcFull,
      sha256: item.sha256,
      bytes: item.bytes,
    });
  }

  // 2. Obsolete managed files from older cac-base-link or standalone cac-base manifests
  const obsoleteCandidates = new Map([...oldCoreMap, ...oldOptMap]);
  const obsoleteRemovals = [];
  if (!unlinkedDirSet.has('.cac')) {
    for (const [oldRel, oldEntry] of obsoleteCandidates) {
      if (newCorePaths.has(oldRel)) continue;
      if (!oldRel.startsWith('.cac/')) continue;
      if (hasSymlinkAncestor(oldRel, unlinkedDirSet)) continue;
      if (oldRel.startsWith('.cac/skills/') || oldRel.startsWith('.cac/agents/')) continue;
      if (oldRel === '.cac/EVOLUTION.md') continue;
      if (oldRel.startsWith('.cac/feedback/') && !oldRel.startsWith('.cac/feedback/templates/')) continue;
      if (oldRel.startsWith('.cac/local/') || oldRel.startsWith('.cac/.runtime/')) continue;
      const full = path.join(targetDir, oldRel);
      const lst = safeLstat(full);
      if (!lst || lst.isSymbolicLink() || !lst.isFile()) continue;
      const actualSha = hashLfFile(full).sha256;
      if (actualSha === oldEntry.sha256 || force) {
        obsoleteRemovals.push(oldRel);
      }
    }
  }

  // 3. .cac/settings.json lossless merge (with leaf symlink & ancestor symlink non-traversal!)
  const srcSettingsPath = path.join(srcRoot, '.cac', 'settings.json');
  const dstSettingsPath = path.join(targetDir, '.cac', 'settings.json');
  let settingsPlan = null;
  if (fs.existsSync(srcSettingsPath)) {
    const srcSettingsObj = JSON.parse(fs.readFileSync(srcSettingsPath, 'utf8'));
    const dstSetLst = hasSymlinkAncestor('.cac/settings.json', unlinkedDirSet)
      ? null
      : safeLstat(dstSettingsPath);

    if (!dstSetLst) {
      const merged = mergeSettings(null, srcSettingsObj, { hookForm });
      const content = formatSettingsJson(merged.settings);
      settingsPlan = { action: 'create', content, resolvedForm: merged.resolvedForm };
      ops.push({ action: 'create', kind: 'settings', relPath: '.cac/settings.json' });
    } else if (dstSetLst.isSymbolicLink()) {
      const liveSt = statOrNull(dstSettingsPath);
      const fresh = mergeSettings(null, srcSettingsObj, { hookForm });
      const content = formatSettingsJson(fresh.settings);
      if (!liveSt) {
        // Dangling symlink -> 'create' (unlinked safely before write)
        settingsPlan = { action: 'create', content, resolvedForm: fresh.resolvedForm };
        ops.push({ action: 'create', kind: 'settings', relPath: '.cac/settings.json' });
      } else if (force) {
        // Live symlink with --force -> 'update' (unlinked safely before write; never mutates external target!)
        settingsPlan = { action: 'update', content, resolvedForm: fresh.resolvedForm };
        ops.push({ action: 'update', kind: 'settings', relPath: '.cac/settings.json' });
      } else {
        settingsPlan = { action: 'conflict', content, resolvedForm: fresh.resolvedForm };
        ops.push({ action: 'conflict', kind: 'settings', relPath: '.cac/settings.json' });
      }
    } else if (!dstSetLst.isFile()) {
      const fresh = mergeSettings(null, srcSettingsObj, { hookForm });
      const content = formatSettingsJson(fresh.settings);
      const action = force ? 'update' : 'conflict';
      settingsPlan = { action, content, resolvedForm: fresh.resolvedForm };
      ops.push({ action, kind: 'settings', relPath: '.cac/settings.json' });
    } else {
      let dstSettingsObj = null;
      let parseFailed = false;
      try {
        dstSettingsObj = JSON.parse(fs.readFileSync(dstSettingsPath, 'utf8'));
      } catch {
        parseFailed = true;
      }
      if (parseFailed && !force) {
        const fresh = mergeSettings(null, srcSettingsObj, { hookForm });
        settingsPlan = {
          action: 'conflict',
          content: formatSettingsJson(fresh.settings),
          resolvedForm: fresh.resolvedForm,
        };
        ops.push({ action: 'conflict', kind: 'settings', relPath: '.cac/settings.json' });
      } else {
        const merged = mergeSettings(parseFailed ? null : dstSettingsObj, srcSettingsObj, { hookForm });
        const content = formatSettingsJson(merged.settings);
        const same = !parseFailed && hashLfBuffer(content).sha256 === hashLfFile(dstSettingsPath).sha256;
        const action = same ? 'skip' : 'update';
        settingsPlan = { action, content, resolvedForm: merged.resolvedForm };
        ops.push({ action, kind: 'settings', relPath: '.cac/settings.json' });
      }
    }
  }

  // 4. .cac/FRAMEWORK-MANIFEST.json
  const manifestText = fs.existsSync(srcManifestFile)
    ? fs.readFileSync(srcManifestFile, 'utf8')
    : JSON.stringify(coreManifest, null, 2) + '\n';
  const dstManifestPath = path.join(targetDir, MANIFEST_REL_PATH);
  let manifestAction = 'create';
  const dstManLst = hasSymlinkAncestor(MANIFEST_REL_PATH, unlinkedDirSet)
    ? null
    : safeLstat(dstManifestPath);
  if (dstManLst) {
    if (dstManLst.isSymbolicLink()) {
      const liveSt = statOrNull(dstManifestPath);
      manifestAction = !liveSt ? 'create' : (force ? 'update' : 'conflict');
    } else if (!dstManLst.isFile()) {
      manifestAction = force ? 'update' : 'conflict';
    } else {
      manifestAction = hashLfBuffer(manifestText).sha256 === hashLfFile(dstManifestPath).sha256 ? 'skip' : 'update';
    }
  }
  ops.push({ action: manifestAction, kind: 'manifest', relPath: MANIFEST_REL_PATH, content: manifestText });

  // 5. OS link plans (.cac/skills & .cac/agents)
  const assumeCcPresent = Boolean(opts.assumeCcPresent);
  for (const linkName of ['skills', 'agents']) {
    const linkAction = planSingleLink(targetDir, linkName, unlinkedDirSet, assumeCcPresent);
    ops.push({
      action: linkAction === 'migrate' ? 'update' : linkAction,
      linkAction,
      kind: 'link',
      relPath: `.cac/${linkName}`,
    });
  }

  const stats = {
    create: ops.filter((o) => o.action === 'create').length,
    update: ops.filter((o) => o.action === 'update').length,
    conflict: ops.filter((o) => o.action === 'conflict').length,
    skip: ops.filter((o) => o.action === 'skip').length,
    prunedObsolete: obsoleteRemovals.length,
    total: ops.length,
  };

  return {
    ok: true,
    code: 0,
    oldEngine,
    unlinkedDirs,
    ops,
    obsoleteRemovals,
    stats,
    conflicts: ops.filter((o) => o.action === 'conflict').map((o) => o.relPath),
    settingsPlan,
    manifestText,
  };
}

/**
 * Execute transactional install, idempotent reinstall, 3-way upgrade, or smooth standalone `cac-base` migration,
 * with integrated 3-tier `cc-base` upstream auto-discovery / co-installation.
 * @param {string} srcRoot
 * @param {string} targetDir
 * @param {{
 *   dryRun?: boolean,
 *   force?: boolean,
 *   hookForm?: '' | 'string' | 'exec',
 *   ccBase?: string,
 *   withCc?: boolean,
 *   noAutoCc?: boolean
 * }} [opts]
 */
export function runInstall(srcRoot, targetDir, opts = {}) {
  const valid = validateTargetPath(targetDir);
  if (!valid.ok) {
    return { ok: false, code: 2, error: valid.message };
  }
  const srcCac = path.join(srcRoot, '.cac');
  if (!fs.existsSync(srcCac) || !fs.statSync(srcCac).isDirectory()) {
    return { ok: false, code: 2, error: `源框架目录缺失 .cac：${srcCac}` };
  }

  const explicitCc = String(opts.ccBase ?? '').trim();
  const withCc = Boolean(opts.withCc);
  const flagNoAutoCc = Boolean(opts.noAutoCc);
  if (flagNoAutoCc && (withCc || explicitCc)) {
    return {
      ok: false,
      code: 2,
      error: '--no-auto-cc 不能与 --with-cc 或 --cc-base 同时指定',
    };
  }
  if (explicitCc) {
    const expCheck = resolveCcBaseSource(srcRoot, explicitCc);
    if (!expCheck.ok) return expCheck;
  } else if (withCc) {
    const wCheck = resolveCcBaseSource(srcRoot, '');
    if (!wCheck.found) {
      return {
        ok: false,
        code: 2,
        error: '已指定 --with-cc，但未找到可用的 cc-base 源目录（可通过 --cc-base <dir> 或环境变量 CC_BASE_DIR 指定）',
      };
    }
  }

  if (opts.dryRun) {
    const ccRes = ensureUpstreamCcBase(targetDir, srcRoot, {
      ccBase: explicitCc,
      withCc,
      noAutoCc: flagNoAutoCc,
      dryRun: true,
      hookForm: opts.hookForm || '',
    });
    if (!ccRes.ok) return ccRes;

    const assumeCc =
      ccRes.action === 'present' || ccRes.action === 'upgraded' || ccRes.action === 'auto-installed';
    const plan = planInstall(srcRoot, targetDir, { ...opts, assumeCcPresent: assumeCc });
    if (!plan.ok) return plan;

    return {
      ok: true,
      code: 0,
      dryRun: true,
      target: targetDir,
      plan,
      stats: plan.stats,
      conflicts: plan.conflicts,
      written: [],
      migratedPaths: [],
      ccBase: ccRes,
      pendingCcBase: !assumeCc && !checkTargetCcContract(targetDir, srcRoot).ok,
    };
  }

  if (path.resolve(srcRoot) === path.resolve(targetDir)) {
    return {
      ok: false,
      code: 2,
      error: `target 目录不能指向 cac-base-link 框架源仓库自身（${targetDir}）；请指定下游项目路径或使用 --dry-run`,
    };
  }

  const startedAt = new Date().toISOString();
  const migrationStamp = startedAt.replace(/[-:.]/g, '');
  const cacDir = path.join(targetDir, '.cac');
  const runtimeDir = path.join(cacDir, '.runtime');
  const markerPath = path.join(runtimeDir, 'install.marker');

  // Pre-lock safety guard: NEVER traverse a symlinked `.cac` or `.cac/.runtime` when creating `install.lock`!
  try {
    const cacLst = safeLstat(cacDir);
    if (cacLst?.isSymbolicLink()) {
      unlinkSymlinkOrJunctionSafe(cacDir);
    } else if (cacLst && !cacLst.isDirectory()) {
      relocateBlockingPath(cacDir, migrationStamp);
    }

    const rtLst = safeLstat(runtimeDir);
    if (rtLst?.isSymbolicLink()) {
      unlinkSymlinkOrJunctionSafe(runtimeDir);
    } else if (rtLst && !rtLst.isDirectory()) {
      relocateBlockingPath(runtimeDir, migrationStamp);
    }

    const lockCandidate = path.join(runtimeDir, 'install.lock');
    if (safeLstat(lockCandidate)?.isSymbolicLink()) {
      unlinkSymlinkOrJunctionSafe(lockCandidate);
    }
  } catch (preErr) {
    return {
      ok: false,
      code: 1,
      error: `准备目标目录安全边界失败（${targetDir}）: ${preErr?.message || preErr}`,
    };
  }

  const lock = acquireInstallLock(runtimeDir, startedAt);
  if (!lock.ok) return lock;

  const written = [];
  const migratedPaths = [];
  let installDone = false;

  const failAfterRaw = process.env.CAC_SETUP_FAIL_AFTER || '';
  const failAfter = /^\d+$/.test(failAfterRaw) ? parseInt(failAfterRaw, 10) : 0;

  const recordWrite = (relPath) => {
    written.push(toPosix(relPath));
    writeInstallMarker(markerPath, { status: 'active', pid: process.pid, startedAt, written });
    if (failAfter > 0 && written.length >= failAfter) {
      throw new Error(
        `CAC_SETUP_FAIL_AFTER=${failAfter} 故障注入生效：写入第 ${written.length} 个文件（${relPath}）后强制中止`,
      );
    }
  };

  const backupExisting = (dstFull) => {
    const lst = safeLstat(dstFull);
    if (lst && !lst.isSymbolicLink() && lst.isFile()) {
      const bakPath = `${dstFull}.bak`;
      if (safeLstat(bakPath)?.isSymbolicLink()) {
        unlinkSymlinkOrJunctionSafe(bakPath);
      }
      fs.copyFileSync(dstFull, bakPath);
    }
  };

  const ensureSafeDirChain = (absDir) => {
    const rel = toPosix(path.relative(targetDir, absDir));
    if (!rel || rel === '.' || rel.startsWith('..')) return;
    const segs = rel.split('/').filter(Boolean);
    let cur = path.resolve(targetDir);
    for (const seg of segs) {
      cur = path.join(cur, seg);
      const lst = safeLstat(cur);
      if (lst?.isSymbolicLink()) {
        unlinkSymlinkOrJunctionSafe(cur);
      } else if (lst && !lst.isDirectory()) {
        relocateBlockingPath(cur, migrationStamp);
      }
    }
    fs.mkdirSync(absDir, { recursive: true });
  };

  const onSignal = (sig) => {
    if (!installDone) {
      writeInstallMarker(markerPath, {
        status: 'interrupted',
        pid: process.pid,
        startedAt,
        written,
        error: `terminated by ${sig}`,
      });
    }
    try {
      if (safeLstat(lock.lockPath)?.isSymbolicLink()) unlinkSymlinkOrJunctionSafe(lock.lockPath);
      else fs.rmSync(lock.lockPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(1);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    writeInstallMarker(markerPath, { status: 'active', pid: process.pid, startedAt, written });

    // Pre-step: Ensure upstream .claude/ (cc-base) via 3-tier decoupling before computing link & bridge plan
    const ccRes = ensureUpstreamCcBase(targetDir, srcRoot, {
      ccBase: explicitCc,
      withCc,
      noAutoCc: flagNoAutoCc,
      dryRun: false,
      hookForm: opts.hookForm || '',
    });
    if (!ccRes.ok) {
      if (ccRes.code === 2) {
        installDone = true;
        fs.rmSync(markerPath, { force: true });
        return ccRes;
      }
      throw new Error(ccRes.error || '安装上游 cc-base 失败');
    }

    const plan = planInstall(srcRoot, targetDir, opts);
    if (!plan.ok) {
      throw new Error(plan.error);
    }

    // Step 0: Detach any symlinked ancestor directories recorded in `plan.unlinkedDirs` (shallow-to-deep)
    for (const relDir of plan.unlinkedDirs || []) {
      const fullDir = path.join(targetDir, relDir);
      if (safeLstat(fullDir)?.isSymbolicLink()) {
        unlinkSymlinkOrJunctionSafe(fullDir);
      }
    }

    // Step 1: Establish / repair / migrate OS directory links FIRST so any standalone physical
    // `.cac/skills` & `.cac/agents` directories are safely moved into `.cac/.runtime/migrated-standalone-<ts>/`
    // before obsolete manifest cleanup runs!
    const linksRes = ensureBridgeLinks(targetDir, {
      migrate: true,
      force: Boolean(opts.force),
      migrationStamp,
    });
    if (!linksRes.ok) {
      const msg = linksRes.skills.message || linksRes.agents.message || '建立 .cac 桥接链接失败';
      throw new Error(msg);
    }
    if (linksRes.skills.backupPath) migratedPaths.push(toPosix(linksRes.skills.backupPath));
    if (linksRes.agents.backupPath) migratedPaths.push(toPosix(linksRes.agents.backupPath));

    // Step 2: Remove unmodified obsolete files from older cac-base-link or standalone cac-base installs
    for (const oldRel of plan.obsoleteRemovals) {
      const full = path.join(targetDir, oldRel);
      try {
        const lst = safeLstat(full);
        if (lst?.isSymbolicLink()) {
          unlinkSymlinkOrJunctionSafe(full);
        } else if (lst?.isFile()) {
          fs.unlinkSync(full);
        }
      } catch {
        /* ignore */
      }
    }
    const oldOptManifest = path.join(targetDir, OPTIONAL_MANIFEST_REL_PATH);
    const oldOptLst = safeLstat(oldOptManifest);
    if (oldOptLst?.isSymbolicLink()) {
      unlinkSymlinkOrJunctionSafe(oldOptManifest);
    } else if (oldOptLst?.isFile()) {
      fs.unlinkSync(oldOptManifest);
    }

    // Step 3: Write / 3-way merge managed bridge files, settings.json, and FRAMEWORK-MANIFEST.json
    for (const op of plan.ops) {
      if (op.kind === 'link' || op.action === 'skip') continue;
      const dstFull = path.join(targetDir, op.relPath);

      if (op.kind === 'settings') {
        if (op.action === 'conflict') {
          const newPath = `${dstFull}.cac-link-new`;
          ensureSafeDirChain(path.dirname(newPath));
          clearLeafBeforeWrite(newPath, migrationStamp);
          fs.writeFileSync(newPath, plan.settingsPlan.content, 'utf8');
          recordWrite(`${op.relPath}.cac-link-new`);
        } else {
          if (op.action === 'update') backupExisting(dstFull);
          ensureSafeDirChain(path.dirname(dstFull));
          clearLeafBeforeWrite(dstFull, migrationStamp);
          fs.writeFileSync(dstFull, plan.settingsPlan.content, 'utf8');
          recordWrite(op.relPath);
        }
        continue;
      }

      if (op.action === 'conflict') {
        const newPath = `${dstFull}.cac-link-new`;
        ensureSafeDirChain(path.dirname(newPath));
        clearLeafBeforeWrite(newPath, migrationStamp);
        if (op.srcFull) fs.copyFileSync(op.srcFull, newPath);
        else if (typeof op.content === 'string') fs.writeFileSync(newPath, op.content, 'utf8');
        recordWrite(`${op.relPath}.cac-link-new`);
        continue;
      }

      if (op.action === 'update') {
        backupExisting(dstFull);
      }
      ensureSafeDirChain(path.dirname(dstFull));
      clearLeafBeforeWrite(dstFull, migrationStamp);
      if (op.srcFull) fs.copyFileSync(op.srcFull, dstFull);
      else if (typeof op.content === 'string') fs.writeFileSync(dstFull, op.content, 'utf8');
      if ((op.relPath.startsWith('.cac/scripts/') || op.relPath === '.cac/hooks/cc-bridge.mjs') && op.relPath.endsWith('.mjs')) {
        try {
          fs.chmodSync(dstFull, 0o755);
        } catch {
          /* ignore on Windows */
        }
      }
      recordWrite(op.relPath);
    }

    // Prune any empty leftover directories from standalone cac-base (e.g. .cac/githooks, .cac/harness)
    installDone = true;
    fs.rmSync(markerPath, { force: true });
    if (safeLstat(lock.lockPath)?.isSymbolicLink()) unlinkSymlinkOrJunctionSafe(lock.lockPath);
    else fs.rmSync(lock.lockPath, { recursive: true, force: true });
    pruneEmptyDirsNonSymlink(path.join(targetDir, '.cac'));

    return {
      ok: true,
      code: 0,
      dryRun: false,
      target: targetDir,
      plan,
      stats: plan.stats,
      conflicts: plan.conflicts,
      written,
      migratedPaths,
      links: {
        skills: linksRes.skills.status,
        agents: linksRes.agents.status,
      },
      ccBase: ccRes,
      pendingCcBase: linksRes.pendingCcBase,
      resolvedHookForm: plan.settingsPlan?.resolvedForm || 'string',
    };
  } catch (err) {
    const msg = String(err?.message || err);
    if (!installDone) {
      writeInstallMarker(markerPath, {
        status: 'interrupted',
        pid: process.pid,
        startedAt,
        written,
        error: msg,
      });
    }
    return {
      ok: false,
      code: 1,
      interrupted: true,
      error: msg,
      written,
    };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      if (safeLstat(lock.lockPath)?.isSymbolicLink()) unlinkSymlinkOrJunctionSafe(lock.lockPath);
      else fs.rmSync(lock.lockPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function loadFrameworkDefaultPermissions(srcRoot = FRAMEWORK_ROOT) {
  const srcSettingsPath = path.join(srcRoot, '.cac', 'settings.json');
  if (!fs.existsSync(srcSettingsPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(srcSettingsPath, 'utf8'));
    return parsed && typeof parsed.permissions === 'object' ? parsed.permissions : null;
  } catch {
    return null;
  }
}

/**
 * Safely uninstall `cac-base-link` from `targetDir`.
 * Detaches `.cac/skills` & `.cac/agents` links via `removeBridgeLinks` (NEVER touching `.claude/`!).
 * @param {string} targetDir
 * @param {{ force?: boolean, dryRun?: boolean, srcRoot?: string }} [opts]
 */
export function runUninstall(targetDir, opts = {}) {
  const valid = validateTargetPath(targetDir);
  if (!valid.ok) {
    return { ok: false, code: 2, error: valid.message };
  }
  const force = Boolean(opts.force);
  const dryRun = Boolean(opts.dryRun);
  const cacDir = path.join(targetDir, '.cac');
  const coreManifestPath = path.join(targetDir, MANIFEST_REL_PATH);

  const cacLst = safeLstat(cacDir);
  if (!cacLst) {
    return {
      ok: false,
      code: 2,
      error: `目标目录未检测到 cac-base-link 安装清单（${MANIFEST_REL_PATH}）：${targetDir}`,
    };
  }
  if (cacLst.isSymbolicLink()) {
    if (!force) {
      return {
        ok: false,
        code: 2,
        error: `拒绝卸载：目标 .cac 目录本身是符号链接/联接点（${cacDir}），不穿透外部目录（如需仅拆链请传 --force）`,
      };
    }
    if (!dryRun) unlinkSymlinkOrJunctionSafe(cacDir);
    return { ok: true, code: 0, dryRun, removed: ['.cac'], keptModified: [] };
  }

  const manLst = safeLstat(coreManifestPath);
  if (!manLst) {
    return {
      ok: false,
      code: 2,
      error: `目标目录未检测到 cac-base-link 安装清单（${MANIFEST_REL_PATH}）：${targetDir}`,
    };
  }
  if (manLst.isSymbolicLink()) {
    if (!force) {
      return {
        ok: false,
        code: 2,
        error: `拒绝卸载：${MANIFEST_REL_PATH} 是符号链接，不穿透外部清单（如需强制拆链请传 --force）`,
      };
    }
    if (!dryRun) unlinkSymlinkOrJunctionSafe(coreManifestPath);
    return { ok: true, code: 0, dryRun, removed: [MANIFEST_REL_PATH], keptModified: [] };
  }

  let rawManifest = null;
  try {
    rawManifest = JSON.parse(fs.readFileSync(coreManifestPath, 'utf8'));
  } catch {
    rawManifest = null;
  }
  if (rawManifest && rawManifest.engine && rawManifest.engine !== ENGINE_NAME && !force) {
    return {
      ok: false,
      code: 2,
      error: `目标目录安装引擎为 "${rawManifest.engine}"（非 "${ENGINE_NAME}"），拒绝跨引擎误删独立版（如需强制卸载请传 --force）`,
    };
  }

  const { filesMap: coreMap } = readManifestMaps(coreManifestPath);

  const removed = [];
  const keptModified = [];

  // 1. Detach OS directory links (.cac/skills & .cac/agents) — NEVER touches .claude/ contents!
  if (!dryRun) {
    const linkRes = removeBridgeLinks(targetDir);
    if (linkRes.skills.removed) removed.push('.cac/skills');
    if (linkRes.agents.removed) removed.push('.cac/agents');
  } else {
    for (const name of ['skills', 'agents']) {
      const p = path.join(cacDir, name);
      if (safeLstat(p)?.isSymbolicLink()) removed.push(`.cac/${name}`);
    }
  }

  // 2. Remove managed files from manifest (never traversing symlinks!)
  for (const [relPath, entry] of coreMap) {
    if (!relPath.startsWith('.cac/')) continue;
    const relParts = relPath.split('/');
    let ancestorSym = false;
    for (let i = 2; i < relParts.length; i++) {
      if (safeLstat(path.join(targetDir, relParts.slice(0, i).join('/')))?.isSymbolicLink()) {
        ancestorSym = true;
        break;
      }
    }
    if (ancestorSym) {
      keptModified.push(relPath);
      continue;
    }
    const full = path.join(targetDir, relPath);
    const lst = safeLstat(full);
    if (!lst) continue;
    if (lst.isSymbolicLink()) {
      if (force) {
        if (!dryRun) unlinkSymlinkOrJunctionSafe(full);
        removed.push(relPath);
      } else {
        keptModified.push(relPath);
      }
      continue;
    }
    if (!lst.isFile()) {
      keptModified.push(relPath);
      continue;
    }
    const actualSha = hashLfFile(full).sha256;
    if (actualSha === entry.sha256 || force) {
      if (!dryRun) fs.unlinkSync(full);
      removed.push(relPath);
    } else {
      keptModified.push(relPath);
    }
  }

  // 3. Strip framework hooks (and default permissions when unmodified or --force) from .cac/settings.json
  const settingsPath = path.join(cacDir, 'settings.json');
  const setLst = safeLstat(settingsPath);
  if (setLst) {
    if (setLst.isSymbolicLink()) {
      if (force) {
        if (!dryRun) unlinkSymlinkOrJunctionSafe(settingsPath);
        removed.push('.cac/settings.json');
      } else {
        keptModified.push('.cac/settings.json');
      }
    } else if (setLst.isFile()) {
      try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const stripped = stripFrameworkHooks(parsed);
        let nextSettings = stripped.settings;
        let changed = stripped.removedHooks > 0;
        const defaultPerms = loadFrameworkDefaultPermissions(opts.srcRoot || FRAMEWORK_ROOT);
        const probePerms = defaultPerms ? stripFrameworkPermissions(nextSettings, defaultPerms) : null;
        const onlyFrameworkDefaultsLeft = probePerms && Object.keys(probePerms.settings).length === 0;

        if (onlyFrameworkDefaultsLeft || (force && probePerms && Object.keys(probePerms.settings).length === 0)) {
          if (!dryRun) fs.unlinkSync(settingsPath);
          removed.push('.cac/settings.json');
        } else {
          if (force && probePerms && probePerms.removedPermissions > 0) {
            nextSettings = probePerms.settings;
            changed = true;
          }
          if (!dryRun && changed) {
            fs.writeFileSync(settingsPath, formatSettingsJson(nextSettings), 'utf8');
          }
        }
      } catch {
        keptModified.push('.cac/settings.json');
      }
    } else {
      keptModified.push('.cac/settings.json');
    }
  }

  if (!dryRun) {
    const curManLst = safeLstat(coreManifestPath);
    if (curManLst?.isSymbolicLink()) {
      unlinkSymlinkOrJunctionSafe(coreManifestPath);
      removed.push(MANIFEST_REL_PATH);
    } else if (curManLst?.isFile()) {
      fs.unlinkSync(coreManifestPath);
      removed.push(MANIFEST_REL_PATH);
    }
    const rtDir = path.join(cacDir, '.runtime');
    const rtLst = safeLstat(rtDir);
    if (rtLst && !rtLst.isSymbolicLink() && rtLst.isDirectory()) {
      const lkPath = path.join(rtDir, 'install.lock');
      const lkLst = safeLstat(lkPath);
      if (lkLst?.isSymbolicLink()) unlinkSymlinkOrJunctionSafe(lkPath);
      else if (lkLst) fs.rmSync(lkPath, { recursive: true, force: true });

      const mkPath = path.join(rtDir, 'install.marker');
      const mkLst = safeLstat(mkPath);
      if (mkLst?.isSymbolicLink()) unlinkSymlinkOrJunctionSafe(mkPath);
      else if (mkLst?.isFile()) fs.unlinkSync(mkPath);
    }
    pruneEmptyDirsNonSymlink(cacDir);
  }

  return {
    ok: true,
    code: 0,
    dryRun,
    removed,
    keptModified,
  };
}

// ---------------------------------------------------------------------------
// Reporting, pack-check, and release
// ---------------------------------------------------------------------------

function printInstallReport(res, cmd, jsonMode) {
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        status: res.ok ? 'ok' : (res.code === 2 ? 'blocked' : 'violation'),
        code: res.code,
        command: cmd,
        dryRun: Boolean(res.dryRun),
        target: res.target,
        stats: res.stats,
        links: res.links || null,
        ccBase: res.ccBase || null,
        pendingCcBase: Boolean(res.pendingCcBase),
        migratedPaths: res.migratedPaths || [],
        conflicts: res.conflicts || [],
        writtenCount: res.written ? res.written.length : 0,
        error: res.error || null,
      }) + '\n',
    );
    return;
  }

  if (!res.ok) {
    process.stderr.write(`setup: ${res.error}\n`);
    return;
  }

  if (res.dryRun) {
    process.stdout.write(`dry-run: 预览计划（零写入），目标目录：${res.target}\n`);
    if (res.ccBase) {
      process.stdout.write(`  cc-base   ${res.ccBase.action}${res.ccBase.source ? ` (${res.ccBase.source})` : ''}\n`);
    }
    for (const op of res.plan.ops) {
      process.stdout.write(`  ${op.action.padEnd(9)} ${op.relPath}\n`);
    }
    process.stdout.write(
      `dry-run: create=${res.stats.create} update=${res.stats.update} conflict=${res.stats.conflict} skip=${res.stats.skip}（conflict 真装时写入 <file>.cac-link-new，绝不覆盖本地修改）\n`,
    );
    return;
  }

  if (res.ccBase && (res.ccBase.action === 'auto-installed' || res.ccBase.action === 'upgraded')) {
    process.stderr.write(
      `setup: 已同步部署上游 cc-base（action=${res.ccBase.action} source=${res.ccBase.source || 'auto'}）\n`,
    );
  }

  if (res.migratedPaths && res.migratedPaths.length > 0) {
    process.stderr.write(
      `setup: 检测到旧独立版实体目录，已安全迁移备份至：\n${res.migratedPaths.map((p) => `  - ${p}`).join('\n')}\n`,
    );
  }

  if (res.conflicts && res.conflicts.length > 0) {
    process.stderr.write(
      `setup: ${res.conflicts.length} 个文件存在本地改动，未覆盖；新版已旁落 <file>.cac-link-new 供审阅合并：\n`,
    );
    for (const c of res.conflicts) {
      process.stderr.write(`  - ${c} -> ${c}.cac-link-new\n`);
    }
  }

  if (res.pendingCcBase) {
    process.stderr.write(
      'setup: 提示——检测到 .claude/ 尚未安装；已完整装入 .cac/ 桥接壳，后续装好 cc-base 后重跑 setup 或启动 codeagent 会话将由 SessionStart 自动补建联接。\n',
    );
  }

  process.stdout.write(
    `${cmd}: ok target=${res.target} create=${res.stats.create} update=${res.stats.update} conflict=${res.stats.conflict} skip=${res.stats.skip} skills=${res.links?.skills || 'n/a'} agents=${res.links?.agents || 'n/a'} cc=${res.ccBase?.action || 'n/a'} hookForm=${res.resolvedHookForm}\n`,
  );
}

function runNodeSubprocess(scriptPath, args, cwd = FRAMEWORK_ROOT) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (r.error) {
    return { status: -1, stdout: '', stderr: r.error.message, parsed: null };
  }
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed = null;
  if (lastLine.startsWith('{')) {
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      parsed = null;
    }
  }
  return { status: r.status ?? -1, stdout, stderr, parsed };
}

function checkAllSyntaxInRepo(root, strictSyntax) {
  const failures = [];
  const warnings = [];
  const allFiles = walkRegularFiles(root, root).filter(
    (rel) =>
      !rel.startsWith('.git/') &&
      !rel.startsWith('node_modules/') &&
      !rel.startsWith(`${BUNDLED_CC_DIRNAME}/`),
  );

  let resolvedPsBin = undefined;
  const getPowerShellParserBin = () => {
    if (resolvedPsBin !== undefined) return resolvedPsBin;
    for (const cand of ['pwsh', 'powershell']) {
      const probe = spawnSync(cand, ['-NoProfile', '-Command', 'exit 0'], {
        cwd: root,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      if (!probe.error || probe.error.code !== 'ENOENT') {
        resolvedPsBin = cand;
        return resolvedPsBin;
      }
    }
    resolvedPsBin = null;
    return null;
  };

  let resolvedShBin = undefined;
  const getShellParserBin = () => {
    if (resolvedShBin !== undefined) return resolvedShBin;
    for (const cand of ['sh', 'bash']) {
      const probe = spawnSync(cand, ['-c', 'exit 0'], {
        cwd: root,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      if (!probe.error || probe.error.code !== 'ENOENT') {
        resolvedShBin = cand;
        return resolvedShBin;
      }
    }
    resolvedShBin = null;
    return null;
  };

  for (const rel of allFiles) {
    const full = path.join(root, rel);
    if (/\.(?:mjs|cjs|js)$/.test(rel)) {
      const r = spawnSync(process.execPath, ['--check', full], {
        cwd: root,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      if (r.status !== 0) {
        failures.push(`${rel}: node --check failed (${String(r.stderr || '').trim().split(/\r?\n/)[0] || r.status})`);
      }
    } else if (rel.endsWith('.json')) {
      const buf = fs.readFileSync(full);
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        failures.push(`${rel}: UTF-8 BOM is forbidden in JSON`);
      }
      try {
        JSON.parse(buf.toString('utf8'));
      } catch (e) {
        failures.push(`${rel}: invalid JSON (${e.message})`);
      }
    } else if (rel.endsWith('.ps1')) {
      const buf = fs.readFileSync(full);
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        failures.push(`${rel}: UTF-8 BOM detected (must be pure ASCII without BOM)`);
      }
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] > 0x7f) {
          failures.push(`${rel}: non-ASCII byte 0x${buf[i].toString(16)} at offset ${i}`);
          break;
        }
      }
      const psBin = getPowerShellParserBin();
      if (!psBin) {
        if (process.platform === 'win32' || strictSyntax) {
          failures.push(`${rel}: pwsh/powershell unavailable for AST verification`);
        } else {
          warnings.push(`${rel}: pwsh/powershell not installed on ${process.platform}, AST check skipped (BOM & ASCII verified)`);
        }
      } else {
        const pwshProbe = spawnSync(
          psBin,
          [
            '-NoProfile',
            '-Command',
            `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${full.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e -and $e.Count -gt 0){Write-Error $e[0].Message;exit 1}`,
          ],
          { cwd: root, encoding: 'utf8', shell: false, windowsHide: true },
        );
        if (pwshProbe.status !== 0) {
          failures.push(`${rel}: PowerShell AST parse failed via ${psBin} (${String(pwshProbe.stderr || '').trim().split(/\r?\n/)[0]})`);
        }
      }
    } else if (rel.endsWith('.sh')) {
      const shBin = getShellParserBin();
      if (!shBin) {
        if (process.platform !== 'win32' || strictSyntax) {
          failures.push(`${rel}: sh/bash unavailable for syntax verification`);
        } else {
          warnings.push(`${rel}: sh/bash not installed on win32, skipped`);
        }
      } else {
        const shProbe = spawnSync(shBin, ['-n', full], {
          cwd: root,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
        });
        if (shProbe.status !== 0) {
          failures.push(`${rel}: ${shBin} -n failed (${String(shProbe.stderr || '').trim().split(/\r?\n/)[0]})`);
        }
      }
    }
  }

  return { ok: failures.length === 0, failures, warnings, checkedFiles: allFiles.length };
}

function handlePackCheck(flags) {
  const strictSyntax = flags.has('strict-syntax');
  const steps = [];
  const bad = [];
  const warnings = [];

  // 1. Unit selftests
  const libSelftests = [
    ['selftest-path-guard', path.join(FRAMEWORK_ROOT, 'scripts', 'lib', 'path-guard.mjs')],
    ['selftest-link-manager', path.join(FRAMEWORK_ROOT, 'scripts', 'lib', 'link-manager.mjs')],
    ['selftest-settings-merge', path.join(FRAMEWORK_ROOT, 'scripts', 'lib', 'settings-merge.mjs')],
    ['selftest-manifest', path.join(FRAMEWORK_ROOT, 'scripts', 'lib', 'manifest.mjs')],
    ['selftest-cc-dep', path.join(FRAMEWORK_ROOT, 'scripts', 'lib', 'cc-dep.mjs')],
  ];
  for (const [name, script] of libSelftests) {
    const r = runNodeSubprocess(script, ['--selftest'], FRAMEWORK_ROOT);
    if (r.status === 0) {
      steps.push({ step: name, ok: true, code: 0 });
    } else {
      const summary = r.stderr.trim().split(/\r?\n/)[0] || `exit ${r.status}`;
      bad.push({ step: name, code: r.status || 1, summary });
      steps.push({ step: name, ok: false, code: r.status || 1, summary });
    }
  }

  // 2. Repo-wide syntax + encoding check
  const syn = checkAllSyntaxInRepo(FRAMEWORK_ROOT, strictSyntax);
  for (const w of syn.warnings) {
    warnings.push({ step: 'check-syntax', code: 0, summary: w });
  }
  if (!syn.ok) {
    bad.push({ step: 'check-syntax', code: 1, summary: syn.failures[0], failures: syn.failures.slice(0, 10) });
    steps.push({ step: 'check-syntax', ok: false, code: 1 });
  } else {
    steps.push({ step: 'check-syntax', ok: true, code: 0, checkedFiles: syn.checkedFiles });
  }

  // 3. Manifest drift check
  const mCheck = checkManifest(FRAMEWORK_ROOT);
  if (mCheck.code !== 0) {
    bad.push({ step: 'manifest-check', code: mCheck.code, summary: mCheck.summary, problems: mCheck.problems?.slice(0, 10) });
    steps.push({ step: 'manifest-check', ok: false, code: mCheck.code });
  } else {
    steps.push({ step: 'manifest-check', ok: true, code: 0 });
  }

  // 4. Anti-leak scan
  const mLeak = leakScanManifest(FRAMEWORK_ROOT, { requireManifestOnDisk: true });
  if (mLeak.code !== 0) {
    bad.push({ step: 'manifest-leak', code: mLeak.code, summary: mLeak.summary, hits: mLeak.hits?.slice(0, 10) });
    steps.push({ step: 'manifest-leak', ok: false, code: mLeak.code });
  } else {
    steps.push({ step: 'manifest-leak', ok: true, code: 0 });
  }

  // 5. Source doctor check
  const doctorScript = path.join(FRAMEWORK_ROOT, '.cac', 'scripts', 'doctor.mjs');
  if (!fs.existsSync(doctorScript)) {
    bad.push({ step: 'doctor', code: 3, summary: 'missing .cac/scripts/doctor.mjs' });
    steps.push({ step: 'doctor', ok: false, code: 3 });
  } else {
    const dr = runNodeSubprocess(doctorScript, ['--source-check', '--json', FRAMEWORK_ROOT], FRAMEWORK_ROOT);
    if (dr.status !== 0) {
      bad.push({
        step: 'doctor',
        code: dr.status,
        summary: dr.parsed?.summary || dr.stderr.trim().split(/\r?\n/)[0] || `doctor exited ${dr.status}`,
      });
      steps.push({ step: 'doctor', ok: false, code: dr.status });
    } else {
      steps.push({ step: 'doctor', ok: true, code: 0 });
    }
  }

  // 6. Direct ./setup.sh executable bit & --help smoke check on POSIX
  if (process.platform !== 'win32') {
    const setupShPath = path.join(FRAMEWORK_ROOT, 'setup.sh');
    const sr = spawnSync(setupShPath, ['--help'], {
      cwd: FRAMEWORK_ROOT,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    if (sr.error || sr.status !== 0) {
      const errMsg = sr.error ? sr.error.message : `setup.sh --help exited ${sr.status}`;
      bad.push({ step: 'smoke-setup.sh', code: 1, summary: errMsg });
      steps.push({ step: 'smoke-setup.sh', ok: false, code: 1, summary: errMsg });
    } else {
      steps.push({ step: 'smoke-setup.sh', ok: true, code: 0 });
    }
  }

  const code = bad.length === 0 ? 0 : (bad.every((b) => b.code === 3) ? 3 : 1);
  const payload = {
    status: code === 0 ? 'ok' : (code === 3 ? 'degraded' : 'violation'),
    code,
    summary: code === 0 ? `pack-check: all ${steps.length} checks passed` : `pack-check: ${bad.length} check(s) failed`,
    steps,
    warnings,
    bad,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(code);
}

function isReleaseExcludedRel(rel, { allowBundledCc = false } = {}) {
  const p = toPosix(rel);
  if (p === BUNDLED_CC_DIRNAME || p.startsWith(`${BUNDLED_CC_DIRNAME}/`)) {
    if (!allowBundledCc) return true;
    const sub = p.slice(BUNDLED_CC_DIRNAME.length + 1);
    if (
      sub === 'progress.md' ||
      sub === 'progress.archive.md' ||
      sub === 'make-release.sh' ||
      sub.startsWith('docs/') ||
      sub.startsWith('.serena/') ||
      sub.startsWith('node_modules/') ||
      sub === '.claude/.last-review' ||
      sub === '.claude/EVOLUTION.md' ||
      sub.startsWith('.claude/local/') ||
      sub.startsWith('.claude/harness/ext/') ||
      sub.startsWith('.claude/research/') ||
      sub.startsWith('.claude/agent-memory/') ||
      sub.startsWith('.claude/worktrees/') ||
      sub.startsWith('.claude/.runtime/') ||
      sub.startsWith('.claude/evidence/') ||
      sub.startsWith('.claude/tests/') ||
      (sub.startsWith('.claude/feedback/') &&
        sub.endsWith('.md') &&
        !sub.startsWith('.claude/feedback/templates/') &&
        sub !== '.claude/feedback/FEEDBACK-INDEX.md')
    ) {
      return true;
    }
    if (/\.(?:bak|cac-link-new|cac-base-new|framework-new|swp)$/.test(sub) || /\.bak-/.test(sub)) return true;
    if (/(?:^|\/)(?:\.DS_Store|Thumbs\.db|settings\.local\.json|settings-windows\.json|\.credentials\.json)$/.test(sub)) {
      return true;
    }
    return false;
  }
  if (
    p === 'progress.md' ||
    p === 'progress.archive.md' ||
    /^progress\..*\.md$/.test(p) ||
    p === 'CHANGELOG.md' ||
    p === 'Product-Spec.md' ||
    p === 'Product-Spec-CHANGELOG.md' ||
    p === 'DEV-PLAN.md' ||
    p === 'DEV-PLAN.archive.md'
  ) {
    return true;
  }
  if (
    p.startsWith('tests/') ||
    p.startsWith('.cac/tests/') ||
    p.startsWith('.serena/') ||
    p.startsWith('node_modules/') ||
    p.startsWith('harness-state/') ||
    p.startsWith('.cac/harness-state/') ||
    p.startsWith('dist/') ||
    p.startsWith('out/') ||
    p.startsWith('release/') ||
    p === '.cac/skills' ||
    p.startsWith('.cac/skills/') ||
    p === '.cac/agents' ||
    p.startsWith('.cac/agents/') ||
    p.startsWith('.cac/.runtime/') ||
    p.startsWith('.cac/local/') ||
    p.startsWith('.cac/evidence/') ||
    p.startsWith('.cac/feedback/') ||
    p === '.cac/EVOLUTION.md' ||
    p.startsWith('.cac/agent-memory/') ||
    p.startsWith('.cac/worktrees/')
  ) {
    return true;
  }
  if (/\.(?:bak|cac-link-new|cac-base-new|framework-new|swp)$/.test(p) || /\.bak-/.test(p)) return true;
  if (/(?:^|\/)(?:\.DS_Store|Thumbs\.db|settings\.local\.json|\.credentials\.json)$/.test(p)) return true;
  return false;
}

function resolveTarCommand() {
  if (process.platform === 'win32') {
    const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sysTar)) return { bin: sysTar, extraFlags: [] };
    const probe = spawnSync('tar', ['--help'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    if (`${probe.stdout || ''}\n${probe.stderr || ''}`.includes('--force-local')) {
      return { bin: 'tar', extraFlags: ['--force-local'] };
    }
  }
  return { bin: 'tar', extraFlags: [] };
}

function handleRelease(version, outOverride, bundleCcArg = '') {
  if (!version || !/^[A-Za-z0-9._+-]+$/.test(version) || version.includes('..')) {
    usageDie(`release 需要合法的版本号（如 v1.0.0），收到：${version || '<empty>'}`);
  }

  const trimmedBundleCc = String(bundleCcArg ?? '').trim();
  let resolvedBundleCcDir = null;
  if (trimmedBundleCc) {
    const srcRes = trimmedBundleCc === 'auto'
      ? resolveCcBaseSource(FRAMEWORK_ROOT, '')
      : resolveCcBaseSource(FRAMEWORK_ROOT, trimmedBundleCc);
    if (!srcRes.ok) {
      process.stderr.write(`release: ${srcRes.error}\n`);
      process.exit(srcRes.code || 2);
    }
    if (!srcRes.found) {
      process.stderr.write('release: --bundle-cc 未找到可用的 cc-base 源目录\n');
      process.exit(2);
    }
    resolvedBundleCcDir = srcRes.dir;
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-link-release-'));
  const pkgName = `cac-base-link-${version}`;
  const stageDir = path.join(tmpBase, pkgName);
  const verifyDir = path.join(tmpBase, 'verify-unpack');

  let exitCode = 1;
  try {
    exitCode = (() => {
      fs.mkdirSync(stageDir, { recursive: true });

      let sourceRelList = [];
      const gitLs = spawnSync(
        'git',
        ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        {
          cwd: FRAMEWORK_ROOT,
          shell: false,
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (gitLs.status === 0 && gitLs.stdout && gitLs.stdout.length > 0) {
        sourceRelList = gitLs.stdout
          .toString('utf8')
          .split('\0')
          .map((s) => toPosix(s.trim()))
          .filter(Boolean);
      } else {
        sourceRelList = walkRegularFiles(FRAMEWORK_ROOT, FRAMEWORK_ROOT).filter(
          (p) => !p.startsWith('.git/') && !p.startsWith('node_modules/'),
        );
      }
      if (fs.existsSync(path.join(FRAMEWORK_ROOT, MANIFEST_REL_PATH)) && !sourceRelList.includes(MANIFEST_REL_PATH)) {
        sourceRelList.push(MANIFEST_REL_PATH);
      }

      // Normal source walk ALWAYS excludes `.bundled-cc-base/`
      for (const rel of sourceRelList) {
        if (isReleaseExcludedRel(rel, { allowBundledCc: false })) continue;
        const srcFull = path.join(FRAMEWORK_ROOT, rel);
        if (!fs.existsSync(srcFull) || !fs.lstatSync(srcFull).isFile()) continue;
        const dstFull = path.join(stageDir, rel);
        fs.mkdirSync(path.dirname(dstFull), { recursive: true });
        fs.copyFileSync(srcFull, dstFull);
        if (rel.endsWith('.sh') || rel === 'scripts/cac-base-link.mjs' || (rel.startsWith('.cac/scripts/') && rel.endsWith('.mjs'))) {
          try {
            fs.chmodSync(dstFull, 0o755);
          } catch {
            /* ignore on Windows */
          }
        }
      }

      // Only when `--bundle-cc <dir>` is passed, explicitly stage clean cc-base files into `.bundled-cc-base/`
      if (resolvedBundleCcDir) {
        const stageRes = stageBundledCcBase(
          resolvedBundleCcDir,
          path.join(stageDir, BUNDLED_CC_DIRNAME),
          FRAMEWORK_ROOT,
        );
        if (!stageRes.ok) {
          process.stderr.write(`release: ${stageRes.error}\n`);
          return stageRes.code || 2;
        }
      }

      const defaultArchive = path.join(os.tmpdir(), `${pkgName}.tar.gz`);
      const outPath = outOverride ? path.resolve(outOverride) : defaultArchive;
      const exportAsDir = outPath.endsWith('.dir');

      let unpackRoot = stageDir;
      if (exportAsDir) {
        fs.rmSync(outPath, { recursive: true, force: true });
        fs.cpSync(stageDir, outPath, { recursive: true });
        unpackRoot = outPath;
      } else {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.rmSync(outPath, { force: true });
        const tarCmd = resolveTarCommand();
        const tmpArchiveName = `${pkgName}.tar.gz`;
        const tmpArchivePath = path.join(tmpBase, tmpArchiveName);
        const packRes = spawnSync(tarCmd.bin, [...tarCmd.extraFlags, '-czf', tmpArchiveName, pkgName], {
          cwd: tmpBase,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
        });
        if (packRes.error || packRes.status !== 0) {
          process.stderr.write(`release: tar 打包失败: ${packRes.error?.message || packRes.stderr}\n`);
          return 1;
        }

        fs.mkdirSync(verifyDir, { recursive: true });
        const unpackRes = spawnSync(tarCmd.bin, [...tarCmd.extraFlags, '-xzf', tmpArchiveName, '-C', 'verify-unpack'], {
          cwd: tmpBase,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
        });
        if (unpackRes.error || unpackRes.status !== 0) {
          process.stderr.write(`release: 解包校验失败: ${unpackRes.error?.message || unpackRes.stderr}\n`);
          return 1;
        }
        fs.copyFileSync(tmpArchivePath, outPath);
        unpackRoot = path.join(verifyDir, pkgName);
      }

      const unpackedFiles = walkRegularFiles(unpackRoot, unpackRoot);
      const leakedFiles = unpackedFiles.filter((rel) =>
        isReleaseExcludedRel(rel, { allowBundledCc: Boolean(resolvedBundleCcDir) }),
      );

      const contentHits = [];
      for (const rel of unpackedFiles) {
        const full = path.join(unpackRoot, rel);
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) continue;
        contentHits.push(...scanTextForLeaks(rel, buf.toString('utf8')));
      }

      if (leakedFiles.length > 0 || contentHits.length > 0) {
        if (!exportAsDir) fs.rmSync(outPath, { force: true });
        process.stdout.write(
          JSON.stringify({
            status: 'violation',
            code: 1,
            summary: `release leak check failed: leakedFiles=${leakedFiles.length}, contentHits=${contentHits.length}`,
            leakedFiles: leakedFiles.slice(0, 20),
            contentHits: contentHits.slice(0, 20),
          }) + '\n',
        );
        return 1;
      }

      process.stdout.write(
        JSON.stringify({
          status: 'ok',
          code: 0,
          version,
          bundledCcBase: Boolean(resolvedBundleCcDir),
          artifact: toPosix(outPath),
          files: unpackedFiles.length,
          summary: `release ${version}: verified ${unpackedFiles.length} unpacked files with 0 leaks${resolvedBundleCcDir ? ' (with .bundled-cc-base)' : ''}`,
        }) + '\n',
      );
      return 0;
    })();
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

function main() {
  const { cmd, flags, kv, positional } = parseCliArgs(process.argv.slice(2));

  if (flags.has('help') || cmd === 'help') {
    process.stdout.write(usageText() + '\n');
    process.exit(0);
  }

  switch (cmd) {
    case 'install':
    case 'upgrade': {
      const target = resolveTargetArg(kv, positional, cmd);
      const res = runInstall(FRAMEWORK_ROOT, target, {
        dryRun: flags.has('dry-run'),
        force: flags.has('force'),
        hookForm: kv['hook-form'] || '',
        withCc: flags.has('with-cc'),
        noAutoCc: flags.has('no-auto-cc'),
        ccBase: kv['cc-base'] || '',
      });
      printInstallReport(res, cmd, flags.has('json'));
      process.exit(res.code);
      break;
    }

    case 'uninstall': {
      const target = resolveTargetArg(kv, positional, 'uninstall');
      const res = runUninstall(target, {
        force: flags.has('force'),
        dryRun: flags.has('dry-run'),
        srcRoot: FRAMEWORK_ROOT,
      });
      if (flags.has('json')) {
        process.stdout.write(
          JSON.stringify({
            status: res.ok ? 'ok' : 'blocked',
            code: res.code,
            removed: res.removed || [],
            keptModified: res.keptModified || [],
            error: res.error || null,
          }) + '\n',
        );
      } else if (!res.ok) {
        process.stderr.write(`uninstall: ${res.error}\n`);
      } else {
        process.stdout.write(
          `uninstall: ${res.dryRun ? '(dry-run) ' : ''}removed=${res.removed.length} keptModified=${res.keptModified.length} target=${target}\n`,
        );
      }
      process.exit(res.code);
      break;
    }

    case 'doctor': {
      const target = resolveTargetArg(kv, positional, 'doctor');
      const v = validateTargetPath(target);
      if (!v.ok) {
        process.stderr.write(`doctor: ${v.message}\n`);
        process.exit(2);
      }
      const targetDoctor = path.join(target, '.cac', 'scripts', 'doctor.mjs');
      const fwDoctor = path.join(FRAMEWORK_ROOT, '.cac', 'scripts', 'doctor.mjs');
      const script = fs.existsSync(targetDoctor) ? targetDoctor : fwDoctor;
      if (!fs.existsSync(script)) {
        process.stderr.write('doctor: missing .cac/scripts/doctor.mjs\n');
        process.exit(3);
      }
      const args = [script, target];
      if (flags.has('source-check')) args.push('--source-check');
      if (flags.has('json')) args.push('--json');
      const r = spawnSync(process.execPath, args, {
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
      });
      process.exit(r.status ?? 1);
      break;
    }

    case 'manifest': {
      const modes = ['write', 'check', 'leak', 'print'].filter((m) => flags.has(m));
      if (modes.length > 1) {
        usageDie('manifest: --write / --check / --leak / --print 只能传其中一个');
      }
      const mode = modes[0] || 'check';
      const root = kv.target ? path.resolve(kv.target) : FRAMEWORK_ROOT;
      if (mode === 'print') {
        process.stdout.write(JSON.stringify(buildCoreManifest(root), null, 2) + '\n');
        process.exit(0);
      }
      const res =
        mode === 'write'
          ? writeManifest(root)
          : mode === 'leak'
            ? leakScanManifest(root, { requireManifestOnDisk: false })
            : checkManifest(root);
      process.stdout.write(JSON.stringify(res) + '\n');
      process.exit(res.code);
      break;
    }

    case 'pack-check': {
      handlePackCheck(flags);
      break;
    }

    case 'release': {
      handleRelease(positional[0], kv.out, kv['bundle-cc'] || '');
      break;
    }

    default:
      usageDie(`未知子命令：${cmd}`);
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
