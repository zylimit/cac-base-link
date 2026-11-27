#!/usr/bin/env node
// Unified cross-platform test runner for cac-base-link (Node >= 20, zero external dependencies).
// Usage: node .cac/tests/run-all.mjs [--level high|medium|low|all] [--dir <testsDir>] [--ledger <jsonlPath>]
// Exit codes:
//   0 = all matched tests passed (with >= 1 real PASS execution)
//   1 = one or more test cases or files failed
//   2 = invalid arguments OR empty/all-skipped execution set (never fake green)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');
const DEFAULT_LEDGER = path.join(REPO_ROOT, '.cac', 'evidence', 'test-ledger.jsonl');
const FALLBACK_TMP_LEDGER = path.join(os.tmpdir(), 'cac-base-link-test-ledger.jsonl');

const ALLOWED_LEVELS = new Set(['high', 'medium', 'low', 'all']);

function parseArgs(argv) {
  let level = 'high';
  let dir = THIS_DIR;
  let ledger = process.env.CAC_LINK_TEST_LEDGER || process.env.CAC_TEST_LEDGER || DEFAULT_LEDGER;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--level') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) return { error: '--level requires a value (high|medium|low|all)' };
      level = v.toLowerCase();
    } else if (a.startsWith('--level=')) {
      level = a.slice('--level='.length).toLowerCase();
    } else if (a === '--dir') {
      const v = argv[++i];
      if (!v) return { error: '--dir requires a directory path' };
      dir = path.resolve(v);
    } else if (a.startsWith('--dir=')) {
      dir = path.resolve(a.slice('--dir='.length));
    } else if (a === '--ledger') {
      const v = argv[++i];
      if (!v) return { error: '--ledger requires a file path' };
      ledger = path.resolve(v);
    } else if (a.startsWith('--ledger=')) {
      ledger = path.resolve(a.slice('--ledger='.length));
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }

  if (!ALLOWED_LEVELS.has(level)) {
    return { error: `invalid --level "${level}" (expected high|medium|low|all)` };
  }
  return { level, dir, ledger };
}

function extractRiskTag(filePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return 'high';
  }
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const headLines = clean.split(/\r?\n/).slice(0, 5);
  for (const line of headLines) {
    const m = /^\s*(?:\/\/\s*#?\s*|#\s*)risk\s*:\s*(high|medium|low)\b/i.exec(line);
    if (m) return m[1].toLowerCase();
  }
  return 'high';
}

function matchesLevel(fileRisk, requestedLevel) {
  if (requestedLevel === 'all' || requestedLevel === 'low') return true;
  if (requestedLevel === 'medium') return fileRisk === 'high' || fileRisk === 'medium';
  return fileRisk === 'high';
}

function parseTapCases(tapOutput) {
  const lines = String(tapOutput || '').replace(/\r\n/g, '\n').split('\n');
  const cases = [];
  const suiteStack = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const subMatch = /^(\s*)# Subtest:\s*(.+)$/.exec(line);
    if (subMatch) {
      const depth = Math.floor(subMatch[1].length / 4);
      suiteStack.length = depth;
      suiteStack[depth] = subMatch[2].trim();
      continue;
    }

    const resMatch = /^(\s*)(ok|not ok)\s+\d+(?:\s+-\s+(.*))?$/.exec(line);
    if (!resMatch) continue;

    const indent = resMatch[1].length;
    const depth = Math.floor(indent / 4);
    const ok = resMatch[2] === 'ok';
    const rawDesc = (resMatch[3] || '').trim();

    let isSuite = false;
    let durationMs = null;
    if (i + 1 < lines.length && /^\s*---\s*$/.test(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j])) {
        const typeMatch = /^\s*type:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/.exec(lines[j]);
        if (typeMatch && typeMatch[1] === 'suite') isSuite = true;
        const durMatch = /^\s*duration_ms:\s*([0-9.]+)\s*$/.exec(lines[j]);
        if (durMatch) durationMs = Number(durMatch[1]);
        j += 1;
      }
      i = j;
    }

    if (isSuite) continue;

    const skipMatch = /^(.*?)\s+#\s*(SKIP|TODO)\b(.*)$/i.exec(rawDesc);
    let cleanDesc = skipMatch ? skipMatch[1].trim() : rawDesc;
    cleanDesc = cleanDesc.replace(/\s+#\s*time=[0-9.]+m?s$/i, '').trim() || '(unnamed)';

    const parents = suiteStack.slice(0, depth).filter(Boolean);
    const fullCaseName = parents.length > 0 ? `${parents.join(' > ')} > ${cleanDesc}` : cleanDesc;

    let result;
    if (skipMatch && ok) {
      result = 'SKIPPED';
    } else if (ok) {
      result = 'PASS';
    } else {
      result = 'FAIL';
    }

    cases.push({
      case: fullCaseName,
      result,
      ...(durationMs !== null && Number.isFinite(durationMs) ? { durationMs } : {}),
    });
  }

  return cases;
}

