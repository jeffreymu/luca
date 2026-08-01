# ◆ LucaPi

**Workspace-first multi-agent kanban delivery board** — LucaPi，轻量级 Web 应用，完成任务价值的端到端交付。

LucaPi 把「目标、任务、会话、证据、评审」放在看板上而非埋在单个聊天线程里，并做到 **零 npm 依赖、单命令启动、离线可跑**。

```bash
npm start          # http://localhost:3210
npm run worker     # 可选：启动独立持久化 Worker
npm test           # 134 项基础、平台、可靠性、Skills 与扫描检查
```

要求 Node.js ≥ 22.5（使用内置 `node:http` 与 `node:sqlite`）。涉及文件和命令工具的服务默认仅监听 `127.0.0.1`；如需远程部署，应在反向代理层配置身份认证与 TLS，再显式设置 `HOST`。

---

## LucaPi 核心设计

### 1. 看板即协同总线（Board as coordination bus）

```
Backlog ──▶ Todo ──▶ Dev ──▶ Review ──▶ Done
   ▲          ▲        ▲  ◀──┘  │
   │          │        └────────┘ (entry gate / NOT_APPROVED 打回)
   └──────────┴──────────────── Blocked（恢复道，由 Resolver 诊断后路由回去）
```

每条泳道背后是一个 specialist prompt 契约，且**下游刻意不信任上游**——Todo 重新解析 Backlog 的 story，Review 独立复核 Dev 的自证，Done 校验 Review 的 APPROVED verdict。

### 2. 六位泳道 Specialist

| 泳道 | Specialist | 职责 | 写入卡片的工件 | 放行条件 |
| --- | --- | --- | --- | --- |
| Backlog | Backlog Refiner | 澄清范围，不写代码 | Canonical Story YAML（问题陈述、用户价值、AC、约束、依赖、范围外、INVEST） | story 可解析且独立可执行 → Todo |
| Todo | Todo Orchestrator | 不信任上游，重校验 story | Execution Brief（执行计划、关键文件、依赖计划、风险） | 实现可在数分钟内开始 → Dev |
| Dev | Dev Crafter | 只做 scoped 实现 | Dev Evidence（变更文件、工作总结、测试、逐条 AC 验证、caveats、已提交+工作区干净） | 证据齐备 → Review |
| Review | Review Guard | 质量门，拒绝激进 | Review Findings（verdict、逐条 AC 状态、评审意见） | APPROVED → Done；NOT_APPROVED → Dev；打回 ≥3 次 → Blocked（loop breaker） |
| Done | Done Reporter | 终态，不再移动 | Completion Summary（交付内容、关键证据、完成日期） | 留在 Done |
| Blocked | Blocked Resolver | 分类 blocker、写根因 | Blocker Analysis（类型、根因、解决方案、路由决策） | 有具体下一步才路由回去 |

### 3. 卡片工件随流程增长

同一张卡片从 Backlog 到 Done，依次累积 `story → brief → evidence → review → summary`，每列改变下一个 specialist 被允许信任的内容。看板因此不只是状态展示，而是**信任递减的审计链**。

### 4. Entry Gates（不信任上游）

Review Guard 的入门检查：缺 Dev Evidence / 缺变更文件 / 缺逐条 AC 验证 / 缺测试证据 / 未提交或工作区脏 → 直接打回 Dev。Done Reporter 校验 Review verdict 必须为 APPROVED，否则打回 Review。

### 5. Sessions & Traces 是一等公民

每次 specialist 运行生成一个 Session，内部按序记录 `gate / artifact / decision / error` trace，UI 中可逐条展开审计。

---

## LLM Provider

三种配置方式，按优先级生效（**每次 specialist 运行时动态解析，改配置即时生效，无需重启**）：

1. **⚙ Providers 设置界面（推荐）**：顶栏点击 `⚙ Providers` 或 provider 徽标，添加任何 OpenAI 兼容端点（OpenAI / DeepSeek / 通义 / 本地 Ollama / vLLM…），支持多个配置、启用/停用切换、连通性测试、删除。API Key 持久化在本地 SQLite，接口与 UI 只返回脱敏后的 key。
2. **环境变量**（无 DB 配置时的兜底；旧 `LUCA_*` 名称仍兼容）：

```bash
export LUCAPI_LLM_BASE_URL=https://api.openai.com/v1
export LUCAPI_LLM_API_KEY=sk-...
export LUCAPI_LLM_MODEL=gpt-4o-mini
npm start
```

