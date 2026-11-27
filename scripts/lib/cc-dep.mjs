#!/usr/bin/env node
// scripts/lib/cc-dep.mjs — 3-tier decoupled `cc-base` discovery, co-installation & offline bundle helper.
// - Tier 1 (present): Target already satisfies `cc-base-contract.json` -> zero-copy fast path (unless `--with-cc` / `--cc-base`).
// - Tier 2 (auto-installed): Target lacks `.claude/` and auto-cc is enabled -> discovers `.bundled-cc-base` / `CC_BASE_DIR` / `../cc-base`
//   and invokes upstream `setup.ps1` (win32) or `setup.sh` (POSIX) before linking `.cac/{skills,agents}`.
// - Tier 3 (deferred): Target lacks `.claude/` and no `cc-base` source is available (or `--no-auto-cc` / `CAC_LINK_NO_AUTO_CC=1`)
//   -> installs `.cac/` bridge shell cleanly (`exit 0`), later self-healed by `SessionStart`.
// Zero npm dependencies (Node >= 20 built-ins only).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPosix } from './path-guard.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRAMEWORK_ROOT = path.resolve(THIS_DIR, '..', '..');

export const CC_CONTRACT_FILENAME = 'cc-base-contract.json';
export const BUNDLED_CC_DIRNAME = '.bundled-cc-base';

export const DEFAULT_CC_CONTRACT = {
  name: 'cc-base',
  minContractVersion: 1,
  requiredFiles: ['.claude/CLAUDE.md', '.claude/settings.json'],
  requiredDirs: ['.claude/rules', '.claude/skills', '.claude/agents', '.claude/hooks'],
};

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Load `cc-base-contract.json` from `frameworkRoot` (falling back to `DEFAULT_CC_CONTRACT`).
 * @param {string} [frameworkRoot]
 */
export function loadCcContract(frameworkRoot = DEFAULT_FRAMEWORK_ROOT) {
  const fp = path.join(path.resolve(frameworkRoot), CC_CONTRACT_FILENAME);
  try {
    if (fs.existsSync(fp)) {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray(parsed.requiredFiles) &&
        Array.isArray(parsed.requiredDirs)
      ) {
        return parsed;
      }
    }
  } catch {
    /* fallback to built-in contract */
  }
  return DEFAULT_CC_CONTRACT;
}

/**
 * Check whether `<targetDir>` already contains a contract-valid `.claude/` installation.
 * @param {string} targetDir
 * @param {string} [frameworkRoot]
 */
export function checkTargetCcContract(targetDir, frameworkRoot = DEFAULT_FRAMEWORK_ROOT) {
  const absTarget = path.resolve(targetDir);
  const contract = loadCcContract(frameworkRoot);
  const claudeRootStat = statOrNull(path.join(absTarget, '.claude'));
  const present = Boolean(claudeRootStat && claudeRootStat.isDirectory());
  const missing = [];

  for (const relFile of contract.requiredFiles) {
    const st = statOrNull(path.join(absTarget, ...toPosix(relFile).split('/')));
    if (!st || !st.isFile() || st.size === 0) {
      missing.push(relFile);
    }
  }
  for (const relDir of contract.requiredDirs) {
    const st = statOrNull(path.join(absTarget, ...toPosix(relDir).split('/')));
    if (!st || !st.isDirectory()) {
      missing.push(relDir);
    }
  }

  return {
    ok: missing.length === 0,
    present,
    missing,
  };
}

/**
 * Validate whether `ccDir` is a usable `cc-base` source repository / unpacked bundle
 * (must contain `setup.sh`, `setup.ps1`, and contract `.claude/*` entries).
 * @param {string} ccDir
 * @param {string} [frameworkRoot]
 */
