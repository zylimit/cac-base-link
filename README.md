# cac-base-link

> **零拷贝、单一真相源、根目录零入侵** —— 将已安装 `cc-base`（`.claude/`）的项目无缝桥接至 Windows PowerShell / WSL / Linux / macOS 下的 **CodeAgent CLI (`codeagent`)**（`.cac/`）。

## 核心特性

1. **单一真相源（Zero Duplication）**：不复制 `cc-base` 的 22 套技能、8 个子代理角色、按需细则或治理脚本；所有规则、技能、角色、状态与钩子均以同目录 `.claude/` 为唯一权威源。
2. **根目录零文件入侵**：默认安装不在业务仓库根目录创建 `AGENTS.md` 或 `CLAUDE.md`；主控入口位于无 YAML frontmatter 的 `.cac/rules/AGENTS.md`，通过 `@../../.claude/CLAUDE.md` 原生内联注入 `cc-base` 宪法，并附精炼宿主桥接协议。
3. **跨平台免管理员权限目录联接**：
   - **Windows PowerShell**：使用免管理员权限的 **NTFS Junction**（`.cac/skills` → `.claude/skills`、`.cac/agents` → `.claude/agents`）；
   - **Linux / WSL / macOS**：使用相对路径符号链接（`../.claude/skills`、`../.claude/agents`）；
   - `.cac/.gitignore` 默认忽略本地联接点，杜绝跨平台提交坏链，且每次会话 `SessionStart` 毫秒级自愈补建。
4. **双壳安全硬地板 + 全事件桥接**：`.cac/hooks/cc-bridge.mjs` 在转发至 `.claude/hooks/*.mjs` 前，先运行 `ps-floor.mjs` Bash + PowerShell 双壳危险命令与密钥外泄硬地板（即使 `.claude/` 尚未就位亦强制拦截），并补齐 `Stop` / `SubagentStop` / `PreCompact` 的 `stop_hook_active` 重入防护与外层父目录 `.git` 越界防护。
5. **三层解耦 `cc-base` 自动寻源联装 + 离线合包**：
   - **Tier 1（已有完整 `.claude/`）**：默认直接跳过底座拷贝（零额外写入，极速幂等）；显式传入 `--with-cc` 或 `--cc-base <dir>` 时同步调用上游安装器无损升级 `.claude/`；
   - **Tier 2（空项目自动联装）**：目标尚无完整 `.claude/` 时，按 `--cc-base <dir>` → 离线合包 `.bundled-cc-base/` → `CC_BASE_DIR` → 同级 `../cc-base` 顺序自动发现 `cc-base` 并一步装齐 `.claude/` + `.cac/`（22 套技能 + 8 个子代理角色）；
   - **Tier 3（延迟自愈壳模式）**：未发现 `cc-base` 源或显式传 `--no-auto-cc`（或 `CAC_LINK_NO_AUTO_CC=1`）时，先装 `.cac/` 桥接壳（`exit 0`），后续 `.claude/` 就位后由 `SessionStart` 自动补建联接；
   - **离线一体包（`--bundle-cc`）**：`release <version> --bundle-cc ../cc-base` 可产出内含 `.bundled-cc-base/` 的离线压缩包，内网无兄弟仓环境解压后跑一次 `setup.ps1` / `setup.sh` 即可同时装好 `.claude/` 与 `.cac/`。
6. **100% 幂等重装、无损三路升级与独立版平滑迁移**：
   - 重复执行 `install` N 次零报错、零重复 hook；
   - 本地修改受管文件时升级自动旁落 `*.cac-link-new`，绝不覆盖用户改动；
   - 检测到曾安装独立版 `cac-base` 时，自动将旧实体 `.cac/{skills,agents}` 安全备份至 `.cac/.runtime/migrated-standalone-<ts>/` 并一步切换为桥接链接（内置父级与反向符号链接穿透防护）；
   - 卸载仅摘除符号链接 / NTFS Junction 本身，**100% 绝不触碰 `.claude/` 内的任何真实文件**。

## 环境要求

- **Node.js `>= 20.0.0`**（零 npm 依赖，仅使用内置模块）
- `cc-base` 底座（目标仓库已有 `.claude/`、同级存在 `../cc-base`、使用 `--bundle-cc` 离线包，或先装桥接壳后补装 `.claude/` 均可）

## 快速上手

### Windows PowerShell

```powershell
# 一条命令安装 / 幂等重装（空目录存在 ..\cc-base 或离线包时自动联装 .claude/ + .cac/）
pwsh -NoProfile -File .\setup.ps1 D:\work\my-project

# 显式指定 cc-base 源目录并同步升级 .claude/ + .cac/
pwsh -NoProfile -File .\setup.ps1 -Target D:\work\my-project -WithCc -CcBase D:\work\cc-base

# 仅铺设 .cac/ 桥接壳（跳过自动联装 cc-base，后续由 SessionStart 自愈补链）
pwsh -NoProfile -File .\setup.ps1 -Target D:\work\my-project -NoAutoCc

# 预览安装计划（零磁盘写入）
pwsh -NoProfile -File .\setup.ps1 -Target D:\work\my-project -DryRun

# 运行下游项目桥接健康自检
node D:\work\my-project\.cac\scripts\doctor.mjs D:\work\my-project

# 安全卸载桥接层（100% 保留 .claude/ 全部文件）
pwsh -NoProfile -File .\setup.ps1 -Uninstall -Target D:\work\my-project
```

### Linux / WSL / macOS

```sh
# 一条命令安装 / 幂等重装（空目录存在 ../cc-base 或离线包时自动联装 .claude/ + .cac/）
./setup.sh /path/to/my-project

# 显式指定 cc-base 源目录并同步升级 .claude/ + .cac/
./setup.sh --target /path/to/my-project --with-cc --cc-base /path/to/cc-base

# 仅铺设 .cac/ 桥接壳（延迟自愈模式）
./setup.sh --target /path/to/my-project --no-auto-cc

# 预览安装计划（零磁盘写入）
./setup.sh --target /path/to/my-project --dry-run

# 构建内网离线一体发布包（内置干净 .bundled-cc-base/）
node scripts/cac-base-link.mjs release v1.0.0 --bundle-cc ../cc-base

# 运行下游项目桥接健康自检
node /path/to/my-project/.cac/scripts/doctor.mjs /path/to/my-project

# 安全卸载桥接层（100% 保留 .claude/ 全部文件）
./setup.sh --uninstall --target /path/to/my-project
```

## 维护者自检命令

```sh
# 安装器子模块自检
node scripts/lib/path-guard.mjs --selftest
node scripts/lib/link-manager.mjs --selftest
node scripts/lib/settings-merge.mjs --selftest
node scripts/lib/manifest.mjs --selftest
node scripts/lib/cc-dep.mjs --selftest

# 刷新并校验受管清单 + 语法 + 防隐私泄漏 + 源仓 doctor
node scripts/cac-base-link.mjs manifest --write
node scripts/cac-base-link.mjs pack-check
```