3. **Simulated Provider**（默认）：离线、确定性，严格按泳道契约产出结构化工件。内置「不信任循环」演示——多 AC 卡片首轮 Dev 会留下一条单薄验证，Review Guard 必然打回，Dev 修复后二审通过，完整展示 LucaPi 的 distrust 语义。

真实 LLM 模式下，每个 specialist 用其泳道契约作为 system prompt，要求模型输出 JSON 工件；结构化泳道输出经 `normalize` 契约校验，失败时回退 simulated provider 并记录 Trace。Dev 真实编码执行失败则进入 Blocked，绝不伪造代码交付。Session 会记录实际 Provider、Agent 和工具调用。Provider 面板支持模型列表、Tool Calling 与结构化 JSON 三项能力诊断。

### Provider API

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/providers` | 当前生效的 provider + 全部配置（key 脱敏） |
| POST | `/api/providers` | 新增 `{name, baseUrl, apiKey, model, setActive}` |
| PATCH | `/api/providers/:id` | 修改；`apiKey` 留空表示保留原 key |
| DELETE | `/api/providers/:id` | 删除 |
| POST | `/api/providers/:id/activate` · `/api/providers/deactivate` | 启用 / 停用 |
| POST | `/api/providers/:id/test` | 连通性测试（GET /models，返回延迟与模型可用性） |

## API 一览

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/state?workspaceId=` | workspace + board + cards + sessions 全量状态 |
| POST | `/api/workspaces` | 新建 workspace（自动建默认 board） |
| POST | `/api/boards/:id/cards` | 新建卡片到 Backlog |
| POST | `/api/boards/:id/run` | **Board automation sweep**：按泳道顺序处理全部卡片直到看板稳定 |
| POST | `/api/cards/:id/run` | 运行当前泳道的 specialist 一次 |
| POST | `/api/cards/:id/move` | 手动移动（会记录 blocked_from） |
| GET/PATCH/DELETE | `/api/cards/:id` | 卡片读写删 |
| GET | `/api/cards/:id/sessions` · `/api/sessions/:id` | 会话与 trace 审计 |
| GET | `/api/events` | SSE，看板实时刷新 |

## 五阶段自主交付能力

### 阶段 1：真实 Coding Agent Runtime

真实 LLM 在 Dev 泳道进入工具调用循环，可使用 `read_file`、`write_file`、`list_files`、`search_files`、`run_command`、`git_status`、`git_diff`。所有文件路径限制在任务 worktree 内；命令以 `execFile` 无 Shell 执行，并受 allowlist 与 timeout 约束。

### 阶段 2：隔离 Worktree 与真实证据

卡片进入 Dev 时自动从 base commit 创建 `lucapi/<task>-<id>` 分支和独立 worktree。实现结束后自动运行项目检测到的 test/lint/typecheck、提交变更，并从 Git 采集真实 diff、changed files、commit SHA、command exit code 和 tool calls。Review 在独立阶段重新运行验证并检查真实 diff/clean 状态；卡片可 Push & PR。

### 阶段 3：可靠持久化执行

`jobs` 表提供 durable queue、优先级、attempt、max attempts、指数退避、Job/Execution Lease、心跳、Cancel、Retry、死信恢复、Worker Identity 与进程重启恢复。Board Automation UI 默认入队；可关闭内嵌 Worker 并运行一个或多个本机独立 Worker。Schedule Tick 使用原子领取和同一队列。

### 阶段 4：DAG、多 Agent 与可配置流程

支持自然语言 Goal 拆卡、父子卡、dependencies、Ready Task、priority/assignee/tags；Agent Registry 真正参与卡片分配、按泳道能力选择、Agent Provider 覆盖、失败重新分配；Team Run 支持团队消息与启动审批硬门禁。Workflow 可创建卡片 DAG 并触发后台执行；每条泳道 Specialist 可修改 Prompt、启停并绑定独立 Provider。

### 阶段 5：平台扩展

提供统一 Platform Console、版本化 Skill Registry、Skill 生成/导入/发布、统一代码扫描、MCP JSON-RPC、路径/符号链接/命令参数边界、Coding Agent 自动 Docker Sandbox、Repository Intelligence、Harness/Fitness、Cron/时区/并发策略 Schedule、幂等/过滤/限流/HMAC Webhook，以及 GitHub Issues、PR、Check Run、评论和交付。高风险操作可配置一次性 Approval 门禁。

