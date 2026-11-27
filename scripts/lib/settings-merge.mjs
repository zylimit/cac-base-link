#!/usr/bin/env node
// scripts/lib/settings-merge.mjs — Pure-Node lossless merger & hook-form converter for .cac/settings.json.
// Supports:
//   - cac-base-link bridge hooks: `node .cac/hooks/cc-bridge.mjs <action>` (string <-> exec lossless round-trip)
//   - Smooth migration from standalone cac-base: strips standalone `.cac/hooks/<known>.mjs` & legacy `.sh`/`.ps1`
//     hooks while 100% preserving user custom permissions and third-party custom hooks!
// Zero npm / jq dependencies (Node >= 20 built-ins only).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_BIN_RE = /^["']?node(?:\.exe)?["']?$/i;
const HOOK_SCRIPT_REL_RE = /^(?:\$\{(?:CODEAGENT3_PROJECT_DIR|CAC_PROJECT_DIR)\}[/\\]|\.[/\\])?\.cac[/\\]hooks[/\\]([A-Za-z0-9_-]+)\.mjs$/;
const STRING_CMD_RE = /^(?:["']?node(?:\.exe)?["']?)\s+(?:"([^"]+)"|'([^']+)'|(\S+))((?:\s+[A-Za-z0-9_-]+|\s+--[A-Za-z0-9_-]+)*)\s*$/i;
const HOOK_EXTRA_ARG_RE = /^(?:--)?[A-Za-z0-9_-]+$/;
const LEGACY_HOOK_RE = /(?:^|[/\\]|["'\s])\.cac[/\\]hooks[/\\][A-Za-z0-9_-]+\.(?:sh|ps1)(?:$|["'\s])/i;

/**
 * Known standalone `cac-base` managed hook script names.
 * When migrating a project from standalone `cac-base` to `cac-base-link`, these old standalone hook entries
 * are cleanly replaced by `cc-bridge.mjs` while any custom user hook (even under `.cac/hooks/my-custom.mjs`) stays intact.
 */
const STANDALONE_CAC_HOOK_NAMES = new Set([
  'session-start',
  'release-gate',
  'detect-feedback-signal',
  'secret-exfil-guard',
  'dangerous-command-guard',
  'dangerous-pkill-guard',
  'pre-commit-check',
  'kill-dev-ports',
  'no-direct-code-guard',
  'tdd-gate',
  'auto-push',
  'mark-review-needed',
  'record-authorship',
  'subagent-bookkeeping',
  'subagent-acceptance-reminder',
  'precompact-gate',
  'postcompact-reinject',
  'stop-gate',
  'three-file-sync-gate',
  'static-check',
]);

function stripMatchingQuotes(s) {
  const t = String(s ?? '').trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function cloneJson(val) {
  return JSON.parse(JSON.stringify(val));
}

function parseDotCacHookRef(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.command === 'string' && NODE_BIN_RE.test(entry.command.trim()) && Array.isArray(entry.args) && entry.args.length >= 1) {
    const m = HOOK_SCRIPT_REL_RE.exec(stripMatchingQuotes(entry.args[0]));
    if (m) {
      const rest = entry.args.slice(1).map((x) => String(x));
      if (rest.every((a) => HOOK_EXTRA_ARG_RE.test(a))) {
        return { form: 'exec', name: m[1], extraArgs: rest };
      }
    }
  }
  if (!('args' in entry) && typeof entry.command === 'string') {
    const cm = STRING_CMD_RE.exec(entry.command.trim());
    if (cm) {
      const scriptPath = cm[1] ?? cm[2] ?? cm[3] ?? '';
      const pm = HOOK_SCRIPT_REL_RE.exec(scriptPath);
      if (pm) {
        const extraArgs = cm[4] ? cm[4].trim().split(/\s+/).filter(Boolean) : [];
        if (extraArgs.every((a) => HOOK_EXTRA_ARG_RE.test(a))) {
          return { form: 'string', name: pm[1], extraArgs };
        }
      }
    }
  }
  return null;
}

/**
 * Identify whether `entry` is a `cac-base-link` bridge hook (`cc-bridge.mjs <action>`).
 * Custom user hooks return `null` and are never touched.
 * @param {any} entry
 * @returns {{ form: 'string' | 'exec', name: string, extraArgs: string[] } | null}
 */
export function classifyHookEntry(entry) {
  const parsed = parseDotCacHookRef(entry);
  if (!parsed) return null;
  if (parsed.name === 'cc-bridge') return parsed;
  return null;
}

/**
 * Check if `entry` is a legacy `.cac/hooks/*.(sh|ps1)` or standalone `cac-base` `.cac/hooks/<managed>.mjs` hook
 * that should be cleaned up when installing/upgrading `cac-base-link`.
 * @param {any} entry
 * @returns {boolean}
 */
export function isLegacyOrStandaloneHook(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const parts = [typeof entry.command === 'string' ? entry.command : ''];
  if (Array.isArray(entry.args)) {
    for (const a of entry.args) parts.push(String(a ?? ''));
  }
  if (parts.some((p) => LEGACY_HOOK_RE.test(p))) return true;
  const parsed = parseDotCacHookRef(entry);
  if (parsed && STANDALONE_CAC_HOOK_NAMES.has(parsed.name)) return true;
  return false;
}

/**
 * Compute logical deduplication ID for a hook entry.
 * @param {any} entry
 * @returns {string}
 */
export function hookLogicalId(entry) {
  const cls = classifyHookEntry(entry);
  if (cls) {
    return cls.extraArgs.length > 0 ? `hook:${cls.name}:${cls.extraArgs.join(' ')}` : `hook:${cls.name}`;
  }
  const cmd = typeof entry?.command === 'string' ? entry.command : '';
  const args = Array.isArray(entry?.args) ? entry.args.map((x) => String(x)).join(' ') : '';
  return `custom:${cmd}\0${args}`;
}

/**
 * Rebuild a framework hook entry into target form ('string' | 'exec'), preserving extra keys (e.g. `timeout`).
 * @param {Record<string, any>} entry
 * @param {'string' | 'exec'} form
 * @param {string} name
 * @param {string[]} [extraArgs]
 * @returns {Record<string, any>}
 */
export function rebuildHookEntry(entry, form, name, extraArgs = []) {
  const out = { type: entry.type ?? 'command' };
  if (form === 'exec') {
    out.command = 'node';
    out.args = [`.cac/hooks/${name}.mjs`, ...extraArgs];
  } else {
    out.command = ['node', `.cac/hooks/${name}.mjs`, ...extraArgs].join(' ');
  }
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'type' || k === 'command' || k === 'args') continue;
    out[k] = v;
  }
  return out;
}

function* iterHookGroups(data) {
  const hooks = data && typeof data === 'object' ? data.hooks : null;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (g && typeof g === 'object' && Array.isArray(g.hooks)) yield g;
    }
  }
}

/**
 * Detect current framework hook registration form in a settings object.
 * @param {any} settingsObj
 * @returns {'string' | 'exec' | 'mixed' | 'none'}
 */
export function detectHookForm(settingsObj) {
  const forms = new Set();
  for (const g of iterHookGroups(settingsObj)) {
    for (const h of g.hooks) {
      const c = classifyHookEntry(h);
      if (c) forms.add(c.form);
    }
  }
  if (forms.size === 0) return 'none';
  if (forms.size > 1) return 'mixed';
  return [...forms][0];
}

/**
 * Convert all `cac-base-link` framework hook entries to `targetForm` ('string' | 'exec').
 * @param {Record<string, any>} settingsObj
 * @param {'string' | 'exec'} targetForm
 * @returns {{ settings: Record<string, any>, converted: number }}
 */
export function convertHookForm(settingsObj, targetForm) {
  if (targetForm !== 'string' && targetForm !== 'exec') {
    throw new Error(`invalid hook form: ${targetForm} (expected 'string' or 'exec')`);
  }
  const copy = cloneJson(settingsObj);
  let converted = 0;
  for (const g of iterHookGroups(copy)) {
    g.hooks = g.hooks.map((h) => {
      const c = classifyHookEntry(h);
      if (!c) return h;
      const rebuilt = rebuildHookEntry(h, targetForm, c.name, c.extraArgs);
      if (JSON.stringify(rebuilt) !== JSON.stringify(h)) converted++;
      return rebuilt;
    });
  }
  return { settings: copy, converted };
}

function unionStringList(targetArr, sourceArr) {
  const out = Array.isArray(targetArr) ? [...targetArr] : [];
  const seen = new Set(out.map((x) => String(x)));
  let added = 0;
  for (const item of Array.isArray(sourceArr) ? sourceArr : []) {
    const key = String(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
      added++;
    }
  }
  return { merged: out, added };
}

function collectValidBridgeIdsByEvent(srcHooks) {
  const validByEvent = new Map();
  if (!srcHooks || typeof srcHooks !== 'object' || Array.isArray(srcHooks)) return validByEvent;
  for (const [event, groups] of Object.entries(srcHooks)) {
    if (!Array.isArray(groups)) continue;
    const ids = new Set();
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (classifyHookEntry(h)) ids.add(hookLogicalId(h));
      }
    }
    validByEvent.set(event, ids);
  }
  return validByEvent;
}

