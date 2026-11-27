# ARCHITECTURE — cac-base-link 架构设计

## 1. 设计定位与不变量

`cac-base-link` 是面向双宿主协同团队（同仓同时使用 Claude Code / Cursor 与 CodeAgent CLI `codeagent`）的**极简零拷贝桥接层**：

- **单一真相源**：`.claude/`（由 `cc-base` 管理）持有全部宪法正文、按需细则、技能 `SKILL.md`、子代理定义、治理脚本与运行态文件（如 `.claude/.needs-review`、`.claude/.runtime/tier.json`）。
- **零资产复制**：`.cac/` 仅包含 7 个受管桥接文件与 1 份合并后的 `settings.json`，彻底消除双目录规则漂移。
- **根目录零文件入侵**：`seeded: []`，绝不在项目根投放 `AGENTS.md` 或 `CLAUDE.md`。

## 2. 目录拓扑

```text
cac-base-link/
├── cc-base-contract.json              # 上游 cc-base (.claude/) 最小文件与目录契约声明
├── setup.ps1                          # 纯 ASCII 无 BOM PowerShell 薄壳 -> scripts/cac-base-link.mjs
├── setup.sh                           # POSIX sh 薄壳 -> scripts/cac-base-link.mjs
├── scripts/
│   ├── cac-base-link.mjs              # 统一 CLI 内核（install/upgrade/uninstall/doctor/manifest/pack-check/release）
│   └── lib/
│       ├── path-guard.mjs             # Windows 保留名/系统目录/尾随点空格/越界路径前置拦截
│       ├── link-manager.mjs           # Windows NTFS Junction + POSIX 相对 symlink 幂等联接与防穿透摘除
│       ├── settings-merge.mjs         # .cac/settings.json 无损合并、独立版 hook 自动清理、string<->exec 互转
│       ├── manifest.mjs               # LF-SHA256 清单构建校验与开发者路径/密钥防泄漏扫描
│       └── cc-dep.mjs                 # 三层解耦 cc-base 自动寻源联装 + --bundle-cc 离线合包引擎
└── .cac/                              # 注入下游项目的极简桥接壳
    ├── .gitattributes                 # 强制 LF
    ├── .gitignore                     # 忽略本地 OS 联接 skills / agents 及运行态 .runtime/
    ├── FRAMEWORK-MANIFEST.json        # 7 个受管桥接文件的 LF-SHA256 清单
    ├── settings.json                  # 权限地板 + 12 条 string-form cc-bridge 钩子注册
    ├── rules/
    │   └── AGENTS.md                  # 无 YAML 头自动注入入口：@../../.claude/CLAUDE.md + 宿主补充协议
    ├── hooks/
    │   ├── cc-bridge.mjs              # 12 动作统一调度器 -> 注入 CLAUDE_PROJECT_DIR 与 GIT_CEILING_DIRECTORIES 转调 .claude/hooks/*.mjs
    │   └── lib/
    │       ├── root.mjs               # 词法+realpath 双遍历寻根、Git 边界识别、毫秒级 ensureCcLinks 自愈
    │       └── ps-floor.mjs           # Bash + PowerShell 双壳危险命令、密钥外泄硬地板与安全 .env 命令识别
    └── scripts/
        └── doctor.mjs                 # 双模式自检（源仓 Mode A / 下游项目联接与技能角色枚举 Mode B）
```

## 3. Hook 桥接矩阵（`cc-bridge.mjs`）

