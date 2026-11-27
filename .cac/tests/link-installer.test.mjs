// # risk: high
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const LINK_CLI = path.join(REPO_ROOT, 'scripts', 'cac-base-link.mjs');
const SETUP_SH = path.join(REPO_ROOT, 'setup.sh');
const SETUP_PS1 = path.join(REPO_ROOT, 'setup.ps1');
const PS1_TEST = path.join(TEST_DIR, 'ps1-shell.test.ps1');
const PATH_GUARD_CLI = path.join(REPO_ROOT, 'scripts', 'lib', 'path-guard.mjs');
const DOCTOR_CLI = path.join(REPO_ROOT, '.cac', 'scripts', 'doctor.mjs');

const CC_BASE_ROOT = process.env.CC_BASE_ROOT
  ? path.resolve(process.env.CC_BASE_ROOT)
  : path.resolve(REPO_ROOT, '..', 'cc-base');
const CAC_BASE_ROOT = process.env.CAC_BASE_ROOT
  ? path.resolve(process.env.CAC_BASE_ROOT)
  : path.resolve(REPO_ROOT, '..', 'cac-base');
const CAC_STANDALONE_CLI = path.join(CAC_BASE_ROOT, 'scripts', 'cac-base.mjs');

const HAS_REAL_CC_BASE = fs.existsSync(path.join(CC_BASE_ROOT, '.claude', 'FRAMEWORK-MANIFEST.txt'));
const HAS_REAL_CAC_BASE = fs.existsSync(CAC_STANDALONE_CLI);

const TMP_BASE = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'cac-link-inst-test-'));
let seq = 0;
function nextDir(label) {
  seq += 1;
  return path.join(TMP_BASE, `${seq}-${label}`);
}

after(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function runNode(script, args = [], opts = {}) {
  const childEnv = { ...process.env };
  delete childEnv.CODEAGENT3_PROJECT_DIR;
  delete childEnv.CAC_PROJECT_DIR;
  delete childEnv.CLAUDE_PROJECT_DIR;
  delete childEnv.CC_BASE_DIR;
  delete childEnv.CAC_LINK_NO_AUTO_CC;
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined || v === null) delete childEnv[k];
      else childEnv[k] = String(v);
    }
  }
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd || TMP_BASE,
    input: opts.input !== undefined ? opts.input : '',
    env: childEnv,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: opts.timeout || 90000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function hasPosixBash() {
  if (process.platform === 'win32') return false;
  const r = spawnSync('bash', ['--version'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  return !r.error && r.status === 0;
}

function resolvePowerShellBin() {
  for (const cand of ['pwsh', 'powershell', 'powershell.exe']) {
    const r = spawnSync(cand, ['-NoProfile', '-Command', 'exit 0'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    if (!r.error && r.status === 0) return cand;
  }
  return null;
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

function runSetupSh(args = [], opts = {}) {
  const childEnv = { ...process.env };
  delete childEnv.CC_BASE_DIR;
  delete childEnv.CAC_LINK_NO_AUTO_CC;
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined || v === null) delete childEnv[k];
      else childEnv[k] = String(v);
    }
  }
  return spawnSync('bash', [SETUP_SH, ...args], {
    cwd: opts.cwd || TMP_BASE,
    env: childEnv,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: opts.timeout || 90000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function lfSha256(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const norm = Buffer.from(buf.filter((b) => b !== 0x0d));
  return {
    sha256: createHash('sha256').update(norm).digest('hex'),
    bytes: norm.length,
  };
}

function rawFileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Compute recursive raw-byte SHA256 snapshot of all regular files under `dir`
 * (refusing to follow symlinks, and failing if unexpected symlinks appear).
 */
function snapshotTreeRawSha256(dir) {
  const map = new Map();
  const walk = (cur) => {
    const entries = fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      const rel = toPosix(path.relative(dir, full));
      assert.equal(ent.isSymbolicLink(), false, `unexpected symlink inside ${dir}: ${rel}`);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        map.set(rel, rawFileSha256(full));
      }
    }
  };
  assert.equal(fs.existsSync(dir), true, `snapshot directory must exist: ${dir}`);
  walk(dir);
  return map;
}

function assertSnapshotExact(expectedMap, actualDir, stageLabel) {
  const actualMap = snapshotTreeRawSha256(actualDir);
  assert.equal(
    actualMap.size,
    expectedMap.size,
    `[${stageLabel}] file count changed in ${actualDir}: expected ${expectedMap.size}, got ${actualMap.size}`,
  );
  for (const [rel, expHash] of expectedMap.entries()) {
    assert.equal(actualMap.has(rel), true, `[${stageLabel}] missing file in ${actualDir}: ${rel}`);
    assert.equal(
      actualMap.get(rel),
      expHash,
      `[${stageLabel}] byte-level SHA256 mutated in ${actualDir}/${rel}`,
    );
  }
  for (const rel of actualMap.keys()) {
    assert.equal(
      /\.(?:bak|cac-base-new|cac-link-new|framework-new)$/.test(rel),
      false,
      `[${stageLabel}] unexpected sidecar/backup garbage inside ${actualDir}: ${rel}`,
    );
  }
}

/**
 * Build a complete cross-platform synthetic `cc-base` source repo (`setup.sh` + `setup.ps1` + 22 skills + 8 agents)
 * used for custom `--cc-base` / `CC_BASE_DIR` source priority tests (and as CI fallback when sibling `cc-base` is absent).
 */
function createSyntheticCcSourceRepo(repoDir, marker = 'synthetic-v1') {
  fs.mkdirSync(path.join(repoDir, '.claude', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, '.claude', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, '.claude', 'feedback', 'templates'), { recursive: true });

  fs.writeFileSync(path.join(repoDir, '.claude', 'CLAUDE.md'), `[Role]\nSiteMaster constitution (${marker}).\n`, 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'rules', 'core.md'), '# Core Rules\n', 'utf8');
  for (let i = 1; i <= 22; i += 1) {
    const sk = path.join(repoDir, '.claude', 'skills', `skill-${String(i).padStart(2, '0')}`, 'SKILL.md');
    fs.mkdirSync(path.dirname(sk), { recursive: true });
    fs.writeFileSync(sk, `# skill-${i} (${marker})\n`, 'utf8');
  }
  for (const role of [
    'implementer', 'tester', 'code-reviewer', 'deployer',
    'evolution-runner', 'feedback-observer', 'progress-recorder', 'domain-recorder',
  ]) {
    const ag = path.join(repoDir, '.claude', 'agents', `${role}.md`);
    fs.mkdirSync(path.dirname(ag), { recursive: true });
    fs.writeFileSync(ag, `# ${role} (${marker})\n`, 'utf8');
  }
  fs.writeFileSync(
    path.join(repoDir, '.claude', 'hooks', 'session-rules-banner.mjs'),
    "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'[SiteMaster banner]'}})+'\\n');\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoDir, '.claude', 'feedback', 'templates', 'feedback-index-template.md'),
    '# Feedback Index\n',
    'utf8',
  );
  // Private files that `--bundle-cc` MUST strip
  fs.writeFileSync(path.join(repoDir, 'progress.md'), '# private cc-base progress\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'feedback', 'private-entry.md'), '# private feedback\n', 'utf8');

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
  return repoDir;
}

let cachedCcProtoDir = null;
let cachedFallbackCcSource = null;

function ensureCcSourceForBundle() {
  if (HAS_REAL_CC_BASE) return CC_BASE_ROOT;
  if (!cachedFallbackCcSource) {
    cachedFallbackCcSource = createSyntheticCcSourceRepo(nextDir('fallback-cc-src'), 'ci-fallback');
  }
  return cachedFallbackCcSource;
}

/**
 * Materialize a 100% real cc-base `.claude/` prototype once in TMP_BASE:
 * uses real `cc-base/setup.sh` when POSIX bash is available or copies exact entries listed
 * in `cc-base/.claude/FRAMEWORK-MANIFEST.txt` + `settings.json` cross-platform on Windows.
 */
function ensureCcPrototype() {
  if (cachedCcProtoDir) return cachedCcProtoDir;
  const proto = nextDir('cc-base-proto');
  fs.mkdirSync(proto, { recursive: true });

  if (HAS_REAL_CC_BASE) {
    const ccSetupSh = path.join(CC_BASE_ROOT, 'setup.sh');
    let installedViaSetupSh = false;
    if (hasPosixBash() && fs.existsSync(ccSetupSh)) {
      const r = spawnSync('bash', [ccSetupSh, proto], {
        cwd: CC_BASE_ROOT,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 60000,
      });
      if (r.status === 0 && fs.existsSync(path.join(proto, '.claude', 'CLAUDE.md'))) {
        installedViaSetupSh = true;
      }
    }
    if (!installedViaSetupSh) {
      const srcClaude = path.join(CC_BASE_ROOT, '.claude');
      const manifestTxtPath = path.join(srcClaude, 'FRAMEWORK-MANIFEST.txt');
      const lines = fs.readFileSync(manifestTxtPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line || line.startsWith('#')) continue;
        const [rel] = line.split('\t');
        if (!rel) continue;
        const srcFull = path.join(srcClaude, ...rel.split('/'));
        if (!fs.existsSync(srcFull) || !fs.statSync(srcFull).isFile()) continue;
        const dstFull = path.join(proto, '.claude', ...rel.split('/'));
        fs.mkdirSync(path.dirname(dstFull), { recursive: true });
        fs.copyFileSync(srcFull, dstFull);
      }
      fs.copyFileSync(manifestTxtPath, path.join(proto, '.claude', 'FRAMEWORK-MANIFEST.txt'));
      const srcSettings = path.join(srcClaude, 'settings.json');
      if (fs.existsSync(srcSettings)) {
        fs.copyFileSync(srcSettings, path.join(proto, '.claude', 'settings.json'));
      }
    }
  } else {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', `Real sibling cc-base missing at ${CC_BASE_ROOT}`);
    const syn = ensureCcSourceForBundle();
    fs.cpSync(path.join(syn, '.claude'), path.join(proto, '.claude'), { recursive: true });
  }

  cachedCcProtoDir = proto;
  return cachedCcProtoDir;
}

function installRealCcBase(targetDir) {
  const proto = ensureCcPrototype();
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(path.join(proto, '.claude'), path.join(targetDir, '.claude'), { recursive: true });
}

function findDeadPid() {
  for (const candidate of [999999, 999998, 888888, 777777, 2147483646]) {
    try {
      process.kill(candidate, 0);
    } catch (e) {
      if (e && e.code === 'ESRCH') return candidate;
    }
  }
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    windowsHide: true,
    shell: false,
  });
  return child.pid || 999999;
}