/**
 * Strip legacy `.sh`/`.ps1` hooks, standalone `cac-base` hooks, and deprecated `cc-bridge` actions
 * not present in `validByEvent`, while keeping all custom user hooks intact.
 */
function stripObsoleteFrameworkHooks(data, validByEvent = null) {
  let removed = 0;
  const hooks = data && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? data.hooks : null;
  if (!hooks) return 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const validIds = validByEvent ? validByEvent.get(event) : null;
    const keptGroups = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
        keptGroups.push(g);
        continue;
      }
      const filtered = g.hooks.filter((h) => {
        if (isLegacyOrStandaloneHook(h)) {
          removed++;
          return false;
        }
        const cls = classifyHookEntry(h);
        if (cls && validByEvent && (!validIds || !validIds.has(hookLogicalId(h)))) {
          removed++;
          return false;
        }
        return true;
      });
      if (filtered.length > 0) {
        keptGroups.push({ ...g, hooks: filtered });
      }
    }
    if (keptGroups.length > 0) hooks[event] = keptGroups;
    else delete hooks[event];
  }
  return removed;
}

/**
 * Losslessly merge `cac-base-link` `sourceObj` into `targetObj` (or initialize from `sourceObj` when `targetObj` is null).
 * - Preserves all user custom top-level fields, custom permissions (`allow`/`deny`/`ask`), and third-party hooks.
 * - Unions security floor `permissions.deny` and `permissions.ask`.
 * - Removes legacy `.sh`/`.ps1`, standalone `cac-base` `.cac/hooks/<known>.mjs`, and obsolete `cc-bridge` actions.
 * - Deduplicates `cc-bridge.mjs <action>` hooks per event so N repeated installs produce 0 duplicates.
 *
 * @param {Record<string, any> | null} targetObj
 * @param {Record<string, any>} sourceObj
 * @param {{ hookForm?: '' | 'string' | 'exec' }} [opts]
 */