| `codeagent` 事件 | Matcher | `cc-bridge` 动作 | 桥接与增强行为 |
|---|---|---|---|
| `SessionStart` | `*` | `session-start` | 前置 `ensureCcLinks` 自愈链接 → `check-evolution` + `session-rules-banner` → `recap-on-dirty`（外层未追踪父 `.git` 时改为边界提示）→ 追加 `buildStartupSnapshot` → 合并为**单行 JSON** |
| `UserPromptSubmit` | `*` | `user-prompt-submit` | `/release-builder` 检查 `.claude/.needs-review` 待审阻断；其余转调 `detect-feedback-signal.mjs`（规范化单处 `hookSpecificOutput.additionalContext`） |
| `PreToolUse` | `Bash\|PowerShell\|Shell` | `pre-bash` | 先跑 `ps-floor.mjs` 双壳安全硬地板（exit 2）→ 拦截向未 `git init` 外层父仓 `git commit` → `win32` 原生 `node <tsc> --noEmit` 补检 → 安全单条 PowerShell `Test-Path`/`Copy-Item`/`Move-Item` `.env` 跳过 POSIX 误拦 → 依次转调 `{pre-commit-check,kill-dev-ports,dangerous-pkill-guard,secret-exfil-guard}.mjs` |
| `PreToolUse` | `Skill` | `pre-skill` | `skill === "release-builder"` 时检查 `.claude/.needs-review`（非空则 stderr + exit 2 硬拦；干净则注入发布前置卡点提醒） |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | `pre-write` | 放行 `.cac/**` → 桥接层统一对非授权写码者（主 Agent / 只读子代理 / 缺 `agent_type`）拦截业务源码写入 → 归一相对路径转调 `no-direct-code-guard.mjs` |
| `PreToolUse` | `Agent\|Task` | `pre-agent` | `trackedSubdir` 识别当前子目录 2h 内有效 `.red-verified`/`.tdd-exempt` → 转调 `tdd-gate.mjs` |
| `PostToolUse` | `Bash\|PowerShell\|Shell` | `post-bash` | 仅在 `ownRepo \|\| trackedSubdir` 时转调 `auto-push.mjs` |
| `PostToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | `post-write` | 豁免 `.cac/**` 防污染 `.needs-review` → 归一相对路径依次转调 `mark-review-needed.mjs` 与 `record-authorship.mjs` |
| `PreCompact` | `*` | `pre-compact` | `stop_hook_active` 防重入 + `GIT_CEILING_DIRECTORIES` 隔离外层父 `.git`（保留 C1 `.needs-review` 守卫）→ 转调 `precompact-gate.mjs` |
| `PostCompact` | `*` | `post-compact` | 转调 `postcompact-reinject.mjs`（规范化单处 `hookSpecificOutput.additionalContext`） |
| `Stop` | `*` | `stop` | **补齐 `stop_hook_active` 重入防护** → `stop-gate.mjs`（阻断即单行透传终止）→ `three-file-sync-gate.mjs`（单行合并 `systemMessage`） |
| `SubagentStop` | `implementer\|code-reviewer\|tester\|deployer` | `subagent-stop` | `stop_hook_active` 防重入 + `strict` 档信封 `Status`/`Evidence` 校验 → 转调 `subagent-acceptance-reminder.mjs` |

## 4. 三层解耦 `cc-base` 寻源与七大安装可靠性保障

1. **三层解耦自动联装（`cc-dep.mjs`）**：
   - **Tier 1（`present` / `upgraded`）**：目标已满足 `cc-base-contract.json` 时零拷贝秒过；传 `--with-cc` 或 `--cc-base <dir>` 时升级 `.claude/`。
   - **Tier 2（`auto-installed`）**：目标缺 `.claude/` 时按 `--cc-base <dir>` → `.bundled-cc-base/` → `CC_BASE_DIR` → `../cc-base` 自动调用上游安装器一步装齐 `.claude/` + `.cac/`。
   - **Tier 3（`deferred`）**：无可用源或传 `--no-auto-cc` / `CAC_LINK_NO_AUTO_CC=1` 时先铺设 `.cac/` 桥接壳（exit 0），后续由 `SessionStart` 自动补链。
2. **内网离线合包（`release --bundle-cc`）**：普通 `release` 严格排除 `.bundled-cc-base/`；传 `--bundle-cc <dir>` 时清洗剥离私有反馈与开发记录后打入 `.bundled-cc-base/`，实现单包离线联装。
3. **幂等重装与防符号链接穿透**：`install` 与 `upgrade` 同构三路比对，前置拦截并安全摘除任何祖先/叶子级符号链接（`parent-is-symlink` / `same-realpath-as-target`），绝不穿透篡改外部目录。
4. **三路无损升级**：未改文件自动备份 `.bak` 更新；用户改过的文件保留原件并旁落 `*.cac-link-new`。
5. **独立版 `cac-base` 一键平滑切换**：检测到实体 `.cac/{skills,agents}` 自动迁移至 `.cac/.runtime/migrated-standalone-<ts>/`，清理旧独立版未改冗余文件并建立 Junction/symlink。
6. **移位目录坏链自愈**：项目目录整体移动改名后，重跑 setup 或触发 `SessionStart` 自动检测 `realpath` 失配并重建新 Junction/symlink。
7. **孤儿锁自动回收**：`install.lock` 记录 `{ pid, ts }`，遇已死进程（`ESRCH`）或超时锁自动接管，杜绝中断锁死。