function createExplicitDirLink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (process.platform === 'win32') {
    fs.symlinkSync(path.resolve(targetPath), linkPath, 'junction');
  } else {
    fs.symlinkSync(targetPath, linkPath, 'dir');
  }
}

function detachLinkSafe(linkPath) {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    fs.rmdirSync(linkPath);
  }
}

describe('cac-base-link installer, 3-tier cc-base co-installation, F-01..F-11 red-locks & round-trip suite', () => {
  test('[F-02 & CLI/PS1 Contract] rejects bare typos (package/pack/check), mutually exclusive cc flags, unsafe paths, and verifies setup.ps1 parameter & ASCII contract', () => {
    // 1. PowerShell scripts must be pure ASCII (< 0x80) and UTF-8 without BOM + declare new cc flags & package guard
    for (const psFile of [SETUP_PS1, PS1_TEST]) {
      assert.equal(fs.existsSync(psFile), true, `missing PowerShell file: ${psFile}`);
      const buf = fs.readFileSync(psFile);
      const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      assert.equal(hasBom, false, `UTF-8 BOM forbidden in ${path.basename(psFile)}`);
      for (let i = 0; i < buf.length; i += 1) {
        assert.equal(
          buf[i] < 0x80,
          true,
          `non-ASCII byte 0x${buf[i].toString(16)} at offset ${i} in ${path.basename(psFile)}`,
        );
      }
    }

    const setupPs1Text = fs.readFileSync(SETUP_PS1, 'utf8');
    for (const expectedToken of [
      '[switch]$WithCc',
      '[switch]$NoAutoCc',
      '[string]$CcBase',
      '[string]$BundleCc',
      "'package'",
      '--with-cc',
      '--no-auto-cc',
      '--cc-base',
      '--bundle-cc',
    ]) {
      assert.equal(
        setupPs1Text.includes(expectedToken),
        true,
        `setup.ps1 missing required static contract token: ${expectedToken}`,
      );
    }

    // 2. [F-02] Bare subcommand typos (`package`, `pack`, `bundle`, `check`, etc.) & unknown flags exit 2 with zero mkdir
    const workCwd = nextDir('cli-guard-cwd');
    fs.mkdirSync(workCwd, { recursive: true });

    for (const badArgs of [
      ['--dryrun'],
      ['--dryrun', nextDir('never-1')],
      ['package'],
      ['pack'],
      ['bundle'],
      ['check'],
      ['verify'],
      ['test'],
      ['status'],
      ['init'],
      ['update'],
      ['remove'],
      ['clean'],
      ['version'],
      ['install', '--hook-form', 'invalid-form', nextDir('never-2')],
    ]) {
      const r = runNode(LINK_CLI, badArgs, { cwd: workCwd });
      assert.equal(r.status, 2, `expected exit 2 for args ${JSON.stringify(badArgs)}, got ${r.status}: ${r.stderr}`);
    }
    const rPkg = runNode(LINK_CLI, ['package'], { cwd: workCwd });
    assert.equal(rPkg.status, 2);
    assert.match(rPkg.stderr, /unknown subcommand "package"/);
    assert.deepEqual(fs.readdirSync(workCwd), [], 'working directory must remain completely empty (no ./package dir created)');

    // Explicit --target ./package IS allowed in dry-run when user genuinely names folder "package"
    const explicitPkgDir = path.join(nextDir('explicit-pkg-holder'), 'package');
    const rExplicitPkg = runNode(LINK_CLI, ['install', '--target', explicitPkgDir, '--no-auto-cc', '--dry-run']);
    assert.equal(rExplicitPkg.status, 0, rExplicitPkg.stderr);
    assert.equal(fs.existsSync(explicitPkgDir), false);

    // 3. Mutually exclusive cc-base flags (--no-auto-cc + --with-cc / --cc-base) & invalid --cc-base exit 2 with zero side effects
    const mutDir1 = nextDir('mut-conflict-1');
    const rMut1 = runNode(LINK_CLI, ['install', '--no-auto-cc', '--with-cc', '--target', mutDir1]);
    assert.equal(rMut1.status, 2, `expected exit 2 on --no-auto-cc + --with-cc, got ${rMut1.status}`);
    assert.match(rMut1.stderr, /--no-auto-cc/);
    assert.equal(fs.existsSync(mutDir1), false, '--no-auto-cc + --with-cc must leave zero side effects');

    const mutDir2 = nextDir('mut-conflict-2');
    const rMut2 = runNode(LINK_CLI, ['install', '--no-auto-cc', '--cc-base', ensureCcSourceForBundle(), '--target', mutDir2]);
    assert.equal(rMut2.status, 2, `expected exit 2 on --no-auto-cc + --cc-base, got ${rMut2.status}`);
    assert.equal(fs.existsSync(mutDir2), false, '--no-auto-cc + --cc-base must leave zero side effects');

    const badCcTarget = nextDir('bad-cc-target');
    const rBadCc = runNode(LINK_CLI, ['install', '--cc-base', path.join(TMP_BASE, 'nonexistent-cc-src'), '--target', badCcTarget]);
    assert.equal(rBadCc.status, 2, `expected exit 2 on invalid --cc-base, got ${rBadCc.status}`);
    assert.equal(fs.existsSync(badCcTarget), false, 'invalid --cc-base must leave zero side effects');

    // 4. Self-install protection on cac-base-link source repo itself
    const rSelf = runNode(LINK_CLI, ['install', '--target', REPO_ROOT]);
    assert.equal(rSelf.status, 2, 'installing onto cac-base-link source repo itself must fail with exit 2');

    // 5. Path guard rejects "..", control chars, illegal Windows chars, reserved device names, and trailing dot/space
    const sandbox = nextDir('path-guard-empty');
    fs.mkdirSync(sandbox, { recursive: true });
    const badTargets = [
      `${sandbox}/../escape`,
      '../escape-rel',
      `a/\x07bell/b`,
      ...['<', '>', ':', '"', '|', '?', '*'].map((ch) => path.join(sandbox, `bad${ch}seg`)),
      ...['CON', 'nul', 'aux', 'con.txt', 'lpt1', 'PRN', 'com9'].map((d) => path.join(sandbox, d)),
      path.join(sandbox, 'trailing-dot.'),
      path.join(sandbox, 'trailing-space '),
    ];
    for (const bt of badTargets) {
      assert.equal(runNode(PATH_GUARD_CLI, [bt], { cwd: sandbox }).status, 2);
      assert.equal(runNode(LINK_CLI, ['install', '--target', bt], { cwd: sandbox }).status, 2);
    }
    assert.deepEqual(fs.readdirSync(sandbox), [], 'unsafe targets must leave zero mkdir side effects');

    // 6. --dry-run creates zero files across Tier 2 auto-cc & Tier 3 --no-auto-cc
    for (const [label, argvFn] of [
      ['dry-pos', (d) => [d, '--dry-run', '--json']],
      ['dry-eq', (d) => [`--target=${d}`, '--dry-run', '--json']],
      ['dry-noauto', (d) => ['install', '--target', d, '--no-auto-cc', '--dry-run', '--json']],
    ]) {
      const d = nextDir(label);
      const rDry = runNode(LINK_CLI, argvFn(d));
      assert.equal(rDry.status, 0, rDry.stderr);
      assert.equal(fs.existsSync(d), false, `${label}: --dry-run must write nothing`);
    }

    if (hasPosixBash()) {
      const shDry = nextDir('sh-dry');
      assert.equal(runSetupSh(['--dryrun'], { cwd: workCwd }).status, 2);
      assert.equal(runSetupSh(['package'], { cwd: workCwd }).status, 2);
      assert.equal(runSetupSh(['--no-auto-cc', '--with-cc', '--target', shDry], { cwd: workCwd }).status, 2);
      assert.deepEqual(fs.readdirSync(workCwd), []);
      const rShDry = runSetupSh(['--target', shDry, '--dry-run']);
      assert.equal(rShDry.status, 0, rShDry.stderr);
      assert.equal(fs.existsSync(shDry), false, 'setup.sh --dry-run must write nothing');
    }

    // If PowerShell runtime is available on this host, execute ps1-shell.test.ps1 end-to-end as well
    const psBin = resolvePowerShellBin();
    if (psBin) {
      const rPsTest = spawnSync(psBin, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_TEST], {
        cwd: TMP_BASE,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 120000,
      });
      assert.equal(rPsTest.status, 0, `ps1-shell.test.ps1 failed (${rPsTest.status}):\n${rPsTest.stdout}\n${rPsTest.stderr}`);
    }
  });

  test('[Scenario 1 - Tier 1] existing .claude/ fast-path reuse (3x idempotent), --with-cc / --cc-base upgrade, permissions.ask floor, and string<->exec lossless round-trip', () => {
    const target = nextDir('tier1-idempotent-3x');
    installRealCcBase(target);

    // Run 1: Tier 1 reuse (`present`)
    const r1 = runNode(LINK_CLI, ['install', '--target', target, '--json']);
    assert.equal(r1.status, 0, r1.stderr);
    const j1 = JSON.parse(r1.stdout.trim());
    assert.equal(j1.status, 'ok');
    assert.equal(j1.ccBase?.tier, 1);
    assert.equal(j1.ccBase?.action, 'present');
    assert.equal(j1.pendingCcBase, false);
    assert.equal(j1.stats.conflict, 0);
    assert.ok(j1.stats.create >= 9, `expected initial install creates >= 9 items, got ${JSON.stringify(j1.stats)}`);

    const settingsAfter1 = fs.readFileSync(path.join(target, '.cac', 'settings.json'), 'utf8');

    // Run 2 & Run 3 via Node CLI
    for (let round = 2; round <= 3; round += 1) {
      const r = runNode(LINK_CLI, ['install', '--target', target, '--json']);
      assert.equal(r.status, 0, `round ${round} failed: ${r.stderr}`);
      const jr = JSON.parse(r.stdout.trim());
      assert.equal(jr.status, 'ok');
      assert.equal(jr.ccBase?.action, 'present');
      assert.equal(jr.stats.create, 0, `round ${round} must have create=0`);
      assert.equal(jr.stats.update, 0, `round ${round} must have update=0`);
      assert.equal(jr.stats.conflict, 0, `round ${round} must have conflict=0`);
      assert.equal(jr.writtenCount, 0, `round ${round} must write 0 files`);
    }

    if (hasPosixBash()) {
      for (let round = 1; round <= 3; round += 1) {
        const rSh = runSetupSh([target, '--json']);
        assert.equal(rSh.status, 0, `setup.sh round ${round} failed: ${rSh.stderr}`);
        const jSh = JSON.parse(rSh.stdout.trim());
        assert.equal(jSh.stats.create, 0);
        assert.equal(jSh.stats.update, 0);
        assert.equal(jSh.stats.conflict, 0);
      }
    }

    // Verify settings.json byte-identical, 12 unique cc-bridge hooks, and F-07 permissions.ask force-push guards
    const settingsAfterN = fs.readFileSync(path.join(target, '.cac', 'settings.json'), 'utf8');
    assert.equal(settingsAfterN, settingsAfter1, 'repeated installs must keep settings.json byte-for-byte identical');

    const settingsObj = JSON.parse(settingsAfterN);
    assert.ok(settingsObj.permissions.ask.includes('Bash(git push --force*)'), 'permissions.ask must guard git push --force*');
    assert.ok(settingsObj.permissions.ask.includes('Bash(git push -f*)'), 'permissions.ask must guard git push -f*');

    const allHooks = Object.values(settingsObj.hooks || {})
      .flatMap((groups) => (Array.isArray(groups) ? groups : []))
      .flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : []));
    assert.equal(allHooks.length, 12, `expected exactly 12 hook commands, got ${allHooks.length}`);
    assert.equal(new Set(allHooks.map((h) => h.command)).size, 12, 'all 12 cc-bridge hook commands must be unique');

    // Verify zero root file intrusion: ONLY .cac and .claude exist at project root
    assert.deepEqual(fs.readdirSync(target).sort(), ['.cac', '.claude']);

    // Verify OS directory links (relative symlink on POSIX, NTFS Junction on Windows)
    for (const linkName of ['skills', 'agents']) {
      const linkPath = path.join(target, '.cac', linkName);
      assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, `.cac/${linkName} must be a symlink/Junction`);
      if (process.platform !== 'win32') {
        assert.equal(path.isAbsolute(fs.readlinkSync(linkPath)), false, `POSIX symlink .cac/${linkName} must be relative`);
      }
      assert.equal(
        fs.realpathSync.native(linkPath),
        fs.realpathSync.native(path.join(target, '.claude', linkName)),
      );
    }

    // Verify downstream doctor enumerates all 22 skills and 8 agents
    const rDoc = runNode(path.join(target, '.cac', 'scripts', 'doctor.mjs'), [target, '--json']);
    assert.equal(rDoc.status, 0, rDoc.stdout + rDoc.stderr);
    const docObj = JSON.parse(rDoc.stdout.trim());
    assert.equal(docObj.ok, true);
    assert.equal(docObj.detail.skillsCount, 22);
    assert.equal(docObj.detail.agentsCount, 8);

    // Verify --hook-form string <-> exec lossless round-trip
    assert.equal(runNode(LINK_CLI, ['upgrade', '--target', target, '--hook-form', 'exec']).status, 0);
    const execSettings = JSON.parse(fs.readFileSync(path.join(target, '.cac', 'settings.json'), 'utf8'));
    assert.equal(execSettings.hooks.SessionStart[0].hooks[0].command, 'node');
    assert.deepEqual(execSettings.hooks.SessionStart[0].hooks[0].args, ['.cac/hooks/cc-bridge.mjs', 'session-start']);
    assert.equal(runNode(LINK_CLI, ['upgrade', '--target', target, '--hook-form', 'string']).status, 0);
    assert.equal(fs.readFileSync(path.join(target, '.cac', 'settings.json'), 'utf8'), settingsAfter1);

    // Verify Tier 1 `--with-cc` + `--cc-base <customSrc>` upgrades existing .claude/ in-place (`action: "upgraded"`)
    const customCcV2 = createSyntheticCcSourceRepo(nextDir('tier1-upgrade-cc-v2'), 'upgraded-v2-marker');
    const rWithCc = runNode(LINK_CLI, ['upgrade', '--with-cc', '--cc-base', customCcV2, '--target', target, '--json']);
    assert.equal(rWithCc.status, 0, rWithCc.stderr);
    const withCcObj = JSON.parse(rWithCc.stdout.trim());
    assert.equal(withCcObj.ccBase?.tier, 1);
    assert.equal(withCcObj.ccBase?.action, 'upgraded');
    assert.equal(withCcObj.ccBase?.source, 'explicit');
    assert.match(fs.readFileSync(path.join(target, '.claude', 'CLAUDE.md'), 'utf8'), /upgraded-v2-marker/);
    assert.equal(runNode(path.join(target, '.cac', 'scripts', 'doctor.mjs'), [target, '--json']).status, 0);
  });

  test('[Scenario 2 - Tier 2] empty target auto-discovers ../cc-base (and CC_BASE_DIR override) for one-step .claude/ + .cac/ co-installation', () => {
    // Part A: Default empty target -> discovers sibling ../cc-base (or CC_BASE_DIR fallback in isolated CI) in 1 command
    const autoTarget = nextDir('tier2-empty-auto');
    assert.equal(fs.existsSync(autoTarget), false);

    const envForPartA = HAS_REAL_CC_BASE ? {} : { CC_BASE_DIR: ensureCcSourceForBundle() };
    const expectedSourceA = HAS_REAL_CC_BASE ? 'sibling' : 'env';

    const rAuto = runNode(LINK_CLI, ['install', '--target', autoTarget, '--json'], { env: envForPartA });
    assert.equal(rAuto.status, 0, `Tier 2 one-step auto install failed: ${rAuto.stderr}`);
    const autoObj = JSON.parse(rAuto.stdout.trim());
    assert.equal(autoObj.status, 'ok');
    assert.equal(autoObj.ccBase?.tier, 2);
    assert.equal(autoObj.ccBase?.action, 'auto-installed');
    assert.equal(autoObj.ccBase?.source, expectedSourceA);
    assert.equal(autoObj.pendingCcBase, false);

    assert.equal(fs.existsSync(path.join(autoTarget, '.claude', 'CLAUDE.md')), true);
    assert.equal(fs.lstatSync(path.join(autoTarget, '.cac', 'skills')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(autoTarget, '.cac', 'agents')).isSymbolicLink(), true);

    const rDoc = runNode(path.join(autoTarget, '.cac', 'scripts', 'doctor.mjs'), [autoTarget, '--json']);
    assert.equal(rDoc.status, 0, rDoc.stdout + rDoc.stderr);
    const docObj = JSON.parse(rDoc.stdout.trim());
    assert.equal(docObj.ok, true);
    assert.equal(docObj.detail.skillsCount, 22);
    assert.equal(docObj.detail.agentsCount, 8);

    // Part B: CC_BASE_DIR takes higher priority over sibling ../cc-base (`source: "env"`)
    const envCcRepo = createSyntheticCcSourceRepo(nextDir('env-priority-cc'), 'env-priority-marker-77');
    const envTarget = nextDir('tier2-env-target');
    const rEnvInst = runNode(LINK_CLI, ['install', '--target', envTarget, '--json'], {
      env: { CC_BASE_DIR: envCcRepo },
    });
    assert.equal(rEnvInst.status, 0, rEnvInst.stderr);
    const envObj = JSON.parse(rEnvInst.stdout.trim());
    assert.equal(envObj.ccBase?.tier, 2);
    assert.equal(envObj.ccBase?.action, 'auto-installed');
    assert.equal(envObj.ccBase?.source, 'env');
    assert.match(fs.readFileSync(path.join(envTarget, '.claude', 'CLAUDE.md'), 'utf8'), /env-priority-marker-77/);
  });

  test('[Scenario 3 - Offline Bundle] release <ver> --bundle-cc packs clean .bundled-cc-base and installs .claude/ + .cac/ offline without sibling cc-base', () => {
    const tarCmd = resolveTarCommand();
    const releaseTmpSandbox = nextDir('release-tmp-sandbox');
    fs.mkdirSync(releaseTmpSandbox, { recursive: true });
    const releaseEnv = {
      TMPDIR: releaseTmpSandbox,
      TMP: releaseTmpSandbox,
      TEMP: releaseTmpSandbox,
    };

    // 1. Slim release (without --bundle-cc) excludes .bundled-cc-base and falls back to Tier 3 when unpacked standalone
    const slimOut = path.join(nextDir('release-slim-out'), 'cac-base-link-v1.0.0-slim.tar.gz');
    const rSlimRel = runNode(LINK_CLI, ['release', 'v1.0.0-slim', '--out', slimOut], { env: releaseEnv });
    assert.equal(rSlimRel.status, 0, `slim release failed: ${rSlimRel.stderr}\n${rSlimRel.stdout}`);
    const slimRelObj = JSON.parse(rSlimRel.stdout.trim());
    assert.equal(slimRelObj.status, 'ok');
    assert.equal(slimRelObj.bundledCcBase, false);
    assert.deepEqual(
      fs.readdirSync(releaseTmpSandbox).filter((n) => n.startsWith('cac-link-release-')),
      [],
      'slim release must clean up all cac-link-release-* staging dirs in TMPDIR finally block',
    );

    const slimUnpackParent = nextDir('isolated-slim-unpack');
    fs.mkdirSync(slimUnpackParent, { recursive: true });
    const untarSlim = spawnSync(tarCmd.bin, [...tarCmd.extraFlags, '-xzf', slimOut, '-C', slimUnpackParent], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    assert.equal(untarSlim.status, 0, untarSlim.stderr);

    const slimFwRoot = path.join(slimUnpackParent, 'cac-base-link-v1.0.0-slim');
    assert.equal(fs.existsSync(path.join(slimFwRoot, '.bundled-cc-base')), false);
    assert.equal(fs.existsSync(path.join(slimFwRoot, 'progress.md')), false);
    assert.equal(fs.existsSync(path.join(slimFwRoot, '.cac', 'skills')), false);

    // Unpacked slim repo in isolated folder (no ../cc-base, no CC_BASE_DIR):
    // - `--with-cc` fails with exit 2
    // - default install falls back cleanly to Tier 3 (`cc-source-not-found`)
    const slimCli = path.join(slimFwRoot, 'scripts', 'cac-base-link.mjs');
    const slimWithCcFail = runNode(slimCli, ['install', '--with-cc', '--target', nextDir('slim-withcc-fail')]);
    assert.equal(slimWithCcFail.status, 2, 'slim bundle without cc-base source must exit 2 when --with-cc is passed');

    const slimTier3Target = nextDir('slim-tier3-fallback');
    const rSlimTier3 = runNode(slimCli, ['install', '--target', slimTier3Target, '--json']);
    assert.equal(rSlimTier3.status, 0, rSlimTier3.stderr);
    const slimTier3Obj = JSON.parse(rSlimTier3.stdout.trim());
    assert.equal(slimTier3Obj.ccBase?.tier, 3);
    assert.equal(slimTier3Obj.ccBase?.action, 'deferred');
    assert.equal(slimTier3Obj.ccBase?.reason, 'cc-source-not-found');
    assert.equal(slimTier3Obj.pendingCcBase, true);

    // 2. Bundled offline release (`release v1.0.0-offline --bundle-cc <ccDir>`)
    const ccSrcForBundle = ensureCcSourceForBundle();
    const bundleOut = path.join(nextDir('release-bundle-out'), 'cac-base-link-v1.0.0-offline.tar.gz');
    const rBundleRel = runNode(
      LINK_CLI,
      [
        'release',
        'v1.0.0-offline',
        '--bundle-cc',
        ccSrcForBundle,
        '--out',
        bundleOut,
      ],
      { env: releaseEnv },
    );
    assert.equal(rBundleRel.status, 0, `bundled release failed: ${rBundleRel.stderr}\n${rBundleRel.stdout}`);
    const bundleRelObj = JSON.parse(rBundleRel.stdout.trim());
    assert.equal(bundleRelObj.status, 'ok');
    assert.equal(bundleRelObj.bundledCcBase, true);
    assert.deepEqual(
      fs.readdirSync(releaseTmpSandbox).filter((n) => n.startsWith('cac-link-release-')),
      [],
      'bundled release must clean up all cac-link-release-* staging dirs in TMPDIR finally block',
    );

    // Extract into an isolated parent directory with ZERO sibling ../cc-base
    const isolatedParent = nextDir('airgapped-unpack-zone');
    fs.mkdirSync(isolatedParent, { recursive: true });
    assert.equal(fs.existsSync(path.join(isolatedParent, 'cc-base')), false);

    const untarBundle = spawnSync(tarCmd.bin, [...tarCmd.extraFlags, '-xzf', bundleOut, '-C', isolatedParent], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    assert.equal(untarBundle.status, 0, untarBundle.stderr);

    const bundleFwRoot = path.join(isolatedParent, 'cac-base-link-v1.0.0-offline');
    assert.equal(fs.existsSync(path.join(bundleFwRoot, '.bundled-cc-base', '.claude', 'CLAUDE.md')), true);
    assert.equal(fs.existsSync(path.join(bundleFwRoot, '.bundled-cc-base', 'progress.md')), false, 'bundled cc-base must strip progress.md');
    assert.equal(fs.existsSync(path.join(bundleFwRoot, '.bundled-cc-base', '.claude', 'tests')), false, 'bundled cc-base must strip .claude/tests');

    // One-command offline install from unpacked bundle -> installs both .claude/ + .cac/ with source: "bundled"
    const offlineProj = nextDir('airgapped-downstream-proj');
    const bundleCli = path.join(bundleFwRoot, 'scripts', 'cac-base-link.mjs');
    const rOfflineInst = runNode(bundleCli, ['install', '--target', offlineProj, '--json'], {
      cwd: isolatedParent,
    });
    assert.equal(rOfflineInst.status, 0, `offline bundled install failed: ${rOfflineInst.stderr}`);
    const offlineObj = JSON.parse(rOfflineInst.stdout.trim());
    assert.equal(offlineObj.status, 'ok');
    assert.equal(offlineObj.ccBase?.tier, 2);
    assert.equal(offlineObj.ccBase?.action, 'auto-installed');
    assert.equal(offlineObj.ccBase?.source, 'bundled');
    assert.equal(offlineObj.pendingCcBase, false);

    assert.equal(fs.existsSync(path.join(offlineProj, '.claude', 'CLAUDE.md')), true);
    assert.equal(fs.lstatSync(path.join(offlineProj, '.cac', 'skills')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(offlineProj, '.cac', 'agents')).isSymbolicLink(), true);

    const rOfflineDoc = runNode(path.join(offlineProj, '.cac', 'scripts', 'doctor.mjs'), [offlineProj, '--json']);
    assert.equal(rOfflineDoc.status, 0, rOfflineDoc.stdout + rOfflineDoc.stderr);
    const offlineDocObj = JSON.parse(rOfflineDoc.stdout.trim());
    assert.equal(offlineDocObj.ok, true);
    assert.equal(offlineDocObj.detail.skillsCount, 22);
    assert.equal(offlineDocObj.detail.agentsCount, 8);
  });

  test('[Scenario 4 - Tier 3] --no-auto-cc (and CAC_LINK_NO_AUTO_CC=1) deferred shell install + SessionStart link self-healing', () => {
    const target = nextDir('tier3-deferred-selfheal');

    // 1a. Install cac-base-link with --no-auto-cc onto empty project -> Tier 3 deferred (`pendingCcBase: true`)
    const rInst = runNode(LINK_CLI, ['install', '--no-auto-cc', '--target', target, '--json']);
    assert.equal(rInst.status, 0, rInst.stderr);
    const instObj = JSON.parse(rInst.stdout.trim());
    assert.equal(instObj.status, 'ok');
    assert.equal(instObj.ccBase?.tier, 3);
    assert.equal(instObj.ccBase?.action, 'deferred');
    assert.equal(instObj.ccBase?.reason, 'no-auto-cc-flag');
    assert.equal(instObj.pendingCcBase, true);
    assert.equal(fs.existsSync(path.join(target, '.claude')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'skills')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'agents')), false);

    // 1b. CAC_LINK_NO_AUTO_CC=1 env var also triggers Tier 3 deferred (`no-auto-cc-env`)
    const envTarget = nextDir('tier3-deferred-env');
    const rEnvDeferred = runNode(LINK_CLI, ['install', '--target', envTarget, '--json'], {
      env: { CAC_LINK_NO_AUTO_CC: '1' },
    });
    assert.equal(rEnvDeferred.status, 0, rEnvDeferred.stderr);
    const envDefObj = JSON.parse(rEnvDeferred.stdout.trim());
    assert.equal(envDefObj.ccBase?.tier, 3);
    assert.equal(envDefObj.ccBase?.action, 'deferred');
    assert.equal(envDefObj.ccBase?.reason, 'no-auto-cc-env');
    assert.equal(envDefObj.pendingCcBase, true);

    // 2. Run cc-bridge.mjs session-start before .claude/ exists -> exit 0, single-line valid JSON warning
    const bridgeScript = path.join(target, '.cac', 'hooks', 'cc-bridge.mjs');
    const rSsBefore = runNode(bridgeScript, ['session-start'], {
      cwd: target,
      input: JSON.stringify({ cwd: target }),
      env: { CODEAGENT3_PROJECT_DIR: target },
    });
    assert.equal(rSsBefore.status, 0, rSsBefore.stderr);
    const linesBefore = rSsBefore.stdout.trim().split(/\r?\n/);
    assert.equal(linesBefore.length, 1, `session-start must output single-line JSON, got ${linesBefore.length} lines`);
    const parsedBefore = JSON.parse(linesBefore[0]);
    assert.equal(parsedBefore.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(parsedBefore.hookSpecificOutput.additionalContext, /\.claude\//);
    assert.match(parsedBefore.hookSpecificOutput.additionalContext, /当前项目启动快照/);

    // 3. Install real .claude/ (cc-base), then trigger cc-bridge.mjs session-start -> auto-creates OS links!
    installRealCcBase(target);
    const rSsAfter = runNode(bridgeScript, ['session-start'], {
      cwd: target,
      input: JSON.stringify({ cwd: target }),
      env: { CODEAGENT3_PROJECT_DIR: target },
    });
    assert.equal(rSsAfter.status, 0, rSsAfter.stderr);
    const linesAfter = rSsAfter.stdout.trim().split(/\r?\n/);
    assert.equal(linesAfter.length, 1);
    assert.equal(JSON.parse(linesAfter[0]).hookSpecificOutput.hookEventName, 'SessionStart');

    assert.equal(fs.lstatSync(path.join(target, '.cac', 'skills')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(target, '.cac', 'agents')).isSymbolicLink(), true);

    // 4. Downstream doctor confirms 22 skills and 8 agents are enumerated through healed links
    const rDoc = runNode(path.join(target, '.cac', 'scripts', 'doctor.mjs'), [target, '--json']);
    assert.equal(rDoc.status, 0, rDoc.stdout + rDoc.stderr);
    const docObj = JSON.parse(rDoc.stdout.trim());
    assert.equal(docObj.ok, true);
    assert.equal(docObj.detail.skillsCount, 22);
    assert.equal(docObj.detail.agentsCount, 8);
  });

  test('[Scenario 5] 3-way lossless upgrade: updates unmodified legacy file with .bak, preserves user-edited .cac/rules/AGENTS.md via .cac-link-new, and overwrites on --force', () => {
    const target = nextDir('three-way-upgrade');
    installRealCcBase(target);
    assert.equal(runNode(LINK_CLI, ['install', '--target', target]).status, 0);

    const doctorRel = '.cac/scripts/doctor.mjs';
    const doctorFull = path.join(target, doctorRel);
    const currentDoctorContent = fs.readFileSync(doctorFull, 'utf8');
    const legacyDoctorContent = '// Legacy v0.9 cac-base-link doctor (unmodified by user)\nprocess.exit(0);\n';
    fs.writeFileSync(doctorFull, legacyDoctorContent, 'utf8');

    const obsoleteRel = '.cac/hooks/legacy-bridge-helper.mjs';
    const obsoleteFull = path.join(target, obsoleteRel);
    const obsoleteContent = '// obsolete managed helper\n';
    fs.writeFileSync(obsoleteFull, obsoleteContent, 'utf8');

    const manifestPath = path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json');
    const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const docEntry = manifestObj.files.find((f) => f.path === doctorRel);
    assert.ok(docEntry);
    const legacyHash = lfSha256(legacyDoctorContent);
    docEntry.sha256 = legacyHash.sha256;
    docEntry.bytes = legacyHash.bytes;
    const obsHash = lfSha256(obsoleteContent);
    manifestObj.files.push({ path: obsoleteRel, sha256: obsHash.sha256, bytes: obsHash.bytes });
    fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');

    const agentsRel = '.cac/rules/AGENTS.md';
    const agentsFull = path.join(target, agentsRel);
    const frameworkAgentsContent = fs.readFileSync(agentsFull, 'utf8');
    const userCustomAgentsContent = `${frameworkAgentsContent}\n# Custom Team Bridge Supplement (DO NOT OVERWRITE)\n`;
    fs.writeFileSync(agentsFull, userCustomAgentsContent, 'utf8');

    const rUpg = runNode(LINK_CLI, ['upgrade', '--target', target, '--json']);
    assert.equal(rUpg.status, 0, rUpg.stderr);
    const upgObj = JSON.parse(rUpg.stdout.trim());
    assert.equal(upgObj.status, 'ok');
    assert.deepEqual(upgObj.conflicts, [agentsRel]);

    assert.equal(fs.readFileSync(doctorFull, 'utf8'), currentDoctorContent);
    assert.equal(fs.existsSync(`${doctorFull}.bak`), true);
    assert.equal(fs.readFileSync(`${doctorFull}.bak`, 'utf8'), legacyDoctorContent);
    assert.equal(fs.existsSync(obsoleteFull), false, 'unmodified obsolete managed file must be pruned');

    assert.equal(fs.readFileSync(agentsFull, 'utf8'), userCustomAgentsContent);
    const sidecarPath = `${agentsFull}.cac-link-new`;
    assert.equal(fs.existsSync(sidecarPath), true);
    assert.equal(fs.readFileSync(sidecarPath, 'utf8'), frameworkAgentsContent);

    fs.rmSync(sidecarPath, { force: true });
    const rForce = runNode(LINK_CLI, ['upgrade', '--force', '--target', target, '--json']);
    assert.equal(rForce.status, 0, rForce.stderr);
    assert.deepEqual(JSON.parse(rForce.stdout.trim()).conflicts, []);
    assert.equal(fs.readFileSync(agentsFull, 'utf8'), frameworkAgentsContent);
    assert.equal(fs.readFileSync(`${agentsFull}.bak`, 'utf8'), userCustomAgentsContent);
  });

  test('[Scenario 6 - F-01 RED-LOCK] anti-symlink penetration: protects .claude/ across .cac->.claude parent symlink, reverse .claude/skills->.cac/skills, dangling leaf symlinks, and live .cac/settings.json->.claude/settings.json', () => {
    // 1. Parent symlink `.cac -> .claude`: uninstall refuses (exit 2), install detaches `.cac` safely & leaves `.claude/` 100% byte-identical
    const tParent = nextDir('f01-parent-cac-sym');
    installRealCcBase(tParent);
    const claudeSnapParent = snapshotTreeRawSha256(path.join(tParent, '.claude'));
    createExplicitDirLink(path.join(tParent, '.cac'), path.join(tParent, '.claude'));

    const rUnParentRefuse = runNode(LINK_CLI, ['uninstall', '--target', tParent, '--json']);
    assert.equal(rUnParentRefuse.status, 2, 'non-force uninstall must refuse when .cac itself is a symlink');
    assert.equal(fs.lstatSync(path.join(tParent, '.cac')).isSymbolicLink(), true);
    assertSnapshotExact(claudeSnapParent, path.join(tParent, '.claude'), 'after refused uninstall on .cac->.claude');

    const rInstParent = runNode(LINK_CLI, ['install', '--target', tParent, '--json']);
    assert.equal(rInstParent.status, 0, `install over .cac->.claude symlink failed: ${rInstParent.stderr}`);
    assert.equal(fs.lstatSync(path.join(tParent, '.cac')).isSymbolicLink(), false, '.cac must become a real directory');
    assert.equal(fs.lstatSync(path.join(tParent, '.cac', 'skills')).isSymbolicLink(), true);
    assertSnapshotExact(claudeSnapParent, path.join(tParent, '.claude'), 'after install over .cac->.claude');

    // 2. Subdirectory symlinks `.cac/rules -> ../.claude/rules` and `.cac/.runtime -> ../.claude`
    const tSubSym = nextDir('f01-subdir-sym');
    installRealCcBase(tSubSym);
    const claudeSnapSub = snapshotTreeRawSha256(path.join(tSubSym, '.claude'));
    fs.mkdirSync(path.join(tSubSym, '.cac'), { recursive: true });
    createExplicitDirLink(path.join(tSubSym, '.cac', 'rules'), path.join(tSubSym, '.claude', 'rules'));
    createExplicitDirLink(path.join(tSubSym, '.cac', '.runtime'), path.join(tSubSym, '.claude'));

    const rInstSub = runNode(LINK_CLI, ['install', '--target', tSubSym, '--json']);
    assert.equal(rInstSub.status, 0, rInstSub.stderr);
    assert.equal(fs.lstatSync(path.join(tSubSym, '.cac', 'rules')).isSymbolicLink(), false);
    assertSnapshotExact(claudeSnapSub, path.join(tSubSym, '.claude'), 'after install over .cac/{rules,.runtime} symlinks');

    // 3. Reverse symlink `.claude/skills -> ../.cac/skills` (`same-realpath-as-target`): refuses to vacate physical `.cac/skills`!
    const tRev = nextDir('f01-reverse-skills-sym');
    installRealCcBase(tRev);
    const revCacSkills = path.join(tRev, '.cac', 'skills');
    const revClaudeSkills = path.join(tRev, '.claude', 'skills');
    fs.rmSync(revClaudeSkills, { recursive: true, force: true });
    const preciousSkillMd = path.join(revCacSkills, 'precious-only', 'SKILL.md');
    fs.mkdirSync(path.dirname(preciousSkillMd), { recursive: true });
    fs.writeFileSync(preciousSkillMd, '# Precious Reverse Skill (MUST NOT BE VACATED)\n', 'utf8');
    createExplicitDirLink(revClaudeSkills, revCacSkills);

    const rInstRev = runNode(LINK_CLI, ['install', '--force', '--target', tRev, '--json']);
    assert.notEqual(rInstRev.status, 0, 'reverse symlink .claude/skills -> .cac/skills must block migration');
    assert.equal(fs.lstatSync(revCacSkills).isSymbolicLink(), false, '.cac/skills physical dir must not be replaced');
    assert.equal(fs.existsSync(preciousSkillMd), true, 'precious skill inside .cac/skills must remain 100% intact');

    // Also verify runtime `ensureCcLinks` via `cc-bridge.mjs session-start` refuses to vacate reverse-linked `.cac/skills`
    fs.copyFileSync(path.join(REPO_ROOT, '.cac', 'hooks', 'cc-bridge.mjs'), path.join(tRev, '.cac', 'hooks-tmp.mjs'));
    fs.rmSync(path.join(tRev, '.cac', 'hooks-tmp.mjs'), { force: true });
    fs.cpSync(path.join(REPO_ROOT, '.cac', 'hooks'), path.join(tRev, '.cac', 'hooks'), { recursive: true });
    const rRevSession = runNode(path.join(tRev, '.cac', 'hooks', 'cc-bridge.mjs'), ['session-start'], {
      cwd: tRev,
      input: JSON.stringify({ cwd: tRev }),
      env: { CODEAGENT3_PROJECT_DIR: tRev },
    });
    assert.equal(rRevSession.status, 0);
    assert.equal(fs.lstatSync(revCacSkills).isSymbolicLink(), false);
    assert.equal(fs.existsSync(preciousSkillMd), true);

    // 4. Dangling leaf symlinks & live leaf symlink `.cac/settings.json -> ../.claude/settings.json`
    const tLeaf = nextDir('f01-leaf-symlinks');
    installRealCcBase(tLeaf);
    const claudeSnapLeaf = snapshotTreeRawSha256(path.join(tLeaf, '.claude'));
    const claudeSettingsPath = path.join(tLeaf, '.claude', 'settings.json');
    const claudeSettingsShaBefore = rawFileSha256(claudeSettingsPath);

    const dstSettings = path.join(tLeaf, '.cac', 'settings.json');
    const dstManifest = path.join(tLeaf, '.cac', 'FRAMEWORK-MANIFEST.json');
    fs.mkdirSync(path.join(tLeaf, '.cac'), { recursive: true });
    fs.symlinkSync(path.join(TMP_BASE, 'nonexistent-dangling-settings.json'), dstSettings, 'file');
    fs.symlinkSync(path.join(TMP_BASE, 'nonexistent-dangling-manifest.json'), dstManifest, 'file');

    // 4a. Dangling leaf symlinks are safely unlinked and replaced with regular files
    const rDangling = runNode(LINK_CLI, ['install', '--target', tLeaf, '--json']);
    assert.equal(rDangling.status, 0, `dangling leaf symlink install failed: ${rDangling.stderr}`);
    assert.equal(fs.lstatSync(dstSettings).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(dstSettings).isFile(), true);
    assert.equal(fs.lstatSync(dstManifest).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(dstManifest).isFile(), true);

    // 4b. Live leaf symlink `.cac/settings.json -> ../.claude/settings.json`
    fs.unlinkSync(dstSettings);
    const liveSymTarget = process.platform === 'win32' ? claudeSettingsPath : '../.claude/settings.json';
    fs.symlinkSync(liveSymTarget, dstSettings, 'file');

    // Without --force: treats live symlink as conflict, writes .cac-link-new, NEVER mutates .claude/settings.json
    const rLiveConflict = runNode(LINK_CLI, ['upgrade', '--target', tLeaf, '--json']);
    assert.equal(rLiveConflict.status, 0, rLiveConflict.stderr);
    const liveConflictObj = JSON.parse(rLiveConflict.stdout.trim());
    assert.ok(liveConflictObj.conflicts.includes('.cac/settings.json'));
    assert.equal(fs.existsSync(`${dstSettings}.cac-link-new`), true);
    assert.equal(rawFileSha256(claudeSettingsPath), claudeSettingsShaBefore, '.claude/settings.json must NEVER be mutated through symlink');

    // Non-force uninstall keeps live symlink in keptModified without touching .claude/settings.json
    const rLiveUnKeep = runNode(LINK_CLI, ['uninstall', '--target', tLeaf, '--json']);
    assert.equal(rLiveUnKeep.status, 0, rLiveUnKeep.stderr);
    assert.ok(JSON.parse(rLiveUnKeep.stdout.trim()).keptModified.includes('.cac/settings.json'));
    assert.equal(rawFileSha256(claudeSettingsPath), claudeSettingsShaBefore);

    // With --force: detaches symlink and writes independent regular .cac/settings.json while .claude/ stays 100% untouched!
    fs.rmSync(`${dstSettings}.cac-link-new`, { force: true });
    const rLiveForce = runNode(LINK_CLI, ['install', '--force', '--target', tLeaf, '--json']);
    assert.equal(rLiveForce.status, 0, rLiveForce.stderr);
    assert.equal(fs.lstatSync(dstSettings).isSymbolicLink(), false, '--force must detach symlink before writing .cac/settings.json');
    assert.equal(rawFileSha256(claudeSettingsPath), claudeSettingsShaBefore, '.claude/settings.json must remain byte-identical after --force');
    assertSnapshotExact(claudeSnapLeaf, path.join(tLeaf, '.claude'), 'after leaf symlink tests');
  });

  test('[Scenario 7 - F-06 RED-LOCK] external cwd zero-arg doctor.mjs --source-check & downstream selfRoot resolution + ~/.local/bin CLI discovery', () => {
    const extEmptyCwd = nextDir('f06-external-empty-cwd');
    fs.mkdirSync(extEmptyCwd, { recursive: true });

    // 1. Calling source repo's doctor.mjs --source-check with ZERO target args from external /tmp cwd -> resolves selfRoot & exits 0
    const rSrcDoc = runNode(DOCTOR_CLI, ['--source-check', '--json'], { cwd: extEmptyCwd });
    assert.equal(rSrcDoc.status, 0, `external cwd doctor.mjs --source-check failed: ${rSrcDoc.stderr}\n${rSrcDoc.stdout}`);
    const srcDocObj = JSON.parse(rSrcDoc.stdout.trim());
    assert.equal(srcDocObj.ok, true);
    assert.equal(srcDocObj.mode, 'source');
    assert.equal(fs.realpathSync.native(srcDocObj.detail.root), fs.realpathSync.native(REPO_ROOT));

    // 2. Calling downstream installed project's doctor.mjs with ZERO target args from external /tmp cwd -> resolves downstream selfRoot & exits 0
    const downProj = nextDir('f06-downstream-selfroot');
    installRealCcBase(downProj);
    assert.equal(runNode(LINK_CLI, ['install', '--target', downProj]).status, 0);

    const downDoctor = path.join(downProj, '.cac', 'scripts', 'doctor.mjs');
    const rDownDoc = runNode(downDoctor, ['--json'], { cwd: extEmptyCwd });
    assert.equal(rDownDoc.status, 0, `external cwd downstream doctor.mjs failed: ${rDownDoc.stderr}\n${rDownDoc.stdout}`);
    const downDocObj = JSON.parse(rDownDoc.stdout.trim());
    assert.equal(downDocObj.ok, true);
    assert.equal(downDocObj.mode, 'downstream');
    assert.equal(downDocObj.detail.skillsCount, 22);

    // 3. `~/.local/bin/codeagent` discovery when ~/.local/bin is NOT in PATH
    const fakeHome = nextDir('f06-fake-home');
    const localBin = path.join(fakeHome, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(localBin, 'codeagent.cmd'), '@echo off\r\necho codeagent 9.9.9-localbin\r\n', 'utf8');
    } else {
      const shBin = path.join(localBin, 'codeagent');
      fs.writeFileSync(
        shBin,
        `#!${process.execPath}\nprocess.stdout.write('codeagent 9.9.9-localbin\\n');\n`,
        { encoding: 'utf8', mode: 0o755 },
      );
    }
    const rCliProbe = runNode(DOCTOR_CLI, ['--source-check'], {
      cwd: extEmptyCwd,
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        PATH: path.dirname(process.execPath),
      },
    });
    assert.equal(rCliProbe.status, 0, rCliProbe.stderr);
    assert.match(rCliProbe.stdout, /CodeAgent CLI 可用（codeagent: codeagent 9\.9\.9-localbin）/);
  });

  test('[Scenario 8] project directory rename / relocation broken or stale-target link auto-repair via both upgrade and session-start', () => {
    const oldMovedDir = path.join(TMP_BASE, 'old-moved-path');
    const newProjDir = nextDir('relocated-proj');
    installRealCcBase(newProjDir);
    assert.equal(runNode(LINK_CLI, ['install', '--target', newProjDir]).status, 0);

    for (const name of ['skills', 'agents']) {
      const lp = path.join(newProjDir, '.cac', name);
      detachLinkSafe(lp);
      if (process.platform === 'win32') {
        fs.mkdirSync(path.join(oldMovedDir, '.claude', name), { recursive: true });
        createExplicitDirLink(lp, path.join(oldMovedDir, '.claude', name));
      } else {
        createExplicitDirLink(lp, path.join(oldMovedDir, '.claude', name));
      }
    }
    if (process.platform === 'win32') {
      fs.rmSync(oldMovedDir, { recursive: true, force: true });
    }

    assert.equal(runNode(DOCTOR_CLI, [newProjDir, '--json']).status, 1, 'doctor must detect dangling moved link');

    const rUpg = runNode(LINK_CLI, ['upgrade', '--target', newProjDir, '--json']);
    assert.equal(rUpg.status, 0, rUpg.stderr);
    for (const name of ['skills', 'agents']) {
      assert.equal(
        fs.realpathSync.native(path.join(newProjDir, '.cac', name)),
        fs.realpathSync.native(path.join(newProjDir, '.claude', name)),
      );
    }

    fs.mkdirSync(path.join(oldMovedDir, '.claude', 'skills', 'stale-only'), { recursive: true });
    fs.mkdirSync(path.join(oldMovedDir, '.claude', 'agents'), { recursive: true });
    const staleSentinel = path.join(oldMovedDir, '.claude', 'skills', 'stale-only', 'SKILL.md');
    fs.writeFileSync(staleSentinel, '# stale old folder skill\n', 'utf8');

    for (const name of ['skills', 'agents']) {
      const lp = path.join(newProjDir, '.cac', name);
      detachLinkSafe(lp);
      createExplicitDirLink(lp, path.join(oldMovedDir, '.claude', name));
    }

    const bridgeScript = path.join(newProjDir, '.cac', 'hooks', 'cc-bridge.mjs');
    const rHeal = runNode(bridgeScript, ['session-start'], {
      cwd: newProjDir,
      input: JSON.stringify({ cwd: newProjDir }),
      env: { CODEAGENT3_PROJECT_DIR: newProjDir },
    });
    assert.equal(rHeal.status, 0, rHeal.stderr);
    for (const name of ['skills', 'agents']) {
      assert.equal(
        fs.realpathSync.native(path.join(newProjDir, '.cac', name)),
        fs.realpathSync.native(path.join(newProjDir, '.claude', name)),
      );
    }
    assert.equal(fs.existsSync(staleSentinel), true, 'detaching stale link must never delete files in old directory');
  });

  test('[Scenario 9 - F-08 RED-LOCK] crash deadlock recovery: live PID rejection (exit 2), >10m timed-out lock takeover, dead PID file/dir lock recovery, symlink lock detach, and CAC_SETUP_FAIL_AFTER=2', () => {
    const target = nextDir('f08-lock-and-crash');
    installRealCcBase(target);

    const runtimeDir = path.join(target, '.cac', '.runtime');
    const lockPath = path.join(runtimeDir, 'install.lock');
    const markerPath = path.join(runtimeDir, 'install.marker');

    // 1. Fault injection CAC_SETUP_FAIL_AFTER=2 aborts mid-flight, releases lock, and writes interrupted marker
    const rFail = runNode(LINK_CLI, ['install', '--target', target], {
      env: { CAC_SETUP_FAIL_AFTER: '2' },
    });
    assert.equal(rFail.status, 1);
    assert.equal(fs.existsSync(lockPath), false, 'install.lock must be released in finally block');
    assert.equal(fs.existsSync(markerPath), true, 'interrupted install.marker must remain on disk');
    assert.equal(JSON.parse(fs.readFileSync(markerPath, 'utf8')).status, 'interrupted');

    // 2. Fresh live concurrent PID lock (process.pid) MUST be rejected with exit 2 without deleting live lock
    fs.mkdirSync(runtimeDir, { recursive: true });
    const liveLockPayload = JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n';
    fs.writeFileSync(lockPath, liveLockPayload, 'utf8');

    const rBlocked = runNode(LINK_CLI, ['install', '--target', target, '--json']);
    assert.equal(rBlocked.status, 2, 'fresh live PID lock must reject concurrent install with exit 2');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), liveLockPayload);

    // 3. Timed-out (>10m) lock held by a still-alive PID -> reclaimed cleanly!
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 11 * 60 * 1000 }) + '\n',
      'utf8',
    );
    const rTimedOutTakeover = runNode(LINK_CLI, ['install', '--target', target, '--json']);
    assert.equal(rTimedOutTakeover.status, 0, `timed-out lock takeover failed: ${rTimedOutTakeover.stderr}`);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(markerPath), false);

    // 4. Dead PID file lock + directory locks (`owner.json` and plain `pid` file) + symlink lock
    const deadPid = findDeadPid();
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, ts: Date.now() }) + '\n', 'utf8');
    assert.equal(runNode(LINK_CLI, ['upgrade', '--target', target, '--json']).status, 0);
    assert.equal(fs.existsSync(lockPath), false);

    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: deadPid, ts: Date.now() }), 'utf8');
    assert.equal(runNode(LINK_CLI, ['upgrade', '--target', target, '--json']).status, 0);
    assert.equal(fs.existsSync(lockPath), false);

    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'pid'), `${deadPid}\n`, 'utf8');
    assert.equal(runNode(LINK_CLI, ['upgrade', '--target', target, '--json']).status, 0);
    assert.equal(fs.existsSync(lockPath), false);

    const externalLockSentinel = path.join(TMP_BASE, 'external-lock-target.txt');
    fs.writeFileSync(externalLockSentinel, 'do-not-delete\n', 'utf8');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.symlinkSync(externalLockSentinel, lockPath, 'file');
    assert.equal(runNode(LINK_CLI, ['upgrade', '--target', target, '--json']).status, 0);
    assert.equal(fs.existsSync(externalLockSentinel), true, 'symlinked install.lock target must remain untouched');
  });

  test('[Scenario 10 - F-09 RED-LOCK] cross-engine engine:"cac-base" uninstall protection + bidirectional standalone cac-base <-> cac-base-link lossless round-trip', () => {
    // Part A: Synthetic cross-engine uninstall refusal (always runs regardless of sibling repos)
    const crossTarget = nextDir('f09-cross-engine-guard');
    fs.mkdirSync(path.join(crossTarget, '.cac', 'skills', 'standalone-skill'), { recursive: true });
    fs.mkdirSync(path.join(crossTarget, '.cac', 'agents'), { recursive: true });
    const standaloneSkillPath = path.join(crossTarget, '.cac', 'skills', 'standalone-skill', 'SKILL.md');
    fs.writeFileSync(standaloneSkillPath, '# Standalone Cac-Base Skill\n', 'utf8');
    const standaloneManifestPath = path.join(crossTarget, '.cac', 'FRAMEWORK-MANIFEST.json');
    fs.writeFileSync(
      standaloneManifestPath,
      JSON.stringify({ version: 1, engine: 'cac-base', seeded: [], files: [] }, null, 2) + '\n',
      'utf8',
    );

    const rCrossRefuse = runNode(LINK_CLI, ['uninstall', '--target', crossTarget, '--json']);
    assert.equal(rCrossRefuse.status, 2, 'uninstalling standalone engine:"cac-base" without --force must exit 2');
    const crossObj = JSON.parse(rCrossRefuse.stdout.trim());
    assert.match(String(crossObj.error || ''), /cac-base/);
    assert.equal(fs.existsSync(standaloneSkillPath), true);
    assert.equal(fs.existsSync(standaloneManifestPath), true);

    // Part B: Full real bidirectional cross-mode round-trip when sibling standalone cac-base is available
    if (!HAS_REAL_CAC_BASE) {
      assert.equal(process.env.GITHUB_ACTIONS, 'true', `Real sibling cac-base missing at ${CAC_STANDALONE_CLI}`);
      installRealCcBase(crossTarget);
      const rSynMig = runNode(LINK_CLI, ['install', '--target', crossTarget, '--json']);
      assert.equal(rSynMig.status, 0, rSynMig.stderr);
      assert.equal(fs.lstatSync(path.join(crossTarget, '.cac', 'skills')).isSymbolicLink(), true);
      return;
    }

    const target = nextDir('f09-cross-mode-roundtrip');
    installRealCcBase(target);
    const initialSkillsSnapshot = snapshotTreeRawSha256(path.join(target, '.claude', 'skills'));
    const initialAgentsSnapshot = snapshotTreeRawSha256(path.join(target, '.claude', 'agents'));
    const initialClaudeMdSha = rawFileSha256(path.join(target, '.claude', 'CLAUDE.md'));

    // Step 1: Install standalone real cac-base (--with-harness)
    const rStandalone1 = runNode(CAC_STANDALONE_CLI, ['install', '--target', target, '--with-harness', '--json']);
    assert.equal(rStandalone1.status, 0, `standalone cac-base install #1 failed: ${rStandalone1.stderr}`);
    assert.equal(fs.lstatSync(path.join(target, '.cac', 'skills')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(target, '.cac', 'agents')).isSymbolicLink(), false);

    // Verify F-09 cross-engine uninstall guard against real standalone cac-base!
    const rRefuseRealStandalone = runNode(LINK_CLI, ['uninstall', '--target', target, '--json']);
    assert.equal(rRefuseRealStandalone.status, 2, 'cac-base-link uninstall must refuse real standalone cac-base (exit 2)');
    assert.equal(fs.lstatSync(path.join(target, '.cac', 'skills')).isDirectory(), true);

    const customStandaloneSkill = path.join(target, '.cac', 'skills', 'team-private-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(customStandaloneSkill), { recursive: true });
    fs.writeFileSync(customStandaloneSkill, '# Team Private Standalone Skill\n', 'utf8');

    const customGuardScript = path.join(target, 'scripts', 'company-custom-guard.mjs');
    fs.mkdirSync(path.dirname(customGuardScript), { recursive: true });
    fs.writeFileSync(customGuardScript, 'process.exit(0);\n', 'utf8');

    const settingsPath = path.join(target, '.cac', 'settings.json');
    const stStandalone = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    stStandalone.permissions.deny.push('Read(secrets/corp-master.key)');
    stStandalone.hooks.PreToolUse[0].hooks.push({
      type: 'command',
      command: 'node scripts/company-custom-guard.mjs',
    });
    fs.writeFileSync(settingsPath, JSON.stringify(stStandalone, null, 2) + '\n', 'utf8');

    // Step 2: Overlay install cac-base-link onto standalone cac-base
    const rToLink = runNode(LINK_CLI, ['install', '--target', target, '--json']);
    assert.equal(rToLink.status, 0, `cac-base -> cac-base-link switch failed: ${rToLink.stderr}`);
    const toLinkObj = JSON.parse(rToLink.stdout.trim());
    assert.equal(toLinkObj.migratedPaths.length, 2);
    const skillsBackup = toLinkObj.migratedPaths.find((p) => p.endsWith('/skills'));
    assert.ok(skillsBackup && fs.existsSync(path.join(skillsBackup, 'team-private-skill', 'SKILL.md')));

    assert.equal(fs.lstatSync(path.join(target, '.cac', 'skills')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(target, '.cac', 'agents')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'harness', 'harness.mjs')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST-OPTIONAL.json')), false);
    assert.equal(runNode(path.join(target, '.cac', 'scripts', 'doctor.mjs'), [target, '--json']).status, 0);

    assertSnapshotExact(initialSkillsSnapshot, path.join(target, '.claude', 'skills'), 'after cac-base -> cac-base-link');
    assertSnapshotExact(initialAgentsSnapshot, path.join(target, '.claude', 'agents'), 'after cac-base -> cac-base-link');

    // Step 3: Reverse overlay install standalone cac-base onto cac-base-link!
    const rBackToStandalone = runNode(CAC_STANDALONE_CLI, ['install', '--target', target, '--json']);
    assert.equal(rBackToStandalone.status, 0, `cac-base-link -> cac-base reverse switch failed: ${rBackToStandalone.stderr}`);
    assert.equal(fs.lstatSync(path.join(target, '.cac', 'skills')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(target, '.cac', 'agents')).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'hooks', 'cc-bridge.mjs')), false);

    assertSnapshotExact(initialSkillsSnapshot, path.join(target, '.claude', 'skills'), 'after cac-base-link -> cac-base');
    assertSnapshotExact(initialAgentsSnapshot, path.join(target, '.claude', 'agents'), 'after cac-base-link -> cac-base');
    assert.equal(rawFileSha256(path.join(target, '.claude', 'CLAUDE.md')), initialClaudeMdSha);
    assert.equal(runNode(path.join(target, '.cac', 'scripts', 'doctor.mjs'), [target, '--json']).status, 0);

    // Step 4: Switch back to cac-base-link and run --uninstall --force -> verify .claude/ STILL 100% byte-identical!
    assert.equal(runNode(LINK_CLI, ['install', '--target', target, '--json']).status, 0);
    assert.equal(runNode(LINK_CLI, ['--uninstall', '--force', '--target', target, '--json']).status, 0);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'skills')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'agents')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json')), false);

    assertSnapshotExact(initialSkillsSnapshot, path.join(target, '.claude', 'skills'), 'after cac-base-link --uninstall --force');
    assertSnapshotExact(initialAgentsSnapshot, path.join(target, '.claude', 'agents'), 'after cac-base-link --uninstall --force');
    assert.equal(rawFileSha256(path.join(target, '.claude', 'CLAUDE.md')), initialClaudeMdSha);
  });

  test('safe uninstall: preserves user-edited .cac/rules/AGENTS.md on non-force uninstall, preserves private permissions.deny on --force, and keeps .claude/ 100% untouched', () => {
    const target = nextDir('safe-uninstall');
    installRealCcBase(target);
    const skillsSnap = snapshotTreeRawSha256(path.join(target, '.claude', 'skills'));
    const agentsSnap = snapshotTreeRawSha256(path.join(target, '.claude', 'agents'));

    assert.equal(runNode(LINK_CLI, ['install', '--target', target]).status, 0);

    const agentsPath = path.join(target, '.cac', 'rules', 'AGENTS.md');
    const customAgents = fs.readFileSync(agentsPath, 'utf8') + '\n# Keep custom note on non-force uninstall\n';
    fs.writeFileSync(agentsPath, customAgents, 'utf8');

    const settingsPath = path.join(target, '.cac', 'settings.json');
    const stObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    stObj.permissions.deny.push('Read(config/prod-private.pem)');
    fs.writeFileSync(settingsPath, JSON.stringify(stObj, null, 2) + '\n', 'utf8');

    const rUn1 = runNode(LINK_CLI, ['--uninstall', '--target', target, '--json']);
    assert.equal(rUn1.status, 0, rUn1.stderr);
    assert.ok(JSON.parse(rUn1.stdout.trim()).keptModified.includes('.cac/rules/AGENTS.md'));
    assert.equal(fs.existsSync(path.join(target, '.cac', 'skills')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'agents')), false);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), customAgents);

    assert.equal(runNode(LINK_CLI, ['install', '--force', '--target', target]).status, 0);
    const rUn2 = runNode(LINK_CLI, ['--uninstall', '--force', '--target', target, '--json']);
    assert.equal(rUn2.status, 0, rUn2.stderr);
    assert.equal(fs.existsSync(agentsPath), false);
    assert.equal(fs.existsSync(settingsPath), true);
    const keptSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(keptSettings.permissions.deny.includes('Read(config/prod-private.pem)'));
    assert.equal(keptSettings.hooks, undefined);

    assertSnapshotExact(skillsSnap, path.join(target, '.claude', 'skills'), 'after safe uninstall');
    assertSnapshotExact(agentsSnap, path.join(target, '.claude', 'agents'), 'after safe uninstall');
  });
});