export function mergeSettings(targetObj, sourceObj, opts = {}) {
  const explicitForm = opts.hookForm || '';
  if (explicitForm !== '' && explicitForm !== 'string' && explicitForm !== 'exec') {
    throw new Error(`invalid hookForm: ${explicitForm} (expected '', 'string', or 'exec')`);
  }

  let resolvedForm = explicitForm;
  if (!resolvedForm) {
    if (targetObj && typeof targetObj === 'object') {
      const detected = detectHookForm(targetObj);
      resolvedForm = detected === 'exec' ? 'exec' : 'string';
    } else {
      resolvedForm = 'string';
    }
  }

  if (!targetObj) {
    const fresh = convertHookForm(sourceObj, resolvedForm);
    let hookCount = 0;
    for (const g of iterHookGroups(fresh.settings)) hookCount += g.hooks.length;
    return {
      settings: fresh.settings,
      resolvedForm,
      addedHooks: hookCount,
      removedLegacy: 0,
      addedPermissions: 0,
    };
  }

  const merged = cloneJson(targetObj);
  const src = cloneJson(sourceObj || {});
  const validByEvent = collectValidBridgeIdsByEvent(src.hooks);
  const removedLegacy = stripObsoleteFrameworkHooks(merged, validByEvent);

  for (const [k, v] of Object.entries(src)) {
    if (k === 'hooks' || k === 'permissions') continue;
    if (!(k in merged)) {
      merged[k] = v;
    }
  }

  let addedPermissions = 0;
  if (src.permissions && typeof src.permissions === 'object' && !Array.isArray(src.permissions)) {
    if (!merged.permissions || typeof merged.permissions !== 'object' || Array.isArray(merged.permissions)) {
      merged.permissions = cloneJson(src.permissions);
    } else {
      for (const listKey of ['deny', 'ask']) {
        if (Array.isArray(src.permissions[listKey])) {
          const u = unionStringList(merged.permissions[listKey], src.permissions[listKey]);
          merged.permissions[listKey] = u.merged;
          addedPermissions += u.added;
        }
      }
      for (const [pk, pv] of Object.entries(src.permissions)) {
        if (pk === 'deny' || pk === 'ask') continue;
        if (!(pk in merged.permissions)) merged.permissions[pk] = pv;
      }
    }
  }

  let addedHooks = 0;
  if (src.hooks && typeof src.hooks === 'object' && !Array.isArray(src.hooks)) {
    if (!merged.hooks || typeof merged.hooks !== 'object' || Array.isArray(merged.hooks)) {
      merged.hooks = {};
    }
    for (const [event, srcGroups] of Object.entries(src.hooks)) {
      if (!Array.isArray(srcGroups)) continue;
      if (!Array.isArray(merged.hooks[event])) merged.hooks[event] = [];
      const existingIds = new Set();
      for (const tg of merged.hooks[event]) {
        if (!tg || !Array.isArray(tg.hooks)) continue;
        for (const th of tg.hooks) {
          existingIds.add(hookLogicalId(th));
        }
      }
      for (const sg of srcGroups) {
        if (!sg || typeof sg !== 'object' || !Array.isArray(sg.hooks)) continue;
        const toAdd = [];
        for (const sh of sg.hooks) {
          if (!sh || typeof sh !== 'object' || !sh.command) continue;
          const id = hookLogicalId(sh);
          if (!existingIds.has(id)) {
            existingIds.add(id);
            toAdd.push(sh);
            addedHooks++;
          }
        }
        if (toAdd.length > 0) {
          const matcherVal = sg.matcher ?? undefined;
          const compatibleGroup = merged.hooks[event].find(
            (tg) => tg && typeof tg === 'object' && Array.isArray(tg.hooks) && (tg.matcher ?? undefined) === matcherVal,
          );
          if (compatibleGroup) {
            compatibleGroup.hooks.push(...toAdd);
          } else {
            merged.hooks[event].push({ ...sg, hooks: toAdd });
          }
        }
      }
    }
  }

  const normalized = convertHookForm(merged, resolvedForm);
  return {
    settings: normalized.settings,
    resolvedForm,
    addedHooks,
    removedLegacy,
    addedPermissions,
  };
}

