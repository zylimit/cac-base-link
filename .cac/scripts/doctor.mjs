#!/usr/bin/env node
// .cac/scripts/doctor.mjs — Dual-mode health & integrity checker for cac-base-link.
// - Mode A (`--source-check` or inside `cac-base-link` source repo): validates bridge repo integrity,
//   `.cac/rules/AGENTS.md` (zero YAML frontmatter + `@../../.claude/CLAUDE.md`), 12 hook registrations,
//   hook JS syntax, and `FRAMEWORK-MANIFEST.json` LF-SHA256 parity.
// - Mode B (downstream business project): validates all of the above PLUS `.claude/{CLAUDE.md,skills,agents,hooks}`
//   presence AND verifies `.cac/skills` & `.cac/agents` OS links resolve to `.claude/{skills,agents}` with exact
//   enumerated counts of `SKILL.md` skills and `agents/*.md` roles!
// Self-contained (Node >= 20 built-ins only). Supports `--json`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const EXPECTED_BRIDGE_ACTIONS = [
  'session-start',
  'user-prompt-submit',
  'pre-bash',
  'pre-skill',
  'pre-write',
  'pre-agent',
  'post-bash',
  'post-write',
  'pre-compact',
  'post-compact',
  'stop',
  'subagent-stop',
];

const CORE_BRIDGE_FILES = [
  '.cac/hooks/cc-bridge.mjs',
  '.cac/hooks/lib/root.mjs',
  '.cac/hooks/lib/ps-floor.mjs',
  '.cac/scripts/doctor.mjs',
];

const CODEAGENT_CANDIDATES = ['codeagent', 'codeAgentCLI', 'codeagentcli', 'cac'];
const MAN_MAX_NAMED = 20;

function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function hasYamlFrontmatterHeader(rawText) {
  const text = String(rawText ?? '').replace(/^\uFEFF/, '');
  return /^---(?:[ \t]*\r?\n|[ \t]*$)/.test(text);
}

function hashLfFile(fullPath) {
  const buf = fs.readFileSync(fullPath);
  let hasCr = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) {
      hasCr = true;
      break;
    }
  }
  let norm = buf;
  if (hasCr) {
    const tmp = Buffer.allocUnsafe(buf.length);
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0d) tmp[n++] = buf[i];
    }
    norm = tmp.subarray(0, n);
  }
  return createHash('sha256').update(norm).digest('hex');
}