## Skills：生成、导入与版本发布

Skill 包由 `SKILL.md` 和可选 `skill.json` 组成。支持三种来源：

```json
{"type":"content","skillMarkdown":"---\nname: code-review\nversion: 1.0.0\n---\n\n1. Review the diff..."}
{"type":"directory","path":"/workspace/skills/code-review"}
{"type":"git","url":"https://github.com/org/skills.git","ref":"v1.0.0","subdirectory":"skills/code-review"}
```

导入过程限制 100 个文件/1 MiB，拒绝符号链接、路径逃逸、URL 内嵌凭证和危险命令声明。外部目录与所有 Git 来源需要一次性 Approval。每次导入保存不可变版本、SHA-256 Checksum、来源 URI/Commit 和 Sandbox Policy Validation；版本先进入 `DRAFT`，批准后才能 `PUBLISHED`，并支持批准后回滚。包含扫描器的 `pre-dev`、`post-dev`、`review` Hook 会自动生成对应 Scan Profile 并进入交付门禁。发布后的完整 Skill 包会在 Agent 执行期间临时物化到任务 Worktree 的 `.lucapi-skills/<name>`，供 instructions、references 和 scripts 使用，并在验证/提交前清理，绝不进入产品 Diff。真实 Provider 可执行“需求描述 → Skill 草稿”生成。内置 Skill 包括 `code-review`、`security-scan` 和 `sonarqube`。

主要 API：

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/skills/import` | 从 content/directory/git 导入 |
| POST | `/api/skills/generate` | 使用真实 LLM 生成 Skill 草稿 |
| POST | `/api/skills/builtins` | 安装三个内置 Skill 草稿 |
| GET | `/api/skills/:id/versions` | 不可变版本历史 |
| POST | `/api/skill-versions/:id/validate` | 重新执行 Sandbox Policy Validation |
| POST | `/api/skill-versions/:id/request-publish` | 创建发布 Approval |
| POST | `/api/skill-versions/:id/publish` | 消费 Approval 并发布/回滚版本 |

## Code Review、SonarQube 与安全扫描

`Scan Profile → Durable scan.run Job → Scan Run → Normalized Findings → Review Gate`。统一 Finding 包含 scanner、rule ID、severity、category、文件/行号、fingerprint、是否新增和抑制状态。Review Hook 会阻断配置的严重度；Scanner 基础设施失败由 `failOnScannerError` 决定，绝不伪造扫描通过。

支持：

- `code-review`：真实 Diff + Acceptance Criteria 的独立模型评审
- `lucapi-secret`：内置私钥、凭证模式和敏感文件检测
- Gitleaks、Semgrep、Trivy、OSV-Scanner：宿主 CLI 或固定版本 Docker 镜像
- SonarQube/SonarCloud：Scanner、Compute Engine 轮询、Quality Gate、Issues、Branch/PR Analysis
- SARIF 2.1.0 导入/导出
- Finding Fingerprint、New Findings Only 和跨运行 Suppression
- GitHub Check Run、最多 50 条 Annotation、PR 评论和可选 APPROVE/REQUEST_CHANGES Review

Profile 示例：

```json
{
  "workspaceId": "...",
  "name": "Security Gate",
  "hook": "review",
  "scanners": ["lucapi-secret", "gitleaks", "semgrep", "trivy", "osv-scanner"],
  "policy": {
    "blockOn": ["critical", "high"],
    "failOnScannerError": true,
    "newFindingsOnly": true
  },
  "config": {
    "execution": "docker",
    "network": false,
    "timeoutMs": 300000
  }
}
```

Sonar Profile 的 `config.sonarqube` 接受 `serverUrl`、`projectKey`、`organization`、`token`、`branch` 或 `pullRequest`。Token 使用 `LUCAPI_SECRET_KEY` 加密且 API 只返回 `hasToken`。Sonar 和其他联网扫描在执行前自动创建一次性 `scan.network` Approval。

扫描 API：

| Method | Path | 说明 |
| --- | --- | --- |
| GET/POST | `/api/scan-profiles` | 管理扫描 Profile |
| POST | `/api/scans/run` | 通过持久化队列执行 Profile |
| GET | `/api/scans/:id` | Run、Summary 与 Findings |
| POST | `/api/scans/import-sarif` | 导入 SARIF |
| GET | `/api/scans/:id/sarif` | 导出 SARIF |
| POST | `/api/scan-findings/:id/suppress` | 按 Fingerprint 抑制/恢复 |
| POST | `/api/scans/:id/publish-github` | 发布 Check Run 和可选 PR 评论 |

## 生产运行与安全配置

```bash
export LUCAPI_API_TOKEN='用于保护除 health/webhook 外的 API'
export LUCAPI_SECRET_KEY='用于 AES-256-GCM 加密数据库中的凭证'
export LUCAPI_EMBEDDED_WORKER=false  # Web 进程不内嵌 Worker
export LUCAPI_WORKER_CONCURRENCY=4
npm start &
npm run worker
```

设置 API Token 后，浏览器可通过顶栏 🔑 保存 Token，或首次使用 `?token=` 导入。Workspace 的 Git 设置可选择 `local`、`auto` 或强制 `docker` Sandbox，并配置镜像、验证命令和 `requireApprovalFor`（如 `git.push`、`git.pr`、`card.deliver`、`card.delete`、`worktree.remove`、`sandbox.network`）。Webhook 接收端不使用平台 Token，而依赖各配置自己的 HMAC Secret。

## Git / GitHub 操作

顶栏 **⎇ Git** 面板对当前 workspace 的 worktree（`repo_path` 指向的本地仓库）提供：

- **状态**：当前分支、upstream、ahead/behind、变更文件列表、最后提交、GitHub slug
- **Pull**：`--ff-only`（默认）或 `--rebase`
- **Commit & Push**：`git add -A` → 用填写的提交信息 commit → `git push -u origin HEAD`，把当前 worktree 的全部变更推送到远程
- **Create PR**：调 GitHub REST API（兼容企业版，可配 API base）；同分支已有开放 PR 时返回已有 PR 而不是报错
- **GitHub 设置**：token（本地 SQLite 存储，接口与 UI 只显示脱敏形式，亦可用 `GITHUB_TOKEN` 环境变量）、仓库 slug（留空则从 `origin` 自动推断 `owner/repo`）、API base

所有 git 调用使用参数数组（无 shell 注入面），超时与 stderr 会转成可读错误。

### Git API

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/workspaces/:id/git/status` | 分支、ahead/behind、变更列表、remote、repoSlug |
| POST | `/api/workspaces/:id/git/pull` | `{rebase?}` |
| POST | `/api/workspaces/:id/git/push` | `{message}` 提交全部变更并推送 |
| POST | `/api/workspaces/:id/git/pr` | `{title, body?, base?, head?}` 创建或返回已有 PR |
| PATCH | `/api/workspaces/:id` | `{repoPath, githubToken, githubRepo, githubApiBase}`（token 留空保持不变） |