function writeLedgerSafe(ledgerPath, rows) {
  if (rows.length === 0) return;
  const payload = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, payload, 'utf8');
  } catch (e) {
    if (e && (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOENT')) {
      try {
        fs.appendFileSync(FALLBACK_TMP_LEDGER, payload, 'utf8');
        return;
      } catch {
        // Ignore secondary tmp ledger failure
      }
    }
    process.stderr.write(`[run-all] warning: failed to append ledger ${ledgerPath}: ${(e && e.message) || e}\n`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    process.stderr.write(`[run-all] ${opts.error}\n`);
    process.stderr.write('Usage: node .cac/tests/run-all.mjs [--level high|medium|low|all]\n');
    process.exit(2);
  }

  if (!fs.existsSync(opts.dir)) {
    process.stderr.write(`[run-all] BLOCKED: test directory does not exist: ${opts.dir}\n`);
    process.exit(2);
  }

  const allEntries = fs.readdirSync(opts.dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();

  const selected = [];
  for (const name of allEntries) {
    const fullPath = path.join(opts.dir, name);
    let st;
    try {
      st = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const risk = extractRiskTag(fullPath);
    if (matchesLevel(risk, opts.level)) {
      selected.push({ name, fullPath, risk });
    }
  }

  if (selected.length === 0) {
    process.stderr.write(`[run-all] BLOCKED: 0 test files matched --level ${opts.level} in ${opts.dir} (refusing fake green).\n`);
    process.exit(2);
  }

  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;
  let anyFileFailed = false;
  const ledgerRows = [];
  const nowIso = new Date().toISOString();
  const suiteStartMs = Date.now();

  process.stdout.write(`cac-base-link test runner (--level ${opts.level}): ${selected.length} suite file(s)\n`);

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;

  for (const item of selected) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', item.fullPath], {
      cwd: os.tmpdir(),
      env: childEnv,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - t0;
    const parsedCases = parseTapCases(r.stdout);

    let filePass = 0;
    let fileFail = 0;
    let fileSkip = 0;

    if (parsedCases.length === 0 && r.status !== 0) {
      fileFail = 1;
      ledgerRows.push({
        t: nowIso,
        file: item.name,
        case: '(suite-execution)',
        risk: item.risk,
        result: 'FAIL',
        durationMs: elapsedMs,
      });
    } else {
      for (const c of parsedCases) {
        if (c.result === 'PASS') filePass += 1;
        else if (c.result === 'FAIL') fileFail += 1;
        else fileSkip += 1;
        ledgerRows.push({
          t: nowIso,
          file: item.name,
          case: c.case,
          risk: item.risk,
          result: c.result,
          ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
        });
      }
      if (r.status !== 0 && fileFail === 0) {
        fileFail += 1;
        ledgerRows.push({
          t: nowIso,
          file: item.name,
          case: '(non-zero-exit)',
          risk: item.risk,
          result: 'FAIL',
          durationMs: elapsedMs,
        });
      }
    }

    totalPass += filePass;
    totalFail += fileFail;
    totalSkip += fileSkip;

    const okFile = r.status === 0 && fileFail === 0;
    if (!okFile) anyFileFailed = true;

    const badge = okFile ? 'PASS' : 'FAIL';
    process.stdout.write(
      `  [${badge}] ${item.name.padEnd(28)} (risk=${item.risk.padEnd(6)}) pass=${filePass} fail=${fileFail} skip=${fileSkip} (${elapsedMs}ms)\n`,
    );

    if (!okFile) {
      const diag = [r.stdout || '', r.stderr || ''].filter(Boolean).join('\n');
      const relevant = diag
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((l) => /^(?:\s*not ok\b|\s*#\s|\s*Error:|\s*AssertionError|\s*actual:|\s*expected:|\s*operator:|\s*at\s)/.test(l))
        .slice(0, 50);
      const dump = relevant.length > 0 ? relevant.join('\n') : diag.slice(0, 2000);
      if (dump.trim()) {
        process.stderr.write(`--- failure output: ${item.name} (exit ${r.status}) ---\n${dump}\n`);
      }
    }
  }

  writeLedgerSafe(opts.ledger, ledgerRows);

  const totalElapsedMs = Date.now() - suiteStartMs;
  process.stdout.write(
    `summary: files=${selected.length} pass=${totalPass} fail=${totalFail} skip=${totalSkip} durationMs=${totalElapsedMs}\n`,
  );

  if (anyFileFailed || totalFail > 0) {
    process.exit(1);
  }

  if (totalPass === 0) {
    process.stderr.write('[run-all] BLOCKED: 0 test cases actually executed (all skipped or empty files) -- refusing fake green.\n');
    process.exit(2);
  }

  process.exit(0);
}

main();
