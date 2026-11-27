#!/usr/bin/env node
// .cac/hooks/cc-bridge.mjs — Unified single-source-of-truth hook dispatcher bridging `.cac/` (CodeAgent CLI)
// to `.claude/hooks/*.mjs` (cc-base) on Windows PowerShell, WSL, Linux, and macOS.
// Zero npm dependencies; all subprocesses use `shell: false` and `windowsHide: true`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ensureCcLinks,
  git,
  gitStateOf,
  parseEventJson,
  projectDir,
  readStdinRaw,
  readTextFile,
  subagentIdOf,
  toPosix,
} from './lib/root.mjs';
import {
  checkDangerousCommand,
  checkSecretExfil,
  isSafePowerShellEnvCommand,
} from './lib/ps-floor.mjs';

const WRITER_SUBAGENTS = new Set(['implementer', 'tester']);
const EXEC_ROLES = new Set(['implementer', 'code-reviewer', 'tester', 'deployer']);
const EXEMPT_ROLES = new Set([
  'researcher',
  'impact-analyst',
  'evolution-runner',
  'feedback-observer',
  'progress-recorder',
  'domain-recorder',
]);

const HIDDEN_ADAPTER_DIR_RE = /^\.(?:claude|cac|agents|cursor)(?:\/|$)/i;
const WRITE_EXEMPT_RE = /^(?:\.(?:claude|cac|agents|cursor)\/|domain\/|docs\/|AGENTS\.md$|CLAUDE\.md$|Product-Spec|DEV-PLAN|progress(?:\.archive)?\.md$|CHANGELOG)|\.(?:md|json|toml|sh|ps1)$/i;
const WRITE_SOURCE_RE = /(?:^|\/)(?:src|app|lib|components|pages|api|server|client|utils|models|services)\//;

const STATUS_FOUR_RE = /(?:^|\n)[\s>*+-]*\**\s*(?:Status|状态)\s*\**\s*[:：]\s*`?\**\s*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)\b/i;
const TESTER_VERDICT_RE = /(?:^|\n)[\s>*+-]*\**\s*(?:Status|状态|Verdict|测试结论|结论)\s*\**\s*[:：]\s*`?\**\s*(PASS|FAIL)\b/i;
const EVIDENCE_RE = /(?:^|\n)[\s>*+-]*\**\s*(?:Evidence|证据)\s*\**\s*[:：]/i;

const RELEASE_CTX = '发布前置卡点提醒（release-gate 注入）：① 打包前必过测试卡点——test-builder 全量跑，报绿须附运行清单（跑了哪些文件、各自结果），证据=运行器真实输出；② fast 档绝不豁免发布卡点；③ 部署完成后主 Agent 必须独立核查部署三件套（容器/构建时间戳+镜像 tag / 健康检查端点 / live 冒烟），绝不盲信 deployer 自报。';

const IGNORED_TOP_ENTRIES = new Set(['node_modules', 'Thumbs.db', 'desktop.ini']);
const FAST_MAX_SECONDS = 8 * 3600;
const TDD_MARK_TTL_MS = 2 * 3600 * 1000;
const GIT_COMMIT_CMD_RE = /(?:^|[\s;&|(){}])git(?:\.exe)?(?:\s+-\S+(?:\s+\S+)?)*\s+commit(?:\s|$)/i;

function emit(obj) {
  fs.writeSync(1, JSON.stringify(obj) + '\n');
}

function say(text) {
  fs.writeSync(2, String(text) + '\n');
}

function emitContext(hookEventName, additionalContext, extraTopLevel = {}) {
  emit({
    ...extraTopLevel,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: String(additionalContext),
    },
  });
}

function pendingReviewFiles(root) {
  const r = readTextFile(path.join(root, '.claude', '.needs-review'));
  return String(r.text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && l !== 'clean');
}

function appendGateBlockLog(root, hookName, reason) {
  try {
    if (!root) return;
    const firstLine = String(reason ?? '').split(/\r?\n/)[0];
    const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const line = `${ts}\t${hookName || 'cc-bridge'}\t${firstLine}\n`;

    const claudeDir = path.join(root, '.claude');
    if (fs.existsSync(claudeDir) && fs.statSync(claudeDir).isDirectory()) {
      for (const sub of ['.runtime', 'evidence']) {
        const dir = path.join(claudeDir, sub);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'gate-block.log'), line, 'utf8');
      }
    } else {
      const cacRuntime = path.join(root, '.cac', '.runtime');
      fs.mkdirSync(cacRuntime, { recursive: true });
      fs.appendFileSync(path.join(cacRuntime, 'gate-block.log'), line, 'utf8');
    }
  } catch {
    /* sidecar log failure never alters gate decision */
  }
}