function resolveRealOrNull(p) {
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

function sameRealDir(a, b) {
  const ra = resolveRealOrNull(a);
  const rb = resolveRealOrNull(b);
  if (!ra || !rb) return false;
  const pa = toPosix(ra).replace(/\/+$/, '') || '/';
  const pb = toPosix(rb).replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

function whichCmd(exe, extraDirs = []) {
  if (!exe) return null;
  if (exe.includes('/') || exe.includes('\\')) {
    return fs.existsSync(exe) ? exe : null;
  }
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const dirs = [...pathDirs, ...extraDirs.filter(Boolean)];
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map((s) => s.trim()).filter(Boolean)
    : [''];
  for (const d of dirs) {
    if (process.platform === 'win32') {
      const direct = path.join(d, exe);
      try {
        if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
      } catch {
        /* ignore */
      }
    }
    for (const ext of exts) {
      const cand = path.join(d, exe + ext);
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function extraCodeagentSearchDirs() {
  const out = [];
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (home) {
    out.push(path.join(home, '.local', 'bin'));
  }
  if (process.platform === 'win32') {
    if (process.env.USERPROFILE) {
      out.push(path.join(process.env.USERPROFILE, '.local', 'bin'));
    }
    const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
    if (localAppData) {
      out.push(path.join(localAppData, 'Programs', 'codeagent'));
      out.push(path.join(localAppData, 'Programs', 'codeagent', 'bin'));
    }
  }
  return [...new Set(out)];
}

function probeCliVersion(binPath) {
  try {
    let vr;
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binPath)) {
      const comspec =
        process.env.ComSpec ||
        process.env.COMSPEC ||
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      vr = spawnSync(comspec, ['/d', '/s', '/c', `""${binPath}" --version"`], {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
        encoding: 'utf8',
        timeout: 5000,
      });
    } else {
      vr = spawnSync(binPath, ['--version'], {
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5000,
      });
    }
    if (vr && !vr.error && vr.stdout) {
      return String(vr.stdout).trim().split(/\r?\n/)[0] || '';
    }
  } catch {
    /* ignore */
  }
  return '';
}

function resolveImplicitDoctorRoot(sourceCheck) {
  const cwd = process.cwd();
  const selfRoot = path.resolve(SCRIPT_DIR, '..', '..');
  if (sourceCheck && !fs.existsSync(path.join(cwd, 'scripts', 'cac-base-link.mjs'))) {
    return selfRoot;
  }
  if (!fs.existsSync(path.join(cwd, '.cac')) && fs.existsSync(path.join(selfRoot, '.cac'))) {
    return selfRoot;
  }
  return cwd;
}

function parseDoctorArgs(argv) {
  let jsonMode = false;
  let sourceCheck = false;
  let rootArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      jsonMode = true;
    } else if (a === '--source-check') {
      sourceCheck = true;
    } else if (a === '--root') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) {
        process.stderr.write('doctor: --root requires a directory path\n');
        process.exit(2);
      }
      rootArg = next;
    } else if (a.startsWith('--root=')) {
      rootArg = a.slice(7);
    } else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: node .cac/scripts/doctor.mjs [target-dir] [--root <dir>] [--source-check] [--json]\n');
      process.exit(0);
    } else if (a.startsWith('-')) {
      process.stderr.write(`doctor: unknown option: ${a}\n`);
      process.exit(2);
    } else if (rootArg === null) {
      rootArg = a;
    } else {
      process.stderr.write(`doctor: unexpected extra argument: ${a}\n`);
      process.exit(2);
    }
  }
  return {
    jsonMode,
    sourceCheck,
    explicitRoot: rootArg !== null,
    rootArg: rootArg !== null ? rootArg : '.',
  };
}