## 项目结构

```
server.js            # HTTP 服务（REST + SSE + 静态 SPA），零依赖
src/db.js            # node:sqlite 持久化（workspaces/boards/cards/sessions/traces/jobs）
src/specialists.js   # 六位泳道 specialist 的 prompt 契约 + entry gates + 模拟实现
src/engine.js        # 交付引擎：distrust 门、决策应用、automation sweep
src/providers.js     # LLM provider 抽象（simulated / OpenAI 兼容）
src/git.js            # worktree git 操作（status / pull / commit+push）
src/github.js         # GitHub REST API（PR、评论和 Check Run）
src/skill-service.js  # Skill Manifest、导入、生成、版本、验证与发布
src/scan-service.js   # Code Review、Sonar、安全扫描、SARIF 与门禁
public/               # 看板 SPA（泳道、卡片抽屉、工件时间线、session/trace、Providers 与 Git 面板）
test/smoke.js         # 60 项基础端到端检查
test/platform.js      # 48 项真实 Agent、worktree、队列、DAG、安全与平台集成检查
test/hardening.js     # 4 项多 Worker 原子领取、Lease 恢复、死信恢复与凭证静态加密检查
test/skills-scanning.js # 22 项 Skill 生命周期、SARIF、安全扫描与 SonarQube 检查
```

## 设计边界

当前版本聚焦本地 Web 交付运行时。支持同一 SQLite 数据库上的多进程 Worker，但不把 SQLite 放在网络文件系统上，因此跨主机分布式队列仍不在当前范围内。桌面应用打包、企业级 OIDC/RBAC 和远程 Secret Manager 也不在当前版本范围内；远程部署应设置 `LUCAPI_API_TOKEN`、`LUCAPI_SECRET_KEY` 并由反向代理提供 TLS。