function buildStartupSnapshot(root) {
  const yn = (rel) => (fs.existsSync(path.join(root, rel)) ? '已存在' : '未创建');
  const readable = fs.existsSync(path.join(root, 'docs', 'readable', 'index.html')) ? '已生成' : '未初始化';

  let visible = [];
  try {
    visible = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && !IGNORED_TOP_ENTRIES.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch {
    visible = [];
  }

  const topDesc = visible.length === 0
    ? '空（仅含隐藏治理目录 .claude/ 与 .cac/，尚未创建业务代码与文档）'
    : visible.slice(0, 8).join('、') + (visible.length > 8 ? ` 等共 ${visible.length} 项` : '');

  return [
    '📍 当前项目启动快照（SessionStart 已实查，首轮打招呼/问路请直接据此秒回，无需再调 Bash/ls/Glob 探测目录）：',
    `- Product-Spec: ${yn('Product-Spec.md')} | Design-Brief: ${yn('Design-Brief.md')} | DEV-PLAN: ${yn('DEV-PLAN.md')} | progress.md: ${yn('progress.md')} | 人读文档: ${readable}`,
    `- 顶层可见业务项: ${topDesc}`,
  ].join('\n');
}

function resolveRealOrSelf(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }
}

function resolveRealWithAncestors(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch {
      try {
        const realFallback = fs.realpathSync(cur);
        return tail.length > 0 ? path.join(realFallback, ...tail) : realFallback;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return abs;
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
}

function computeGitCeiling(root, existingCeiling = '') {
  const candidates = [];
  const realParent = path.dirname(resolveRealOrSelf(root));
  const lexParent = path.dirname(path.resolve(root));
  if (realParent) candidates.push(realParent);
  if (lexParent && lexParent !== realParent) candidates.push(lexParent);

  const parts = String(existingCeiling || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const cand of candidates) {
    const exists = parts.some((p) =>
      process.platform === 'win32' ? p.toLowerCase() === cand.toLowerCase() : p === cand,
    );
    if (!exists) parts.push(cand);
  }
  return parts.join(path.delimiter);
}

function buildChildEnv(root, gs) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: root,
  };
  // Prevent cc-base hooks from escaping up to an unowned parent directory's `.git`
  if (gs && gs.inGit && !gs.ownRepo && !gs.trackedSubdir) {
    env.GIT_CEILING_DIRECTORIES = computeGitCeiling(root, env.GIT_CEILING_DIRECTORIES);
  }
  return env;
}

function invokeCcHook(root, hookFile, rawStdin, gs = null) {
  const scriptPath = path.join(root, '.claude', 'hooks', hookFile);
  if (!fs.existsSync(scriptPath)) {
    return { missing: true, status: 0, stdout: '', stderr: '' };
  }
  const r = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    input: rawStdin,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    env: buildChildEnv(root, gs),
  });
  return {
    missing: false,
    status: r.status === null || r.status === undefined ? 1 : r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    error: r.error || null,
  };
}

function parseJsonLines(stdout) {
  const objs = [];
  const rawLines = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') {
        objs.push(parsed);
        continue;
      }
    } catch {
      // keep raw text fallback
    }
    rawLines.push(t);
  }
  return { objs, rawLines };
}

function extractAdditionalContexts(stdout) {
  const { objs, rawLines } = parseJsonLines(stdout);
  const parts = [];
  for (const obj of objs) {
    const nested = obj?.hookSpecificOutput?.additionalContext;
    if (typeof nested === 'string' && nested.trim()) {
      parts.push(nested.trim());
    } else if (typeof obj.additionalContext === 'string' && obj.additionalContext.trim()) {
      parts.push(obj.additionalContext.trim());
    }
  }
  for (const rl of rawLines) parts.push(rl);
  return parts;
}

function hasBlockingJson(stdout) {
  const { objs } = parseJsonLines(stdout);
  for (const obj of objs) {
    if (obj.decision === 'block') return true;
    if (obj?.hookSpecificOutput?.permissionDecision === 'deny') return true;
  }
  return false;
}