function inspectBridgeHookEntry(entry, root) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  let rawRef = '';
  let action = '';
  if (Array.isArray(entry.args) && entry.args.length >= 1 && /^["']?node(?:\.exe)?["']?$/i.test(String(entry.command || '').trim())) {
    rawRef = String(entry.args[0] || '').trim().replace(/^(['"])(.*)\1$/, '$2');
    action = String(entry.args[1] || '').trim();
  } else if (!('args' in entry) && typeof entry.command === 'string') {
    const m = /^["']?node(?:\.exe)?["']?\s+(?:"([^"]+\.mjs)"|'([^']+\.mjs)'|([^"'\s]+\.mjs))(?:\s+(\S+))?/i.exec(entry.command.trim());
    if (m) {
      rawRef = m[1] ?? m[2] ?? m[3] ?? '';
      action = String(m[4] || '').trim();
    }
  }
  if (!rawRef) return null;
  const expanded = rawRef
    .split('${CODEAGENT3_PROJECT_DIR}').join(root)
    .split('${CAC_PROJECT_DIR}').join(root);
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
  const isCcBridge = /(?:^|[/\\])\.cac[/\\]hooks[/\\]cc-bridge\.mjs$/i.test(rawRef);
  return { rawRef, resolved, isCcBridge, action };
}

function verifyManifestFile(root, relManifestPath, { ok, bad, note }) {
  const fullManifest = path.join(root, relManifestPath);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(fullManifest, 'utf8'));
  } catch (e) {
    bad(`FRAMEWORK-MANIFEST.json 不是合法 JSON（${e.message}）`);
    return;
  }
  if (!data || data.version !== 1 || data.engine !== 'cac-base-link' || !Array.isArray(data.files)) {
    bad('FRAMEWORK-MANIFEST.json 结构不合法（期望 version=1, engine="cac-base-link", files=[]）');
    return;
  }
  let checked = 0;
  let missing = 0;
  let mismatch = 0;
  for (const item of data.files) {
    if (!item || typeof item.path !== 'string' || typeof item.sha256 !== 'string') continue;
    const rel = toPosix(item.path);
    const full = path.join(root, rel);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) {
      missing++;
      if (missing <= MAN_MAX_NAMED) {
        bad(`FRAMEWORK-MANIFEST.json 缺件：${rel} 已登记但本地缺失（期望 ${item.sha256.slice(0, 8)}）`);
      }
      continue;
    }
    checked++;
    const actual = hashLfFile(full);
    if (actual !== item.sha256) {
      mismatch++;
      if (mismatch <= MAN_MAX_NAMED) {
        bad(`FRAMEWORK-MANIFEST.json 漂移/篡改：${rel} 期望 ${item.sha256.slice(0, 8)} 实际 ${actual.slice(0, 8)}`);
      }
    }
  }
  if (checked === 0 && missing === 0) {
    note('FRAMEWORK-MANIFEST.json 包含 0 条受管文件记录');
  } else if (mismatch === 0 && missing === 0) {
    ok(`FRAMEWORK-MANIFEST.json 全量比对 ${checked} 条 LF-SHA256 一致`);
  } else {
    if (mismatch > 0) bad(`FRAMEWORK-MANIFEST.json 全量比对 ${checked} 条，${mismatch} 条 LF-SHA256 不符`);
    if (missing > 0) bad(`FRAMEWORK-MANIFEST.json 另有 ${missing} 条登记文件在本地缺失`);
  }
}

export function runDoctor(rawTarget, { jsonMode = false, sourceCheck = false, explicitRoot } = {}) {
  const isExplicit = explicitRoot !== undefined
    ? Boolean(explicitRoot)
    : (rawTarget !== undefined && rawTarget !== null && rawTarget !== '');
  const effectiveTarget = isExplicit ? String(rawTarget) : resolveImplicitDoctorRoot(sourceCheck);

  const segs = String(effectiveTarget).split(/[\\/]+/);
  if (segs.includes('..')) {
    process.stderr.write(`doctor: 路径不安全（含 '..'）：${effectiveTarget}\n`);
    process.exit(2);
  }
  const root = path.resolve(effectiveTarget);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`doctor: 目标目录不存在：${effectiveTarget}\n`);
    process.exit(2);
  }

  const isSourceRepo =
    Boolean(sourceCheck) ||
    (fs.existsSync(path.join(root, 'scripts', 'cac-base-link.mjs')) &&
      fs.existsSync(path.join(root, 'setup.ps1')) &&
      !fs.existsSync(path.join(root, '.claude', 'CLAUDE.md')));

  const mode = isSourceRepo ? 'source' : 'downstream';
  const items = [];
  const errors = [];
  const warnings = [];
  let okCount = 0;
  let badCount = 0;
  let noteCount = 0;
  let skillsCount = 0;
  let agentsCount = 0;

  const ok = (msg) => {
    okCount++;
    items.push({ level: 'ok', message: msg });
    if (!jsonMode) process.stdout.write(`✓ ${msg}\n`);
  };
  const bad = (msg) => {
    badCount++;
    errors.push(msg);
    items.push({ level: 'bad', message: msg });
    if (!jsonMode) process.stderr.write(`✗ ${msg}\n`);
  };
  const note = (msg) => {
    noteCount++;
    warnings.push(msg);
    items.push({ level: 'note', message: msg });
    if (!jsonMode) process.stderr.write(`! ${msg}\n`);
  };

  // 1. Transaction marker check
  const markerPath = path.join(root, '.cac', '.runtime', 'install.marker');
  if (fs.existsSync(markerPath)) {
    let rawMarker = '';
    try {
      rawMarker = fs.readFileSync(markerPath, 'utf8');
    } catch {
      rawMarker = 'interrupted';
    }
    if (rawMarker.includes('interrupted')) {
      bad('上次安装未完成（.cac/.runtime/install.marker 状态为 interrupted）：请重跑 setup 补装');
    } else {
      note('存在 .cac/.runtime/install.marker（可能有安装进程正在执行）');
    }
  } else {
    ok('安装事务状态干净（无残留 install.marker）');
  }

  // 2. .cac/rules/AGENTS.md check (zero YAML frontmatter + @../../.claude/CLAUDE.md inline import)
  const agentsMdPath = path.join(root, '.cac', 'rules', 'AGENTS.md');
  if (fs.existsSync(agentsMdPath) && fs.statSync(agentsMdPath).isFile() && fs.statSync(agentsMdPath).size > 0) {
    const text = fs.readFileSync(agentsMdPath, 'utf8');
    if (hasYamlFrontmatterHeader(text)) {
      bad('.cac/rules/AGENTS.md 严禁包含 YAML frontmatter（必须保持无头纯 Markdown 以确保宿主启动自动注入）');
    } else if (!text.includes('@../../.claude/CLAUDE.md')) {
      bad('.cac/rules/AGENTS.md 缺少 @../../.claude/CLAUDE.md 内联桥接指令');
    } else {
      ok('.cac/rules/AGENTS.md 存在（无 YAML frontmatter，含 @../../.claude/CLAUDE.md 内联指令）');
    }
  } else {
    bad('.cac/rules/AGENTS.md 缺失或为空');
  }

  // 3. Bridge JS modules & syntax check
  let syntaxBad = 0;
  let checkedJs = 0;
  for (const rel of CORE_BRIDGE_FILES) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      bad(`${rel} 缺失`);
      continue;
    }
    checkedJs++;
    const r = spawnSync(process.execPath, ['--check', full], {
      cwd: root,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    });
    if (r.status !== 0) {
      syntaxBad++;
      bad(`语法校验失败：${rel}`);
    }
  }
  if (checkedJs === CORE_BRIDGE_FILES.length && syntaxBad === 0) {
    ok(`桥接核心脚本齐全且语法校验通过（共 ${checkedJs} 个 .mjs 文件）`);
  }

  // 4. .cac/settings.json & 12 bridge registrations check
  const settingsPath = path.join(root, '.cac', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    bad('.cac/settings.json 缺失');
  } else {
    let settingsObj = null;
    try {
      const clean = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
      settingsObj = JSON.parse(clean);
      ok('.cac/settings.json 是合法 JSON');
    } catch (e) {
      bad(`.cac/settings.json 不是合法 JSON（${e.message}）`);
    }
    if (settingsObj && typeof settingsObj === 'object') {
      const missingHooks = [];
      const foundActions = new Set();
      let checkedHooks = 0;
      for (const groups of Object.values(settingsObj.hooks || {})) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          for (const h of g && Array.isArray(g.hooks) ? g.hooks : []) {
            const ref = inspectBridgeHookEntry(h, root);
            if (!ref) continue;
            checkedHooks++;
            if (!fs.existsSync(ref.resolved) || !fs.statSync(ref.resolved).isFile()) {
              missingHooks.push(ref.rawRef);
            }
            if (ref.isCcBridge && ref.action) {
              foundActions.add(ref.action);
            }
          }
        }
      }
      if (missingHooks.length > 0) {
        bad(`settings.json 有注册 hook 指向不存在的脚本：${[...new Set(missingHooks)].join(', ')}`);
      }
      const missingActions = EXPECTED_BRIDGE_ACTIONS.filter((a) => !foundActions.has(a));
      if (missingActions.length > 0) {
        bad(`settings.json 缺少桥接动作注册（缺 ${missingActions.length} 项：${missingActions.join(', ')}）`);
      } else {
        ok(`settings.json 全部 ${EXPECTED_BRIDGE_ACTIONS.length} 条 cc-bridge 桥接动作注册齐全（总检查 ${checkedHooks} 条）`);
      }
    }
  }

  // 5. .cac/FRAMEWORK-MANIFEST.json parity check
  const manifestPath = path.join(root, '.cac', 'FRAMEWORK-MANIFEST.json');
  if (!fs.existsSync(manifestPath)) {
    bad('.cac/FRAMEWORK-MANIFEST.json 缺失');
  } else {
    verifyManifestFile(root, '.cac/FRAMEWORK-MANIFEST.json', { ok, bad, note });
  }

  // 6. Mode-specific checks
  if (mode === 'source') {
    const sourceRequired = [
      'cc-base-contract.json',
      'setup.ps1',
      'setup.sh',
      'scripts/cac-base-link.mjs',
      'scripts/lib/path-guard.mjs',
      'scripts/lib/link-manager.mjs',
      'scripts/lib/settings-merge.mjs',
      'scripts/lib/manifest.mjs',
      'scripts/lib/cc-dep.mjs',
    ];
    for (const rel of sourceRequired) {
      const fp = path.join(root, rel);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        if (process.platform !== 'win32' && rel.endsWith('.sh') && (fs.statSync(fp).mode & 0o111) === 0) {
          bad(`源仓组件 ${rel} 缺少可执行权限 (+x / 0755)，会导致 ./${rel} Permission denied`);
        } else {
          ok(`源仓组件 ${rel} 存在`);
        }
      } else {
        bad(`源仓组件 ${rel} 缺失`);
      }
    }
    const bundledCc = path.join(root, '.bundled-cc-base');
    if (fs.existsSync(bundledCc) && fs.statSync(bundledCc).isDirectory()) {
      if (fs.existsSync(path.join(bundledCc, '.claude', 'CLAUDE.md'))) {
        ok('离线合包目录 .bundled-cc-base/.claude/CLAUDE.md 存在');
      } else {
        bad('离线合包目录 .bundled-cc-base 缺少 .claude/CLAUDE.md');
      }
    }
  } else {
    // Mode B: Downstream cc-base (.claude/) + OS directory links verification
    const ccClaudeMd = path.join(root, '.claude', 'CLAUDE.md');
    const ccSkillsDir = path.join(root, '.claude', 'skills');
    const ccAgentsDir = path.join(root, '.claude', 'agents');
    const ccHooksDir = path.join(root, '.claude', 'hooks');

    if (fs.existsSync(ccClaudeMd) && fs.statSync(ccClaudeMd).isFile() && fs.statSync(ccClaudeMd).size > 0) {
      ok('.claude/CLAUDE.md 主控宪法存在');
    } else {
      bad('.claude/CLAUDE.md 缺失（尚未安装 cc-base 或安装不完整）');
    }

    for (const [label, dirPath] of [
      ['.claude/skills', ccSkillsDir],
      ['.claude/agents', ccAgentsDir],
      ['.claude/hooks', ccHooksDir],
    ]) {
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        ok(`${label} 目录存在`);
      } else {
        bad(`${label} 目录缺失`);
      }
    }

    // Verify .cac/skills -> .claude/skills link & enumerate SKILL.md count
    const cacSkillsLink = path.join(root, '.cac', 'skills');
    let skillsLst = null;
    try {
      skillsLst = fs.lstatSync(cacSkillsLink);
    } catch {
      skillsLst = null;
    }
    if (!skillsLst) {
      bad('.cac/skills 联接不存在（请重跑 setup 或触发 SessionStart 自动修复）');
    } else if (!skillsLst.isSymbolicLink()) {
      bad('.cac/skills 是实体目录而非符号链接/Junction（请重跑 setup 自动迁移为桥接链接）');
    } else if (!fs.existsSync(ccSkillsDir) || !sameRealDir(cacSkillsLink, ccSkillsDir)) {
      bad('.cac/skills 链接损坏或未指向当前项目的 .claude/skills');
    } else {
      const skillDirs = fs.readdirSync(cacSkillsLink, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      for (const s of skillDirs) {
        const skMd = path.join(cacSkillsLink, s, 'SKILL.md');
        if (fs.existsSync(skMd) && fs.statSync(skMd).size > 0) skillsCount++;
      }
      if (skillsCount === 0) {
        bad('.cac/skills 已链接至 .claude/skills，但未枚举到任何非空 SKILL.md');
      } else {
        ok(`.cac/skills -> .claude/skills 联接正常（可枚举 ${skillsCount} 套技能 SKILL.md）`);
      }
    }

    // Verify .cac/agents -> .claude/agents link & enumerate agents/*.md count
    const cacAgentsLink = path.join(root, '.cac', 'agents');
    let agentsLst = null;
    try {
      agentsLst = fs.lstatSync(cacAgentsLink);
    } catch {
      agentsLst = null;
    }
    if (!agentsLst) {
      bad('.cac/agents 联接不存在（请重跑 setup 或触发 SessionStart 自动修复）');
    } else if (!agentsLst.isSymbolicLink()) {
      bad('.cac/agents 是实体目录而非符号链接/Junction（请重跑 setup 自动迁移为桥接链接）');
    } else if (!fs.existsSync(ccAgentsDir) || !sameRealDir(cacAgentsLink, ccAgentsDir)) {
      bad('.cac/agents 链接损坏或未指向当前项目的 .claude/agents');
    } else {
      const roleFiles = fs.readdirSync(cacAgentsLink, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      for (const rf of roleFiles) {
        if (fs.statSync(path.join(cacAgentsLink, rf)).size > 0) agentsCount++;
      }
      if (agentsCount === 0) {
        bad('.cac/agents 已链接至 .claude/agents，但未枚举到任何非空角色定义 *.md');
      } else {
        ok(`.cac/agents -> .claude/agents 联接正常（可枚举 ${agentsCount} 个角色 agents/*.md）`);
      }
    }
  }

  // 7. Runtime checks (node >= 20, git, codeagent CLI)
  const nodeMajor = parseInt(String(process.versions.node || '0').split('.')[0], 10);
  if (Number.isInteger(nodeMajor) && nodeMajor >= 20) {
    ok(`node 运行时可用（${process.version} >= v20）`);
  } else {
    bad(`node 版本过低（当前 ${process.version}，要求 >= v20.0.0）`);
  }

  if (whichCmd('git')) {
    ok('git 可用');
  } else {
    note('未检测到 git；git 相关治理与提交钩子能力受限');
  }

  let foundCliName = null;
  let foundCliVer = '';
  const extraCliDirs = extraCodeagentSearchDirs();
  for (const cand of CODEAGENT_CANDIDATES) {
    const bin = whichCmd(cand, extraCliDirs);
    if (bin) {
      foundCliName = cand;
      foundCliVer = probeCliVersion(bin);
      break;
    }
  }
  if (foundCliName) {
    ok(`CodeAgent CLI 可用（${foundCliName}${foundCliVer ? ': ' + foundCliVer : ''}）`);
  } else {
    note('未检测到 codeagent CLI（按序探测 codeagent / codeAgentCLI / codeagentcli / cac）；仅提示不判红');
  }

  const code = badCount > 0 ? 1 : 0;
  const status = badCount > 0 ? 'violation' : 'ok';
  const summary = badCount > 0
    ? `doctor(${mode}): 自检失败（${badCount} 项错误，${noteCount} 项提示）`
    : noteCount > 0
      ? `doctor(${mode}): 通过（${okCount} 项正常，有 ${noteCount} 项告警提示）`
      : `doctor(${mode}): 通过（${okCount} 项全部正常）`;

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        status,
        code,
        ok: code === 0,
        mode,
        summary,
        detail: {
          root: toPosix(root),
          mode,
          counts: { ok: okCount, bad: badCount, note: noteCount },
          skillsCount,
          agentsCount,
          errors,
          warnings,
        },
      }) + '\n',
    );
  } else {
    process.stdout.write(`${summary}\n`);
  }

  return code;
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  const { jsonMode, sourceCheck, explicitRoot, rootArg } = parseDoctorArgs(process.argv.slice(2));
  const exitCode = runDoctor(explicitRoot ? rootArg : undefined, { jsonMode, sourceCheck, explicitRoot });
  process.exit(exitCode);
}