/**
 * Remove `cac-base-link` (and legacy/standalone) framework hooks from a settings object on uninstall,
 * preserving user custom hooks and custom top-level keys.
 * @param {Record<string, any>} settingsObj
 * @returns {{ settings: Record<string, any>, removedHooks: number }}
 */
export function stripFrameworkHooks(settingsObj) {
  const copy = cloneJson(settingsObj);
  let removedHooks = stripObsoleteFrameworkHooks(copy, null);
  if (copy.hooks && typeof copy.hooks === 'object' && !Array.isArray(copy.hooks)) {
    for (const [event, groups] of Object.entries(copy.hooks)) {
      if (!Array.isArray(groups)) continue;
      const keptGroups = [];
      for (const g of groups) {
        if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
          keptGroups.push(g);
          continue;
        }
        const kept = g.hooks.filter((h) => {
          if (classifyHookEntry(h)) {
            removedHooks++;
            return false;
          }
          return true;
        });
        if (kept.length > 0) keptGroups.push({ ...g, hooks: kept });
      }
      if (keptGroups.length > 0) copy.hooks[event] = keptGroups;
      else delete copy.hooks[event];
    }
    if (Object.keys(copy.hooks).length === 0) delete copy.hooks;
  }
  return { settings: copy, removedHooks };
}