function toFiniteEpoch(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : NaN;
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

async function resolveClaudeTierAndMode(root, hookId = '') {
  const tierModPath = path.join(root, '.claude', 'hooks', 'lib', 'tier.mjs');
  if (fs.existsSync(tierModPath)) {
    try {
      process.env.CLAUDE_PROJECT_DIR = root;
      const m = await import(pathToFileURL(tierModPath).href);
      const eff = m.effectiveTier({ projectDir: root });
      const mode = hookId ? m.gateMode(hookId, { projectDir: root }) : 'block';
      return { tier: eff?.tier || 'standard', mode };
    } catch {
      // Fallback below
    }
  }

  // Lightweight fallback reading .claude/.runtime/tier.json directly (aligned with cc-base tier.mjs 8h cap)
  const tierFile = path.join(root, '.claude', '.runtime', 'tier.json');
  const r = readTextFile(tierFile);
  if (r.text) {
    try {
      const v = JSON.parse(r.text.replace(/\r/g, ''));
      const nowSec = Math.floor(Date.now() / 1000);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (
          v.tier === 'fast' &&
          v.sticky === true &&
          v.expires_epoch === null &&
          Number.isFinite(toFiniteEpoch(v.set_epoch)) &&
          typeof v.reason === 'string' &&
          v.reason.trim() !== ''
        ) {
          return { tier: 'fast', mode: 'advise' };
        }
        if (v.tier === 'fast') {
          const setAt = toFiniteEpoch(v.set_epoch);
          const rawExp = toFiniteEpoch(v.expires_epoch);
          if (Number.isFinite(setAt) && Number.isFinite(rawExp)) {
            const cappedExp = Math.min(rawExp, Math.min(setAt, nowSec) + FAST_MAX_SECONDS);
            if (nowSec < cappedExp) {
              return { tier: 'fast', mode: 'advise' };
            }
          }
          return { tier: 'standard', mode: 'block' };
        }
        if (v.tier === 'standard' || v.tier === 'strict') {
          if (v.expires_epoch === null || v.expires_epoch === undefined) {
            return { tier: v.tier, mode: 'block' };
          }
          const exp = toFiniteEpoch(v.expires_epoch);
          if (Number.isFinite(exp) && nowSec < exp) {
            return { tier: v.tier, mode: 'block' };
          }
        }
      }
    } catch {
      /* ignore corrupt tier.json */
    }
  }
  return { tier: 'standard', mode: 'block' };
}

function resolveWriteRelPath(rawPath, root) {
  const posixRaw = toPosix(rawPath).trim();
  if (!posixRaw) return { relPath: '', insideRoot: false };

  const isWinAbs = /^[A-Za-z]:\//.test(posixRaw);
  const isPosixAbs = posixRaw.startsWith('/');

  if (isPosixAbs || isWinAbs) {
    const caseInsensitive = process.platform === 'win32' || isWinAbs;
    const foldedAbs = isWinAbs
      ? posixRaw.slice(0, 2) + path.posix.normalize(posixRaw.slice(2))
      : path.posix.normalize(posixRaw);

    const rootCandidates = [];
    const pushRootCandidate = (p) => {
      if (!p) return;
      const norm = toPosix(p).replace(/\/+$/, '');
      if (!norm) return;
      const dup = rootCandidates.some((c) =>
        caseInsensitive ? c.toLowerCase() === norm.toLowerCase() : c === norm,
      );
      if (!dup) rootCandidates.push(norm);
    };
    pushRootCandidate(path.resolve(root));
    pushRootCandidate(resolveRealOrSelf(root));

    const matchAgainstCandidates = (targetPosix) => {
      for (const cand of rootCandidates) {
        const cmpRoot = caseInsensitive ? cand.toLowerCase() : cand;
        const cmpTarget = caseInsensitive ? targetPosix.toLowerCase() : targetPosix;
        if (cmpTarget === cmpRoot) return { relPath: '.', insideRoot: true };
        if (cmpTarget.startsWith(`${cmpRoot}/`)) {
          return { relPath: targetPosix.slice(cand.length + 1), insideRoot: true };
        }
      }
      return null;
    };

    const directHit = matchAgainstCandidates(foldedAbs);
    if (directHit) return directHit;

    // Secondary realpath check (handles Windows 8.3 short names & symlinked parent workspaces)
    if ((process.platform === 'win32' && isWinAbs) || (process.platform !== 'win32' && isPosixAbs)) {
      const realTargetPosix = toPosix(resolveRealWithAncestors(rawPath));
      const realHit = matchAgainstCandidates(realTargetPosix);
      if (realHit) return realHit;
    }

    return { relPath: foldedAbs, insideRoot: false };
  }

  const foldedRel = path.posix.normalize(posixRaw).replace(/^(?:\.\/)+/, '');
  if (foldedRel === '..' || foldedRel.startsWith('../')) {
    return { relPath: foldedRel, insideRoot: false };
  }
  return { relPath: foldedRel, insideRoot: true };
}

