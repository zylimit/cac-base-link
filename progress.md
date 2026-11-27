# progress — cac-base-link 项目记忆

## Pinned（必守）

- 单一真相源：`.claude/`（`cc-base`）为唯一规则/技能/角色/钩子真相源，`cac-base-link` 严禁复制 `cc-base` 规则、技能或治理脚本。
- 根目录零文件入侵：`seeded: []`，主控入口固定为无 YAML frontmatter 的 `.cac/rules/AGENTS.md`（首段 `@../../.claude/CLAUDE.md` 内联注入 + 宿主桥接协议）。
- 零外部依赖与 Windows PowerShell 一等公民：仅用 Node `>= 20.0.0` 内置模块；子进程统一 `shell: false, windowsHide: true`；URL 转路径一律用 `fileURLToPath`；`setup.ps1` 保持纯 ASCII 无 UTF-8 BOM。
- 联接点绝对安全：Windows 用免管理员 NTFS Junction，POSIX 用相对目录符号链接；卸载与修复仅摘除链接本身，严禁对链接路径做递归删除，确保 `.claude/` 内容 100% 毫发无损。

## Decisions

- 2026-11-26 | 采用 `@../../.claude/CLAUDE.md` + 精炼宿主桥接补充协议构建 `.cac/rules/AGENTS.md` | 依据：`codeagent` 原生自动注入无 `paths:` 头的 `.cac/rules/*.md` 且支持 `@` 相对路径内联，既保持根目录零入侵又消除主控宪法双份维护 | 适用范围：全仓 `.cac/rules/AGENTS.md` | 取代：独立版全量复制宪法方案。
- 2026-11-26 | 统一通过 `.cac/hooks/cc-bridge.mjs <action>` 桥接全部 12 条生命周期与工具钩子 | 依据：在转调 `.claude/hooks/*.mjs` 前置执行 `ps-floor.mjs` 双壳安全硬地板、外层未追踪父 `.git` 越界防护及 `Stop`/`SubagentStop`/`PreCompact` 的 `stop_hook_active` 防重入保护，并将 `SessionStart` / `Stop` 多钩子输出归并为单行合法 JSON | 适用范围：`.cac/settings.json` 与 `.cac/hooks/` | 取代：无。
- 2026-11-26 | 安装器内置六大重装/升级/迁移自愈能力（幂等重装、三路 `.cac-link-new` 升级、独立版 `cac-base` 实体目录自动备份迁移、先装桥接后装 `cc-base` 容错、目录移位坏链自愈、孤儿死锁自动接管） | 依据：用户明确要求重复安装与各类升级迁移场景必须 100% 一次成功且零破坏 `.claude/` | 适用范围：`scripts/cac-base-link.mjs` 与 `scripts/lib/*` | 取代：物理目录直接报错阻断方案。
- 2026-11-27 | 落地三层解耦 `cc-base` 自动寻源联装与 `--bundle-cc` 离线合包（`cc-base-contract.json` + `scripts/lib/cc-dep.mjs`） | 依据：兼顾同仓已装 `.claude/` 零拷贝秒过（Tier 1）、空目录自动发现 `--cc-base`/`.bundled-cc-base`/`CC_BASE_DIR`/`../cc-base` 一步联装（Tier 2）、无源或 `--no-auto-cc` 延迟自愈壳模式（Tier 3）以及无外网单包分发需求 | 适用范围：`scripts/cac-base-link.mjs`、`setup.ps1`、`setup.sh`、`scripts/lib/cc-dep.mjs` | 取代：仅手工分两步安装 `cc-base` 与 `cac-base-link` 的流程。

## Done

- 2026-11-26 | 完成 `cac-base-link` v1.0.0 核心实现：根配置与双壳入口（`setup.ps1` / `setup.sh`）、安装与联接引擎（`scripts/cac-base-link.mjs` + `path-guard` / `link-manager` / `settings-merge` / `manifest`）、极简桥接核（`.cac/rules/AGENTS.md`、`.cac/settings.json`、`cc-bridge.mjs`、`root.mjs`、`ps-floor.mjs`、`doctor.mjs`、`FRAMEWORK-MANIFEST.json`）及双平台 GitHub Actions `gate.yml`。
- 2026-11-27 | 完成三阶段审查修复收口（F-01..F-11：防符号链接穿透、`GIT_CEILING_DIRECTORIES` 进程内与子进程双隔离、`tier.json` 8h 上限截断、桥接层 `pre-write`/`post-write` 相对路径与 `.cac/` 豁免保护、`isSafePowerShellEnvCommand` + Windows `tsc --noEmit`、`doctor.mjs` 无参 `selfRoot` 与 `~/.local/bin` 探测、`permissions.ask` 补齐 `git push --force/-f`、单处 `additionalContext` 输出）及三层解耦 `cc-base` 自动寻源联装 + `--bundle-cc` 离线合包。

## TODO

- 交由独立 `cac-tester` 编写并执行 `.cac/tests/` 全量独立测试套件，并由 `cac-reviewer` 完成代码审查。