export function inspectCcBaseSource(ccDir, frameworkRoot = DEFAULT_FRAMEWORK_ROOT) {
  if (!ccDir || !String(ccDir).trim()) {
    return { ok: false, dir: '', missing: ['<empty>'] };
  }
  const absDir = path.resolve(String(ccDir).trim());
  const rootSt = statOrNull(absDir);
  if (!rootSt || !rootSt.isDirectory()) {
    return { ok: false, dir: absDir, missing: ['<directory-not-found>'] };
  }

  const missing = [];
  for (const installer of ['setup.sh', 'setup.ps1']) {
    const st = statOrNull(path.join(absDir, installer));
    if (!st || !st.isFile()) missing.push(installer);
  }
  const contractCheck = checkTargetCcContract(absDir, frameworkRoot);
  for (const m of contractCheck.missing) {
    missing.push(m);
  }

  return {
    ok: missing.length === 0,
    dir: absDir,
    missing,
  };
}

/**
 * Probe available `cc-base` source directory in strict priority order:
 * 1. Explicit `--cc-base <dir>` (if passed and invalid -> `{ ok: false, code: 2, error }`)
 * 2. Offline bundled `<frameworkRoot>/.bundled-cc-base`
 * 3. `process.env.CC_BASE_DIR`
 * 4. Sibling `path.resolve(frameworkRoot, '..', 'cc-base')`
 *
 * @param {string} [frameworkRoot]
 * @param {string} [explicitCcDir]
 */
export function resolveCcBaseSource(frameworkRoot = DEFAULT_FRAMEWORK_ROOT, explicitCcDir = '') {
  const fwRoot = path.resolve(frameworkRoot);
  const explicitTrimmed = String(explicitCcDir ?? '').trim();

  if (explicitTrimmed) {
    const check = inspectCcBaseSource(explicitTrimmed, fwRoot);
    if (!check.ok) {
      return {
        ok: false,
        code: 2,
        found: false,
        source: 'explicit',
        dir: check.dir,
        error: `显式指定的 --cc-base 目录无效或不完整（${explicitTrimmed}）：缺失 ${check.missing.join(', ')}`,
      };
    }
    return {
      ok: true,
      code: 0,
      found: true,
      source: 'explicit',
      dir: check.dir,
    };
  }

  const bundledDir = path.join(fwRoot, BUNDLED_CC_DIRNAME);
  const bundledCheck = inspectCcBaseSource(bundledDir, fwRoot);
  if (bundledCheck.ok) {
    return {
      ok: true,
      code: 0,
      found: true,
      source: 'bundled',
      dir: bundledCheck.dir,
    };
  }

  const envCcRaw = String(process.env.CC_BASE_DIR ?? '').trim();
  if (envCcRaw) {
    const envCheck = inspectCcBaseSource(envCcRaw, fwRoot);
    if (envCheck.ok) {
      return {
        ok: true,
        code: 0,
        found: true,
        source: 'env',
        dir: envCheck.dir,
      };
    }
  }

  const siblingDir = path.resolve(fwRoot, '..', 'cc-base');
  const siblingCheck = inspectCcBaseSource(siblingDir, fwRoot);
  if (siblingCheck.ok) {
    return {
      ok: true,
      code: 0,
      found: true,
      source: 'sibling',
      dir: siblingCheck.dir,
    };
  }

  return {
    ok: true,
    code: 0,
    found: false,
    source: null,
    dir: null,
  };
}