/**
 * Strip only framework-default `permissions.deny` and `permissions.ask` entries,
 * leaving any user-added `deny` / `ask` / `allow` or other custom permission keys intact.
 * @param {Record<string, any>} settingsObj
 * @param {Record<string, any> | null | undefined} srcPermissions
 * @returns {{ settings: Record<string, any>, removedPermissions: number }}
 */
export function stripFrameworkPermissions(settingsObj, srcPermissions) {
  const copy = cloneJson(settingsObj);
  let removedPermissions = 0;
  const perms = copy && typeof copy.permissions === 'object' && !Array.isArray(copy.permissions)
    ? copy.permissions
    : null;
  if (!perms) return { settings: copy, removedPermissions: 0 };

  const srcDeny = new Set(Array.isArray(srcPermissions?.deny) ? srcPermissions.deny.map((x) => String(x)) : []);
  const srcAsk = new Set(Array.isArray(srcPermissions?.ask) ? srcPermissions.ask.map((x) => String(x)) : []);

  if (Array.isArray(perms.deny)) {
    const before = perms.deny.length;
    perms.deny = perms.deny.filter((x) => !srcDeny.has(String(x)));
    removedPermissions += before - perms.deny.length;
    if (perms.deny.length === 0) delete perms.deny;
  }
  if (Array.isArray(perms.ask)) {
    const before = perms.ask.length;
    perms.ask = perms.ask.filter((x) => !srcAsk.has(String(x)));
    removedPermissions += before - perms.ask.length;
    if (perms.ask.length === 0) delete perms.ask;
  }
  if (Object.keys(perms).length === 0) {
    delete copy.permissions;
  }
  return { settings: copy, removedPermissions };
}

export function formatSettingsJson(settingsObj) {
  return JSON.stringify(settingsObj, null, 2) + '\n';
}

