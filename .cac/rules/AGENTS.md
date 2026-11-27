# AGENTS.md — cac-base-link 桥接主控入口

@../../.claude/CLAUDE.md

[codeagent 宿主桥接补充协议]
1. **内联兜底**：若当前上下文未见上方展开的 `[角色]` `SiteMaster` 全文，首轮回复前先调一次 `Read .claude/CLAUDE.md` 载入主控宪法。
2. **强制细则前置 `Read` 指针**（`codeagent` 不按 `paths:` 自动注入细则，命中动作前必须显式 `Read`）：
   - 进入任意开发阶段或执行各阶段话术前 → `Read .claude/rules/dev-workflow-details.md`
   - 组装七字段派单包或派发任何 Sub-Agent 前 → `Read .claude/rules/subagent-dispatch.md`
   - 并行编排多个 Sub-Agent 或切分并行任务前 → `Read .claude/rules/workflow-orchestration.md`
   - 生成、核对或重排项目目录结构前 → `Read .claude/rules/file-structure.md`
   - 写项目记忆、归档或记录 feedback 前 → `Read .claude/rules/memory-systems.md`
   - 编写、核对或派单触及 `docs/design/` 设计详述前 → `Read .claude/rules/design-detail.md`
   - 收录或裁定 `domain/` 领域口径前 → `Read .claude/rules/domain-rulings.md`
   - 当 `.claude/harness/module-catalog.json` 存在时 → `Read .claude/rules/harness-large-repo.md` 与 `Read .claude/rules/quality-attributes.md`
3. **宿主差异适配**：
   - 无 `subagent_type: "fork"`：派发 `progress-recorder` / `feedback-observer` 时，主 Agent 显式传入本轮决策/约束/完成或用户反馈原话的结构化上下文摘录与涉及文件路径。
   - 无 `code-review-fanout.js`：多维审查改由主 Agent 按维度并行调多次 `Agent(subagent_type: "code-reviewer")` 并由主 Agent 汇总裁定。
   - 角色长期记忆：`code-reviewer` / `tester` 启动与收尾时显式读写 `.claude/agent-memory/<role>/MEMORY.md`。
   - 桥接健康自检：在 `codeagent`（尤其 Windows PowerShell）环境下优先运行 `node .cac/scripts/doctor.mjs`。
4. **开场零工具秒回与工作目录硬边界**：
   - `SessionStart` 已预注 `当前项目启动快照`；新项目根目录零入侵下普通 `ls` / `Glob "*"` 为空属正常现象，首轮寒暄/问路直接按快照**零工具秒回**，无需调命令探测目录。
   - 严禁运行 `ls ..` 或越界读取、暂存、提交外层父目录及其 `.git`。