function resolvePowerShellBin() {
  for (const cand of ['pwsh', 'powershell', 'powershell.exe']) {
    const probe = spawnSync(cand, ['-NoProfile', '-Command', 'exit 0'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    if (!probe.error || probe.error.code !== 'ENOENT') {
      return cand;
    }
  }
  return null;
}

function resolveBashBin() {
  for (const cand of ['bash', 'sh']) {
    const probe = spawnSync(cand, ['-c', 'exit 0'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    if (!probe.error || probe.error.code !== 'ENOENT') {
      return cand;
    }
  }
  return null;
}

/**
 * Invoke `cc-base` upstream installer (`setup.ps1` on `win32`, `setup.sh` on POSIX).
 * Always passes `path.resolve(targetDir)` and forwards `--dry-run` / `--hook-form` safely.
 * @param {string} ccSrcDir
 * @param {string} targetDir
 * @param {{ dryRun?: boolean, hookForm?: '' | 'string' | 'exec' }} [opts]
 */
export function invokeCcBaseInstaller(ccSrcDir, targetDir, opts = {}) {
  const absCc = path.resolve(ccSrcDir);
  const absTarget = path.resolve(targetDir);
  const dryRun = Boolean(opts.dryRun);
  const hookForm = opts.hookForm === 'string' || opts.hookForm === 'exec' ? opts.hookForm : '';

  let bin;
  let args;
  if (process.platform === 'win32') {
    bin = resolvePowerShellBin();
    if (!bin) {
      return {
        ok: false,
        code: 3,
        error: 'Windows 环境未找到 pwsh 或 powershell，无法调用 cc-base/setup.ps1',
      };
    }
    args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(absCc, 'setup.ps1'),
      '-Target',
      absTarget,
    ];
    if (dryRun) args.push('-DryRun');
    if (hookForm) args.push('-HookForm', hookForm);
  } else {
    bin = resolveBashBin();
    if (!bin) {
      return {
        ok: false,
        code: 3,
        error: 'POSIX 环境未找到 bash 或 sh，无法调用 cc-base/setup.sh',
      };
    }
    args = [path.join(absCc, 'setup.sh')];
    if (dryRun) args.push('--dry-run');
    if (hookForm) args.push('--hook-form', hookForm);
    args.push(absTarget);
  }

  const r = spawnSync(bin, args, {
    cwd: absCc,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });

  if (r.error) {
    return {
      ok: false,
      code: r.error.code === 'ENOENT' ? 3 : 1,
      error: `调用 cc-base 安装器失败（${bin}）：${r.error.message}`,
      stdout: '',
      stderr: '',
    };
  }
  if (r.status !== 0) {
    const errFirst = String(r.stderr || r.stdout || '')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-3)
      .join(' | ');
    return {
      ok: false,
      code: r.status === 2 ? 2 : 1,
      error: `cc-base 安装器返回非零退出码 ${r.status}${errFirst ? `：${errFirst}` : ''}`,
      stdout: String(r.stdout || ''),
      stderr: String(r.stderr || ''),
    };
  }

  return {
    ok: true,
    code: 0,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
  };
}

/**
 * Ensure upstream `.claude/` (`cc-base`) in `targetDir` according to 3-tier decoupling rules:
 * - Tier 1 (`present` / `upgraded`): target already has complete `.claude/`
 * - Tier 2 (`auto-installed`): target lacks `.claude/`, auto-installs from discovered `cc-base` source
 * - Tier 3 (`deferred`): target lacks `.claude/` and either `--no-auto-cc` / `CAC_LINK_NO_AUTO_CC=1` or no source found
 *
 * @param {string} targetDir
 * @param {string} [frameworkRoot]
 * @param {{
 *   ccBase?: string,
 *   withCc?: boolean,
 *   noAutoCc?: boolean,
 *   dryRun?: boolean,
 *   hookForm?: '' | 'string' | 'exec'
 * }} [opts]
 */
export function ensureUpstreamCcBase(targetDir, frameworkRoot = DEFAULT_FRAMEWORK_ROOT, opts = {}) {
  const fwRoot = path.resolve(frameworkRoot);
  const absTarget = path.resolve(targetDir);
  const explicitCc = String(opts.ccBase ?? '').trim();
  const withCc = Boolean(opts.withCc);
  const flagNoAutoCc = Boolean(opts.noAutoCc);
  const envNoAutoCc = process.env.CAC_LINK_NO_AUTO_CC === '1';
  const noAutoCc = flagNoAutoCc || envNoAutoCc;
  const dryRun = Boolean(opts.dryRun);
  const hookForm = opts.hookForm || '';

  if (flagNoAutoCc && (withCc || explicitCc)) {
    return {
      ok: false,
      code: 2,
      error: '--no-auto-cc 不能与 --with-cc 或 --cc-base 同时指定',
    };
  }

  if (!dryRun && absTarget === fwRoot) {
    return {
      ok: false,
      code: 2,
      error: `target 目录不能指向 cac-base-link 框架源仓库自身（${targetDir}）`,
    };
  }

  // Always validate explicit --cc-base upfront even if target already has .claude/
  if (explicitCc) {
    const explicitCheck = resolveCcBaseSource(fwRoot, explicitCc);
    if (!explicitCheck.ok) return explicitCheck;
  }

  const targetContract = checkTargetCcContract(absTarget, fwRoot);

  // Tier 1: Target already has a complete .claude/ installation
  if (targetContract.ok) {
    if (!withCc && !explicitCc) {
      return {
        ok: true,
        code: 0,
        tier: 1,
        action: 'present',
        dryRun,
        source: null,
        sourceDir: null,
      };
    }
    const srcRes = resolveCcBaseSource(fwRoot, explicitCc);
    if (!srcRes.ok) return srcRes;
    if (!srcRes.found) {
      return {
        ok: false,
        code: 2,
        error: '已指定 --with-cc，但未找到可用的 cc-base 源目录（可通过 --cc-base <dir> 或环境变量 CC_BASE_DIR 指定）',
      };
    }
    if (!dryRun) {
      const instRes = invokeCcBaseInstaller(srcRes.dir, absTarget, { dryRun: false, hookForm });
      if (!instRes.ok) return instRes;
    }
    return {
      ok: true,
      code: 0,
      tier: 1,
      action: 'upgraded',
      dryRun,
      source: srcRes.source,
      sourceDir: srcRes.dir,
    };
  }

  // Tier 3 (explicit opt-out): Target lacks complete .claude/ and --no-auto-cc / CAC_LINK_NO_AUTO_CC=1 is active
  if (noAutoCc && !withCc && !explicitCc) {
    return {
      ok: true,
      code: 0,
      tier: 3,
      action: 'deferred',
      reason: flagNoAutoCc ? 'no-auto-cc-flag' : 'no-auto-cc-env',
      dryRun,
      source: null,
      sourceDir: null,
    };
  }

  // Tier 2: Discover cc-base source and auto-install .claude/
  const srcRes = resolveCcBaseSource(fwRoot, explicitCc);
  if (!srcRes.ok) return srcRes;
  if (!srcRes.found) {
    if (withCc) {
      return {
        ok: false,
        code: 2,
        error: '已指定 --with-cc，但未找到可用的 cc-base 源目录（可通过 --cc-base <dir> 或环境变量 CC_BASE_DIR 指定）',
      };
    }
    // Tier 3 (no upstream source on current machine): allow shell-first install + SessionStart self-healing
    return {
      ok: true,
      code: 0,
      tier: 3,
      action: 'deferred',
      reason: 'cc-source-not-found',
      dryRun,
      source: null,
      sourceDir: null,
    };
  }

  if (!dryRun) {
    const instRes = invokeCcBaseInstaller(srcRes.dir, absTarget, { dryRun: false, hookForm });
    if (!instRes.ok) return instRes;
  }

  return {
    ok: true,
    code: 0,
    tier: 2,
    action: 'auto-installed',
    dryRun,
    source: srcRes.source,
    sourceDir: srcRes.dir,
  };
}

const CC_BUNDLE_SKIP_CLAUDE_ROOT = new Set([
  'settings-windows.json',
  'settings.local.json',
  '.credentials.json',
  '.last-review',
  'EVOLUTION.md',
  '.needs-review',
  '.needs-review.lock',
  '.tdd-exempt',
  '.red-verified',
  '.static-gate',
  '.degraded-review',
  '.fast-mode',
  '.subagent-reminded',
  '.three-file-sync-advised',
  '.tdd-gate-advised',
  '.stop-gate-strikes',
  '.stop-gate-advised',
  '.precompact-block-epoch',
  '.async-verify-last',
  'signals.jsonl',
  '.DS_Store',
  'Thumbs.db',
]);

function isExcludedFromCcBundleClaude(relInClaude) {
  const rel = toPosix(relInClaude).replace(/^\/+/, '');
  if (!rel) return true;
  if (CC_BUNDLE_SKIP_CLAUDE_ROOT.has(rel)) return true;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (
    base === 'signals.jsonl' ||
    base === '.DS_Store' ||
    base === 'Thumbs.db' ||
    base === '.credentials.json'
  ) {
    return true;
  }
  if (/\.(?:bak|framework-new|cac-link-new|cac-base-new|swp)$/.test(rel) || /\.bak-/.test(rel)) return true;
  if (
    rel.startsWith('local/') ||
    rel.startsWith('evidence/') ||
    rel.startsWith('.runtime/') ||
    rel.startsWith('worktrees/') ||
    rel.startsWith('tests/') ||
    rel.startsWith('research/') ||
    rel.startsWith('agent-memory/') ||
    rel.startsWith('harness/ext/') ||
    /^harness\/(?:receipts|state|waivers|trend|evidence)\//.test(rel)
  ) {
    return true;
  }
  if (/^feedback\/[^/]+\.md$/.test(rel)) return true;
  return false;
}

/**
 * Copy clean distributable `cc-base` assets into `<destBundledDir>` (`.bundled-cc-base`)
 * for offline single-archive releases (`release <ver> --bundle-cc <dir>`).
 * Excludes private feedback entries, `progress*.md`, `docs/`, `research/`, `agent-memory/`, `tests/`, and runtime state.
 * @param {string} ccSrcDir
 * @param {string} destBundledDir
 * @param {string} [frameworkRoot]
 */
export function stageBundledCcBase(ccSrcDir, destBundledDir, frameworkRoot = DEFAULT_FRAMEWORK_ROOT) {
  const check = inspectCcBaseSource(ccSrcDir, frameworkRoot);
  if (!check.ok) {
    return {
      ok: false,
      code: 2,
      error: `无效的 --bundle-cc 源目录（${ccSrcDir}）：缺失 ${check.missing.join(', ')}`,
    };
  }

  const srcRoot = check.dir;
  const dstRoot = path.resolve(destBundledDir);
  fs.mkdirSync(dstRoot, { recursive: true });
  let copiedCount = 0;

  for (const rootFile of ['setup.sh', 'setup.ps1', 'README.md', 'ARCHITECTURE.md', '.gitignore']) {
    const srcFp = path.join(srcRoot, rootFile);
    const lst = lstatOrNull(srcFp);
    if (!lst || lst.isSymbolicLink() || !lst.isFile()) continue;
    const dstFp = path.join(dstRoot, rootFile);
    fs.copyFileSync(srcFp, dstFp);
    if (rootFile === 'setup.sh' && process.platform !== 'win32') {
      try {
        fs.chmodSync(dstFp, 0o755);
      } catch {
        /* ignore */
      }
    }
    copiedCount += 1;
  }

  const srcClaude = path.join(srcRoot, '.claude');
  const dstClaude = path.join(dstRoot, '.claude');
  const visitClaude = (curDir) => {
    const entries = fs.readdirSync(curDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(curDir, ent.name);
      const relInClaude = toPosix(path.relative(srcClaude, full));
      if (ent.isDirectory()) {
        if (isExcludedFromCcBundleClaude(`${relInClaude}/x`)) continue;
        visitClaude(full);
      } else if (ent.isFile()) {
        if (isExcludedFromCcBundleClaude(relInClaude)) continue;
        const dstFull = path.join(dstClaude, ...relInClaude.split('/'));
        fs.mkdirSync(path.dirname(dstFull), { recursive: true });
        fs.copyFileSync(full, dstFull);
        copiedCount += 1;
      }
    }
  };
  visitClaude(srcClaude);

  const fbTemplate = path.join(srcClaude, 'feedback', 'templates', 'feedback-index-template.md');
  if (fs.existsSync(fbTemplate) && fs.statSync(fbTemplate).isFile()) {
    const dstFbIndex = path.join(dstClaude, 'feedback', 'FEEDBACK-INDEX.md');
    fs.mkdirSync(path.dirname(dstFbIndex), { recursive: true });
    fs.copyFileSync(fbTemplate, dstFbIndex);
    copiedCount += 1;
  }

  return {
    ok: true,
    code: 0,
    copiedCount,
    bundledDir: dstRoot,
  };
}

function writeSyntheticCcRepo(repoDir, markerText = 'v1') {
  fs.mkdirSync(path.join(repoDir, '.claude', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, '.claude', 'skills', 'dev-builder'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, '.claude', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, '.claude', 'feedback', 'templates'), { recursive: true });

  fs.writeFileSync(path.join(repoDir, '.claude', 'CLAUDE.md'), `# SiteMaster (${markerText})\n`, 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'rules', 'core.md'), '# core\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'skills', 'dev-builder', 'SKILL.md'), '# skill\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'agents', 'implementer.md'), '# implementer\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'hooks', 'stop-gate.mjs'), 'process.exit(0);\n', 'utf8');
  fs.writeFileSync(
    path.join(repoDir, '.claude', 'feedback', 'templates', 'feedback-index-template.md'),
    '# Feedback Index\n',
    'utf8',
  );
  // Private artifacts that stageBundledCcBase MUST strip
  fs.writeFileSync(path.join(repoDir, 'progress.md'), '# private progress\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'feedback', 'private-note.md'), '# private feedback\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', '.credentials.json'), '{"secret":"x"}\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', '.last-review'), 'ok\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'EVOLUTION.md'), '# evolution\n', 'utf8');
  fs.mkdirSync(path.join(repoDir, '.claude', 'local'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.claude', 'local', 'note.md'), 'local\n', 'utf8');
  fs.mkdirSync(path.join(repoDir, '.claude', 'harness', 'ext'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.claude', 'harness', 'ext', 'engine.mjs'), 'export {};\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json.bak-2026'), '{}\n', 'utf8');

  const setupSh = [
    '#!/usr/bin/env bash',
    'set -eu',
    'DRY=0',
    'TARGET="."',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --dry-run) DRY=1 ;;',
    '    --hook-form) shift ;;',
    '    -*) exit 2 ;;',
    '    *) TARGET="$1" ;;',
    '  esac',
    '  shift',
    'done',
    '[ "$DRY" = "1" ] && exit 0',
    'SD="$(cd "$(dirname "$0")" && pwd)"',
    'mkdir -p "$TARGET/.claude"',
    'cp -R "$SD/.claude/." "$TARGET/.claude/"',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(repoDir, 'setup.sh'), setupSh, { encoding: 'utf8', mode: 0o755 });

  const setupPs1 = [
    'param([string]$Target = ".", [switch]$DryRun, [string]$HookForm = "")',
    'if ($DryRun) { exit 0 }',
    '$dst = Join-Path $Target ".claude"',
    'New-Item -ItemType Directory -Path $dst -Force | Out-Null',
    'Copy-Item -Path (Join-Path $PSScriptRoot ".claude\\*") -Destination $dst -Recurse -Force',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(repoDir, 'setup.ps1'), setupPs1, 'utf8');
}

function runSelftest() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-cc-dep-test-'));
  const origEnvCc = process.env.CC_BASE_DIR;
  const origNoAuto = process.env.CAC_LINK_NO_AUTO_CC;

  try {
    delete process.env.CC_BASE_DIR;
    delete process.env.CAC_LINK_NO_AUTO_CC;

    // Workspace layout: <tmpBase>/ws/cac-base-link & <tmpBase>/ws/cc-base
    const ws = path.join(tmpBase, 'ws');
    const fakeFw = path.join(ws, 'cac-base-link');
    const siblingCc = path.join(ws, 'cc-base');
    const envCc = path.join(tmpBase, 'env-cc-base');
    const explicitCc = path.join(tmpBase, 'explicit-cc-base');

    fs.mkdirSync(fakeFw, { recursive: true });
    fs.copyFileSync(
      path.join(DEFAULT_FRAMEWORK_ROOT, CC_CONTRACT_FILENAME),
      path.join(fakeFw, CC_CONTRACT_FILENAME),
    );

    // 1. No sources anywhere -> resolveCcBaseSource returns found=false, ensureUpstreamCcBase -> Tier 3 deferred
    const rNone = resolveCcBaseSource(fakeFw, '');
    if (!rNone.ok || rNone.found) throw new Error(`expected found=false, got ${JSON.stringify(rNone)}`);

    const tDeferred = path.join(tmpBase, 't-deferred');
    const eTier3 = ensureUpstreamCcBase(tDeferred, fakeFw, {});
    if (!eTier3.ok || eTier3.action !== 'deferred') {
      throw new Error(`expected Tier 3 deferred when no source exists, got ${JSON.stringify(eTier3)}`);
    }

    // 2. Invalid explicit --cc-base -> fails with code 2
    const rBadExp = resolveCcBaseSource(fakeFw, path.join(tmpBase, 'missing-cc'));
    if (rBadExp.ok || rBadExp.code !== 2) {
      throw new Error(`expected code=2 on invalid explicit --cc-base, got ${JSON.stringify(rBadExp)}`);
    }

    // 3. Priority order: sibling (4) < CC_BASE_DIR (3) < .bundled-cc-base (2) < explicit --cc-base (1)
    writeSyntheticCcRepo(siblingCc, 'sibling');
    writeSyntheticCcRepo(envCc, 'env');
    writeSyntheticCcRepo(explicitCc, 'explicit');

    const p4 = resolveCcBaseSource(fakeFw, '');
    if (!p4.found || p4.source !== 'sibling') throw new Error(`expected sibling, got ${JSON.stringify(p4)}`);

    process.env.CC_BASE_DIR = envCc;
    const p3 = resolveCcBaseSource(fakeFw, '');
    if (!p3.found || p3.source !== 'env') throw new Error(`expected env over sibling, got ${JSON.stringify(p3)}`);

    const bundledStage = stageBundledCcBase(siblingCc, path.join(fakeFw, BUNDLED_CC_DIRNAME), fakeFw);
    if (!bundledStage.ok) throw new Error(`stageBundledCcBase failed: ${JSON.stringify(bundledStage)}`);
    if (fs.existsSync(path.join(fakeFw, BUNDLED_CC_DIRNAME, 'progress.md'))) {
      throw new Error('stageBundledCcBase must exclude progress.md');
    }
    if (fs.existsSync(path.join(fakeFw, BUNDLED_CC_DIRNAME, '.claude', 'feedback', 'private-note.md'))) {
      throw new Error('stageBundledCcBase must exclude private feedback/*.md');
    }
    for (const forbidden of [
      '.credentials.json',
      '.last-review',
      'EVOLUTION.md',
      'local/note.md',
      'harness/ext/engine.mjs',
      'settings.json.bak-2026',
    ]) {
      if (fs.existsSync(path.join(fakeFw, BUNDLED_CC_DIRNAME, '.claude', ...forbidden.split('/')))) {
        throw new Error(`stageBundledCcBase must exclude .claude/${forbidden}`);
      }
    }

    const p2 = resolveCcBaseSource(fakeFw, '');
    if (!p2.found || p2.source !== 'bundled') throw new Error(`expected bundled over env, got ${JSON.stringify(p2)}`);

    const p1 = resolveCcBaseSource(fakeFw, explicitCc);
    if (!p1.found || p1.source !== 'explicit') throw new Error(`expected explicit over bundled, got ${JSON.stringify(p1)}`);
    delete process.env.CC_BASE_DIR;

    // 4. Tier 2 dry-run writes ZERO files/directories
    const tDry = path.join(tmpBase, 't-dry-auto');
    const eDry = ensureUpstreamCcBase(tDry, fakeFw, { dryRun: true });
    if (!eDry.ok || eDry.action !== 'auto-installed' || fs.existsSync(tDry)) {
      throw new Error(`Tier 2 dryRun must succeed with zero writes, got ${JSON.stringify(eDry)}`);
    }

    // 5. Tier 3 via --no-auto-cc and CAC_LINK_NO_AUTO_CC=1
    const tOptOut = path.join(tmpBase, 't-optout');
    const eNoAutoFlag = ensureUpstreamCcBase(tOptOut, fakeFw, { noAutoCc: true });
    if (!eNoAutoFlag.ok || eNoAutoFlag.action !== 'deferred') {
      throw new Error(`expected deferred with noAutoCc:true, got ${JSON.stringify(eNoAutoFlag)}`);
    }
    process.env.CAC_LINK_NO_AUTO_CC = '1';
    const eNoAutoEnv = ensureUpstreamCcBase(tOptOut, fakeFw, {});
    if (!eNoAutoEnv.ok || eNoAutoEnv.action !== 'deferred') {
      throw new Error(`expected deferred with CAC_LINK_NO_AUTO_CC=1, got ${JSON.stringify(eNoAutoEnv)}`);
    }
    delete process.env.CAC_LINK_NO_AUTO_CC;

    // 6. Tier 2 real auto-install -> populates complete .claude/, then Tier 1 repeat -> 'present', --cc-base -> 'upgraded'
    const tAuto = path.join(tmpBase, 't-auto');
    const eAuto = ensureUpstreamCcBase(tAuto, fakeFw, {});
    if (!eAuto.ok || eAuto.action !== 'auto-installed' || !checkTargetCcContract(tAuto, fakeFw).ok) {
      throw new Error(`expected Tier 2 auto-installed with valid contract, got ${JSON.stringify(eAuto)}`);
    }

    const ePresent = ensureUpstreamCcBase(tAuto, fakeFw, {});
    if (!ePresent.ok || ePresent.action !== 'present') {
      throw new Error(`expected Tier 1 present on repeat, got ${JSON.stringify(ePresent)}`);
    }

    const eUpgraded = ensureUpstreamCcBase(tAuto, fakeFw, { ccBase: explicitCc });
    if (!eUpgraded.ok || eUpgraded.action !== 'upgraded') {
      throw new Error(`expected Tier 1 upgraded when --cc-base passed, got ${JSON.stringify(eUpgraded)}`);
    }
    if (!fs.readFileSync(path.join(tAuto, '.claude', 'CLAUDE.md'), 'utf8').includes('(explicit)')) {
      throw new Error('expected .claude/CLAUDE.md to be upgraded from explicitCc');
    }

    process.stdout.write(JSON.stringify({ ok: true, tests: 6 }) + '\n');
  } finally {
    if (origEnvCc === undefined) delete process.env.CC_BASE_DIR;
    else process.env.CC_BASE_DIR = origEnvCc;
    if (origNoAuto === undefined) delete process.env.CAC_LINK_NO_AUTO_CC;
    else process.env.CAC_LINK_NO_AUTO_CC = origNoAuto;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  if (process.argv.includes('--selftest')) {
    runSelftest();
    process.exit(0);
  }
  process.stderr.write('usage: node scripts/lib/cc-dep.mjs --selftest\n');
  process.exit(2);
}