function runSelftest() {
  const srcSettings = {
    permissions: {
      deny: ['Read(.env)', 'Read(secrets/**)'],
      ask: ['Bash(gh release *)'],
    },
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node .cac/hooks/cc-bridge.mjs session-start', timeout: 15 }] },
      ],
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell|Shell',
          hooks: [{ type: 'command', command: 'node .cac/hooks/cc-bridge.mjs pre-bash', timeout: 35 }],
        },
        {
          matcher: 'Skill',
          hooks: [{ type: 'command', command: 'node .cac/hooks/cc-bridge.mjs pre-skill', timeout: 10 }],
        },
      ],
    },
  };

  // 1. Lossless string -> exec -> string round-trip
  const originalStr = formatSettingsJson(srcSettings);
  const toExec = convertHookForm(srcSettings, 'exec');
  if (detectHookForm(toExec.settings) !== 'exec' || toExec.converted !== 3) {
    throw new Error(`expected exec form with 3 conversions, got ${detectHookForm(toExec.settings)} (${toExec.converted})`);
  }
  const backToStr = convertHookForm(toExec.settings, 'string');
  if (formatSettingsJson(backToStr.settings) !== originalStr) {
    throw new Error('string -> exec -> string round-trip was NOT byte-identical');
  }

  // 2. Smooth upgrade from standalone cac-base + obsolete cc-bridge action + custom user hook preservation
  const standaloneTarget = {
    customFlag: 'keep-me',
    permissions: {
      allow: ['Bash(npm test)'],
      deny: ['Read(.env)', 'Read(local.secret)'],
    },
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node .cac/hooks/session-start.mjs', timeout: 10 }] },
      ],
      SubagentStart: [
        { hooks: [{ type: 'command', command: 'node .cac/hooks/subagent-bookkeeping.mjs --start', timeout: 5 }] },
      ],
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell|Shell',
          hooks: [
            { type: 'command', command: 'bash .cac/hooks/legacy.sh' },
            { type: 'command', command: 'node .cac/hooks/secret-exfil-guard.mjs' },
            { type: 'command', command: 'node .cac/hooks/cc-bridge.mjs obsolete-action' },
            { type: 'command', command: 'python3 scripts/custom-guard.py' },
            { type: 'command', command: 'node .cac/hooks/my-team-custom.mjs' },
          ],
        },
      ],
    },
  };

  const merged = mergeSettings(standaloneTarget, srcSettings, { hookForm: 'string' });
  if (merged.removedLegacy !== 5) {
    throw new Error(`expected 5 legacy/standalone/obsolete hooks removed, got ${merged.removedLegacy}`);
  }
  if ('SubagentStart' in merged.settings.hooks) {
    throw new Error('empty SubagentStart group from standalone cac-base should be removed');
  }
  if (merged.addedHooks !== 3) {
    throw new Error(`expected 3 bridge hooks added, got ${merged.addedHooks}`);
  }
  if (merged.settings.customFlag !== 'keep-me' || !merged.settings.permissions.allow.includes('Bash(npm test)')) {
    throw new Error('custom user settings lost');
  }
  const preBashHooks = merged.settings.hooks.PreToolUse[0].hooks;
  if (!preBashHooks.some((h) => h.command === 'python3 scripts/custom-guard.py')) {
    throw new Error('third-party python hook was lost');
  }
  if (!preBashHooks.some((h) => h.command === 'node .cac/hooks/my-team-custom.mjs')) {
    throw new Error('user custom .cac/hooks/my-team-custom.mjs was lost');
  }

  // 3. Idempotent repeated merge -> 0 addedHooks, byte-identical
  const again = mergeSettings(merged.settings, srcSettings, { hookForm: '' });
  if (again.addedHooks !== 0 || formatSettingsJson(again.settings) !== formatSettingsJson(merged.settings)) {
    throw new Error('repeated mergeSettings must be 100% idempotent');
  }

  // 4. Uninstall strip preserves user custom hooks & user permissions
  const stripped = stripFrameworkHooks(again.settings);
  if (stripped.removedHooks !== 3) {
    throw new Error(`expected 3 framework hooks stripped on uninstall, got ${stripped.removedHooks}`);
  }
  const permStripped = stripFrameworkPermissions(stripped.settings, srcSettings.permissions);
  if (!permStripped.settings.permissions.deny.includes('Read(local.secret)')) {
    throw new Error('user custom deny permission was lost on uninstall');
  }
  if (permStripped.settings.permissions.deny.includes('Read(secrets/**)')) {
    throw new Error('framework default deny permission was not stripped');
  }

  process.stdout.write(JSON.stringify({ ok: true, tests: 4 }) + '\n');
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    runSelftest();
    process.exit(0);
  }
  let to = null;
  let doCheck = false;
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') doCheck = true;
    else if (a === '--to') to = argv[++i];
    else if (a.startsWith('--to=')) to = a.slice(5);
    else if (a === '--file') file = argv[++i];
    else if (a.startsWith('--file=')) file = a.slice(7);
    else {
      process.stderr.write(`settings-merge: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  if (doCheck === (to !== null)) {
    process.stderr.write('usage: node scripts/lib/settings-merge.mjs (--check | --to string|exec) [--file <settings.json>] | --selftest\n');
    process.exit(2);
  }
  const root = process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR || process.cwd();
  const targetFile = file || path.join(root, '.cac', 'settings.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`settings-merge: failed to read ${targetFile}: ${e.message}\n`);
    process.exit(2);
  }
  if (doCheck) {
    const f = detectHookForm(parsed);
    process.stdout.write(`${f}\n`);
    process.exit(f === 'mixed' ? 1 : 0);
  }
  if (to !== 'string' && to !== 'exec') {
    process.stderr.write(`settings-merge: --to expects string or exec, got ${to}\n`);
    process.exit(2);
  }
  const res = convertHookForm(parsed, to);
  if (res.converted > 0) {
    fs.writeFileSync(targetFile, formatSettingsJson(res.settings), 'utf8');
  }
  process.stdout.write(JSON.stringify({ ok: true, to, converted: res.converted, file: targetFile }) + '\n');
}