function findTsconfig(startRoot) {
  let level = [startRoot];
  for (let depth = 0; depth <= 3 && level.length > 0; depth += 1) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name === 'tsconfig.json') return path.join(dir, e.name);
      }
      for (const e of entries) {
        if (
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          e.name !== 'node_modules' &&
          e.name !== '.next' &&
          e.name !== '.git'
        ) {
          next.push(path.join(dir, e.name));
        }
      }
    }
    level = next;
  }
  return null;
}

function findLocalTscJs(tsconfigDir, root, topLevel) {
  const stopDir = path.resolve(topLevel || root);
  const stopCmp = process.platform === 'win32' ? stopDir.toLowerCase() : stopDir;
  let cur = path.resolve(tsconfigDir);
  for (;;) {
    const cand = path.join(cur, 'node_modules', 'typescript', 'bin', 'tsc');
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    } catch {
      /* ignore */
    }
    const curCmp = process.platform === 'win32' ? cur.toLowerCase() : cur;
    if (curCmp === stopCmp) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function isFreshTddMark(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && Date.now() - st.mtimeMs <= TDD_MARK_TTL_MS;
  } catch {
    return false;
  }
}

function validateEnvelope(text, role) {
  const s = String(text || '');
  const hasFourState = STATUS_FOUR_RE.test(s);
  const hasTesterPassFail = role === 'tester' && TESTER_VERDICT_RE.test(s);
  const hasStatus = hasFourState || hasTesterPassFail;
  const hasEvidence = EVIDENCE_RE.test(s);
  const missing = [];
  if (!hasStatus) {
    missing.push(role === 'tester' ? 'Status(四态或PASS/FAIL)' : 'Status(DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED)');
  }
  if (!hasEvidence) missing.push('Evidence');
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

function handleSessionStart(root, ev, rawStdin, hasCcHooks, gs) {
  const sections = [];

  if (fs.existsSync(path.join(root, '.cac', '.runtime', 'install.marker'))) {
    sections.push('⚠️ 上次 cac-base-link 安装未完成（存在 .cac/.runtime/install.marker）：请重跑 setup.ps1 或 setup.sh 补装。');
  }

  // 1. Auto-create or self-heal .cac/skills & .cac/agents links BEFORE checking hasCcHooks
  ensureCcLinks(root);

  if (!hasCcHooks) {
    sections.push('⚠️ 检测到当前目录尚未安装 cc-base（缺失 .claude/），cac-base-link 桥接目标不存在，请先安装 cc-base。');
    sections.push(buildStartupSnapshot(root));
    emitContext('SessionStart', sections.join('\n\n'));
    return;
  }

  // 2. Invoke check-evolution.mjs & session-rules-banner.mjs
  for (const hookName of ['check-evolution.mjs', 'session-rules-banner.mjs']) {
    const r = invokeCcHook(root, hookName, rawStdin, gs);
    if (r.stderr.trim()) say(r.stderr.trimEnd());
    sections.push(...extractAdditionalContexts(r.stdout));
  }

  // 3. Git worktree recap vs unowned parent `.git` boundary notice
  if (gs.ownRepo || gs.trackedSubdir) {
    const r = invokeCcHook(root, 'recap-on-dirty.mjs', rawStdin, gs);
    if (r.stderr.trim()) say(r.stderr.trimEnd());
    sections.push(...extractAdditionalContexts(r.stdout));
  } else if (gs.inGit && !gs.ownRepo && !gs.trackedSubdir) {
    sections.push(
      'ℹ️ Git 边界提示：当前项目目录尚未独立执行 git init（检测到外层父目录存在 Git 仓库）。后续如需提交代码，请先在当前目录运行 git init（或确认是否为子目录模式），严禁越界暂存或操作外层父目录的其他项目。',
    );
  }

  // 4. Millisecond startup snapshot
  const source = ev ? String(ev.source || '') : '';
  if (source !== 'compact') {
    sections.push(buildStartupSnapshot(root));
  }

  if (sections.length > 0) {
    emitContext('SessionStart', sections.join('\n\n'));
  }
}

function handleUserPromptSubmit(root, ev, rawStdin, hasCcHooks, gs) {
  const prompt = ev && typeof ev.prompt === 'string' ? ev.prompt : '';

  if (/^\s*\/release-builder(?:\s|$)/.test(prompt)) {
    const pending = pendingReviewFiles(root);
    if (pending.length > 0) {
      const reason = `发布前置闸：待审清单未清（${pending.length} 个文件待 code review：${pending.join('、')}）。先完成 review→fix 闭环（通过后 echo clean > .claude/.needs-review），再执行 /release-builder。`;
      appendGateBlockLog(root, 'release-gate', reason);
      emit({ decision: 'block', reason });
      return;
    }
    emitContext('UserPromptSubmit', RELEASE_CTX);
    return;
  }

  if (!hasCcHooks) return;
  const r = invokeCcHook(root, 'detect-feedback-signal.mjs', rawStdin, gs);
  if (r.stderr.trim()) say(r.stderr.trimEnd());
  if (!r.stdout.trim()) return;

  const { objs } = parseJsonLines(r.stdout);
  if (objs.length > 0) {
    const first = objs[0];
    if (first.decision === 'block') {
      emit(first);
      return;
    }
    const ctx = first?.hookSpecificOutput?.additionalContext || first.additionalContext || '';
    if (ctx) {
      const extra = {};
      if (first.systemMessage) extra.systemMessage = first.systemMessage;
      emitContext('UserPromptSubmit', ctx, extra);
      return;
    }
    emit(first);
  }
}

async function handlePreBash(root, ev, rawStdin, hasCcHooks, gs) {
  if (rawStdin.trim() && ev === null) {
    const why = `stdin 非空但无法解析为合法 JSON（${Buffer.byteLength(rawStdin, 'utf8')} 字节，疑似截断），安全地板闸阻断`;
    say(`⛔ [secret-exfil-guard] ${why}，已拦截。`);
    appendGateBlockLog(root, 'secret-exfil-guard', why);
    process.exitCode = 2;
    return;
  }

  const cmd = ev && ev.tool_input ? String(ev.tool_input.command || '') : '';
  if (!cmd) return;

  // 1. Unconditional dual-shell safety floor (runs even when `.claude/` is missing!)
  const dangerHit = checkDangerousCommand(cmd);
  if (dangerHit) {
    say(`⛔ [dangerous-command-guard] ${dangerHit}，已拦截。`);
    say('破坏性操作与宽泛杀进程属于安全地板（任何档位均不可自动放行）。');
    appendGateBlockLog(root, 'dangerous-command-guard', dangerHit);
    process.exitCode = 2;
    return;
  }

  const secretHit = checkSecretExfil(cmd);
  if (secretHit) {
    say(`⛔ [secret-exfil-guard] ${secretHit}，已拦截。`);
    say('密钥与宿主凭据属于不可旁路的安全地板，任何档位（含 fast）均不豁免。');
    appendGateBlockLog(root, 'secret-exfil-guard', secretHit);
    process.exitCode = 2;
    return;
  }

  const unownedOuterGit = gs.inGit && !gs.ownRepo && !gs.trackedSubdir;

  // 2. Guard against committing into an unowned outer parent `.git` repository
  if (unownedOuterGit && GIT_COMMIT_CMD_RE.test(cmd)) {
    const tierInfo = await resolveClaudeTierAndMode(root, 'pre-commit-check');
    const boundaryWhy = `当前目录（${root}）尚未独立执行 git init，直接 git commit 会越界提交到外层父仓库（${gs.topLevel}）`;
    if (tierInfo.tier !== 'fast') {
      say(`⛔ [git-boundary-guard] ${boundaryWhy}，已拦截。请先在当前项目根目录执行 git init。`);
      appendGateBlockLog(root, 'git-boundary-guard', boundaryWhy);
      process.exitCode = 2;
      return;
    }
    say(`⚠️ [fast] ${boundaryWhy}（fast 档放行告警）。`);
    appendGateBlockLog(root, 'git-boundary-guard', `[fast] ${boundaryWhy}`);
  }

  if (!hasCcHooks) return;

  // 3. Windows native TypeScript pre-commit check (`npx` is a `.cmd` batch file on win32 so `shell: false` skips it in cc-base)
  if (process.platform === 'win32' && !unownedOuterGit && GIT_COMMIT_CMD_RE.test(cmd)) {
    const { mode } = await resolveClaudeTierAndMode(root, 'pre-commit-check');
    if (mode !== 'off') {
      const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACM'], { cwd: root });
      const stagedFiles = String(staged.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (staged.status === 0 && stagedFiles.some((f) => /\.(?:ts|tsx)$/i.test(f))) {
        const tsconfig = findTsconfig(root);
        if (tsconfig) {
          const tsconfigDir = path.dirname(tsconfig);
          const tscJs = findLocalTscJs(tsconfigDir, root, gs.topLevel);
          if (tscJs) {
            const tscRes = spawnSync(process.execPath, [tscJs, '--noEmit'], {
              cwd: tsconfigDir,
              encoding: 'utf8',
              maxBuffer: 16 * 1024 * 1024,
              shell: false,
              windowsHide: true,
              env: buildChildEnv(root, gs),
            });
            if (tscRes.status !== 0) {
              say('❌ TypeScript 编译检查未通过，commit 被阻止：');
              const outText = `${tscRes.stdout || ''}${tscRes.stderr || ''}`.trimEnd();
              if (outText) say(outText);
              if (mode === 'advise') {
                say('[fast] 以上编译/语法门禁未通过，fast 档不拦本次 commit——欠账仍在，回 standard 前请修掉。');
                appendGateBlockLog(root, 'pre-commit-check', '[fast] 编译/语法门禁未通过，advise 档放行 commit');
              } else {
                appendGateBlockLog(root, 'pre-commit-check', '编译/语法门禁未通过，commit 被阻止');
                process.exitCode = 2;
                return;
              }
            }
          }
        }
      }
    }
  }

  // 4. Sequentially forward to cc-base PreToolUse(Bash) hooks
  const skipCcSecretGuard = isSafePowerShellEnvCommand(cmd);
  const ccBashHooks = [
    ...(unownedOuterGit ? [] : ['pre-commit-check.mjs']),
    'kill-dev-ports.mjs',
    'dangerous-pkill-guard.mjs',
    ...(skipCcSecretGuard ? [] : ['secret-exfil-guard.mjs']),
  ];

  for (const hookFile of ccBashHooks) {
    const r = invokeCcHook(root, hookFile, rawStdin, gs);
    if (r.stderr) fs.writeSync(2, r.stderr);
    if (r.status !== 0 || hasBlockingJson(r.stdout)) {
      if (r.stdout) fs.writeSync(1, r.stdout);
      process.exitCode = r.status !== 0 ? r.status : 0;
      return;
    }
  }
}

function handlePreSkill(root, ev) {
  const rawSkill = ev && ev.tool_input ? String(ev.tool_input.skill || '') : '';
  const skill = rawSkill.trim().replace(/^\//, '');
  if (skill !== 'release-builder') return;

  const pending = pendingReviewFiles(root);
  if (pending.length > 0) {
    const reason = `发布前置闸：待审清单未清（${pending.length} 个文件待 code review：${pending.join('、')}）。请先完成 review→fix 闭环（通过后执行 echo clean > .claude/.needs-review），再调用 /release-builder。`;
    say(`⛔ [release-gate] ${reason}`);
    appendGateBlockLog(root, 'release-gate', reason);
    process.exitCode = 2;
    return;
  }

  emitContext('PreToolUse', RELEASE_CTX);
}

async function handlePreWrite(root, ev, rawStdin, hasCcHooks, gs) {
  const subId = subagentIdOf(ev);
  const agentType = String(ev?.agent_type || ev?.subagent_type || ev?.subagent_name || '').trim();
  const input = ev && typeof ev.tool_input === 'object' && ev.tool_input ? ev.tool_input : null;
  const rawFilePath = input ? String(input.file_path || input.notebook_path || input.path || '') : '';
  const { relPath, insideRoot } = resolveWriteRelPath(rawFilePath, root);

  if (HIDDEN_ADAPTER_DIR_RE.test(relPath)) {
    return;
  }

  const isAuthorizedWriter = Boolean(subId) && WRITER_SUBAGENTS.has(agentType);
  if (!isAuthorizedWriter) {
    if (relPath && !WRITE_EXEMPT_RE.test(relPath) && WRITE_SOURCE_RE.test(relPath)) {
      const { mode } = await resolveClaudeTierAndMode(root, 'no-direct-code-guard');
      if (mode !== 'off') {
        if (mode !== 'advise') process.exitCode = 2;
        const actorDesc = subId
          ? (agentType ? `只读/非写码子代理 (${agentType})` : `未声明写码角色的子代理 (${subId})`)
          : '主 Agent';
        const reason = `${actorDesc} 不应直接修改业务源码：${relPath}`;
        say(`⚠️  [no-direct-code-guard] ${reason}`);
        say('请由主 Agent 派发 implementer（或测试场景派 tester）执行受控编码。');
        appendGateBlockLog(root, 'no-direct-code-guard', `${mode === 'advise' ? '[advise] ' : ''}${reason}`);
      }
      return;
    }
  }

  if (!hasCcHooks) return;

  let forwardStdin = rawStdin;
  if (input && rawFilePath) {
    const nextFilePath = insideRoot && relPath && relPath !== '.' ? relPath : rawFilePath;
    if (input.file_path !== nextFilePath) {
      forwardStdin = JSON.stringify({
        ...ev,
        tool_input: { ...input, file_path: nextFilePath },
      });
    }
  }

  const r = invokeCcHook(root, 'no-direct-code-guard.mjs', forwardStdin, gs);
  if (r.stderr) fs.writeSync(2, r.stderr);
  if (r.stdout) fs.writeSync(1, r.stdout);
  if (r.status !== 0) process.exitCode = r.status;
}

function handlePreAgent(root, rawStdin, hasCcHooks, gs) {
  if (!hasCcHooks) return;
  if (gs.trackedSubdir) {
    const claudeDir = path.join(root, '.claude');
    if (
      isFreshTddMark(path.join(claudeDir, '.red-verified')) ||
      isFreshTddMark(path.join(claudeDir, '.tdd-exempt'))
    ) {
      return;
    }
  }
  const r = invokeCcHook(root, 'tdd-gate.mjs', rawStdin, gs);
  if (r.stderr) fs.writeSync(2, r.stderr);
  if (r.stdout) fs.writeSync(1, r.stdout);
  if (r.status !== 0) process.exitCode = r.status;
}

function handlePostBash(root, rawStdin, hasCcHooks, gs) {
  if (!hasCcHooks) return;
  if (!gs.ownRepo && !gs.trackedSubdir) return;
  const r = invokeCcHook(root, 'auto-push.mjs', rawStdin, gs);
  if (r.stderr) fs.writeSync(2, r.stderr);
  if (r.stdout) fs.writeSync(1, r.stdout);
}

function handlePostWrite(root, ev, rawStdin, hasCcHooks, gs) {
  const input = ev && typeof ev.tool_input === 'object' && ev.tool_input ? ev.tool_input : null;
  const rawFilePath = input ? String(input.file_path || input.notebook_path || input.path || '') : '';
  const { relPath, insideRoot } = resolveWriteRelPath(rawFilePath, root);

  if (HIDDEN_ADAPTER_DIR_RE.test(relPath)) {
    return;
  }

  if (!hasCcHooks) return;

  let forwardStdin = rawStdin;
  if (input && rawFilePath) {
    const nextFilePath = insideRoot && relPath && relPath !== '.' ? relPath : rawFilePath;
    if (input.file_path !== nextFilePath) {
      forwardStdin = JSON.stringify({
        ...ev,
        tool_input: { ...input, file_path: nextFilePath },
      });
    }
  }

  for (const hookFile of ['mark-review-needed.mjs', 'record-authorship.mjs']) {
    const r = invokeCcHook(root, hookFile, forwardStdin, gs);
    if (r.stderr) fs.writeSync(2, r.stderr);
    if (r.stdout) fs.writeSync(1, r.stdout);
  }
}

function handlePreCompact(root, ev, rawStdin, hasCcHooks, gs) {
  if (ev && ev.stop_hook_active) return;
  if (!hasCcHooks) return;
  const r = invokeCcHook(root, 'precompact-gate.mjs', rawStdin, gs);
  if (r.stderr) fs.writeSync(2, r.stderr);
  if (r.stdout) fs.writeSync(1, r.stdout);
  if (r.status !== 0) process.exitCode = r.status;
}

function handlePostCompact(root, rawStdin, hasCcHooks, gs) {
  if (!hasCcHooks) return;
  const r = invokeCcHook(root, 'postcompact-reinject.mjs', rawStdin, gs);
  if (r.stderr) fs.writeSync(2, r.stderr);
  if (!r.stdout.trim()) return;

  const { objs } = parseJsonLines(r.stdout);
  if (objs.length > 0) {
    const first = objs[0];
    const ctx = first?.hookSpecificOutput?.additionalContext || first.additionalContext || '';
    if (ctx) {
      const extra = {};
      if (first.systemMessage) extra.systemMessage = first.systemMessage;
      emitContext('PostCompact', ctx, extra);
      return;
    }
    emit(first);
  }
}

function handleStop(root, ev, rawStdin, hasCcHooks, gs) {
  // Re-entry guard: prevents infinite stop loops since cc-base's stop-gate.mjs does not inspect stdin
  if (ev && ev.stop_hook_active) return;
  if (!hasCcHooks) return;

  const r1 = invokeCcHook(root, 'stop-gate.mjs', rawStdin, gs);
  if (r1.stderr) fs.writeSync(2, r1.stderr);

  const p1 = parseJsonLines(r1.stdout).objs[0] || null;
  if (r1.status !== 0 || (p1 && p1.decision === 'block') || r1.stdout.includes('"decision":"block"')) {
    if (p1) emit(p1);
    else if (r1.stdout) fs.writeSync(1, r1.stdout);
    process.exitCode = r1.status !== 0 ? r1.status : 0;
    return;
  }

  if (!gs.ownRepo && !gs.trackedSubdir) {
    if (p1) emit(p1);
    return;
  }

  const r2 = invokeCcHook(root, 'three-file-sync-gate.mjs', rawStdin, gs);
  if (r2.stderr) fs.writeSync(2, r2.stderr);
  const p2 = parseJsonLines(r2.stdout).objs[0] || null;

  if (r2.status !== 0) {
    if (r2.stdout) fs.writeSync(1, r2.stdout);
    process.exitCode = r2.status;
    return;
  }

  if (p2 && p2.decision === 'block') {
    const outObj = { ...p2 };
    if (p1?.systemMessage && !outObj.systemMessage) {
      outObj.systemMessage = p1.systemMessage;
    }
    emit(outObj);
    return;
  }

  const sysMessages = [p1?.systemMessage, p2?.systemMessage].filter(Boolean);
  if (sysMessages.length > 0) {
    emit({ systemMessage: sysMessages.join('\n') });
  }
}

async function handleSubagentStop(root, ev, rawStdin, hasCcHooks, gs) {
  if (ev && ev.stop_hook_active) return;

  const role = ev ? String(ev.agent_type || ev.subagent_type || ev.subagent_name || '').trim() : '';
  const receipt = ev && typeof ev.last_assistant_message === 'string' ? ev.last_assistant_message : '';
  const isExempt = role ? EXEMPT_ROLES.has(role) : false;

  if (!isExempt && (EXEC_ROLES.has(role) || !role) && receipt.trim() !== '') {
    const { tier } = await resolveClaudeTierAndMode(root, '');
    if (tier === 'strict') {
      const check = validateEnvelope(receipt, role);
      if (!check.ok) {
        const reason = `子代理回执信封不完整（${role || 'subagent'} 缺少 ${check.missing.join('、')} 字段）。请在同一条消息中输出完整回执信封（含 Status / Changed / Verified / Not verified / Needs review by / Evidence / Business assumptions 等段），主 Agent 只接收最后一条完整回复。`;
        appendGateBlockLog(root, 'subagent-stop', reason);
        emit({ decision: 'block', reason });
        return;
      }
    }
  }

  if (!hasCcHooks) return;
  const r = invokeCcHook(root, 'subagent-acceptance-reminder.mjs', rawStdin, gs);
  if (r.stderr) fs.writeSync(2, r.stderr);
  if (r.stdout) fs.writeSync(1, r.stdout);
  if (r.status !== 0) process.exitCode = r.status;
}

async function main() {
  const action = String(process.argv[2] || '').trim();
  const rawStdin = readStdinRaw();
  const ev = parseEventJson(rawStdin);
  const root = path.resolve(projectDir(ev));
  const gs = gitStateOf(root);
  if (gs.inGit && !gs.ownRepo && !gs.trackedSubdir) {
    process.env.GIT_CEILING_DIRECTORIES = computeGitCeiling(root, process.env.GIT_CEILING_DIRECTORIES);
  }

  if (action === 'session-start') {
    ensureCcLinks(root);
  }
  const claudeHooksDir = path.join(root, '.claude', 'hooks');
  const hasCcHooks = fs.existsSync(claudeHooksDir) && fs.statSync(claudeHooksDir).isDirectory();

  switch (action) {
    case 'session-start':
      handleSessionStart(root, ev, rawStdin, hasCcHooks, gs);
      break;
    case 'user-prompt-submit':
      handleUserPromptSubmit(root, ev, rawStdin, hasCcHooks, gs);
      break;
    case 'pre-bash':
      await handlePreBash(root, ev, rawStdin, hasCcHooks, gs);
      break;
    case 'pre-skill':
      handlePreSkill(root, ev);
      break;
    case 'pre-write':
      await handlePreWrite(root, ev, rawStdin, hasCcHooks, gs);
      break;
    case 'pre-agent':
      handlePreAgent(root, rawStdin, hasCcHooks, gs);
      break;
    case 'post-bash':
      handlePostBash(root, rawStdin, hasCcHooks, gs);
      break;
    case 'post-write':
      handlePostWrite(root, ev, rawStdin, hasCcHooks, gs);
      break;
    case 'pre-compact':
      handlePreCompact(root, ev, rawStdin, hasCcHooks, gs);
      break;
    case 'post-compact':
      handlePostCompact(root, rawStdin, hasCcHooks, gs);
      break;
    case 'stop':
      handleStop(root, ev, rawStdin, hasCcHooks, gs);
      break;
    case 'subagent-stop':
      await handleSubagentStop(root, ev, rawStdin, hasCcHooks, gs);
      break;
    default:
      say(`[cc-bridge] unknown action: ${action || '<empty>'}`);
      process.exitCode = 2;
      break;
  }
}

main().catch((err) => {
  const msg = String((err && (err.stack || err.message)) || err || 'unknown').split(/\r?\n/)[0];
  try {
    say(`[cc-bridge] 内部异常：${msg}`);
  } catch {
    /* ignore */
  }
  if (!process.exitCode) process.exitCode = 0;
});
