import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git.js";

function exec(command, args, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        command: [command, ...args].join(" "),
        exitCode: error?.code && Number.isInteger(error.code) ? error.code : error ? 1 : 0,
        stdout: String(stdout).slice(-20_000),
        stderr: String(stderr).slice(-20_000),
        durationMs: Date.now() - started,
      });
    });
  });
}

export async function collectGitEvidence(repoPath, baseCommit) {
  const headCommit = (await runGit(["rev-parse", "HEAD"], repoPath)).stdout.trim();
  const status = (await runGit(["status", "--porcelain"], repoPath)).stdout.trim();
  const range = baseCommit && baseCommit !== headCommit ? `${baseCommit}..${headCommit}` : "HEAD";
  const names = (await runGit(["diff", "--name-only", range], repoPath)).stdout.trim();
  const stat = (await runGit(["diff", "--stat", range], repoPath)).stdout.trim();
  const diff = (await runGit(["diff", "--no-ext-diff", "--unified=3", range], repoPath)).stdout.slice(0, 100_000);
  return {
    headCommit,
    clean: status === "",
    status,
    changedFiles: names ? names.split("\n") : [],
    diffStat: stat,
    diff,
  };
}

export async function detectValidationCommands(repoPath) {
  try {
    const pkg=JSON.parse(await readFile(path.join(repoPath,"package.json"),"utf8"));
    const scripts=pkg.scripts||{}; const commands=[];
    if (scripts.test) commands.push(["npm","test"]);
    if (scripts.lint) commands.push(["npm","run","lint"]);
    if (scripts.typecheck) commands.push(["npm","run","typecheck"]);
    return commands;
  } catch {}
  try { await access(path.join(repoPath,"Cargo.toml")); return [["cargo","test"]]; } catch {}
  try { await access(path.join(repoPath,"pyproject.toml")); return [["pytest"]]; } catch {}
  return [];
}

export async function runValidation(repoPath, commands = []) {
  const results = [];
  for (const item of commands) {
    const [command, ...args] = Array.isArray(item) ? item : String(item).trim().split(/\s+/);
    if (!command) continue;
    results.push(await exec(command, args, repoPath));
  }
  return results;
}

export function evidenceMarkdown({ git, commands, toolCalls = [], summary = "" }) {
  const commandLines = commands.length
    ? commands.map((r) => `- \`${r.command}\` — exit ${r.exitCode} (${r.durationMs}ms)`).join("\n")
    : "- 未配置验证命令";
  return `## Real Execution Evidence\n\n- **Summary**: ${summary}\n- **Head commit**: \`${git.headCommit}\`\n- **Worktree clean**: ${git.clean ? "yes" : "no"}\n- **Changed files**: ${git.changedFiles.length ? git.changedFiles.map((f) => `\`${f}\``).join(", ") : "none"}\n- **Diff stat**: ${git.diffStat || "none"}\n\n### Commands\n${commandLines}\n\n### Tool calls\n${toolCalls.map((t) => `- ${t.tool}: ${t.ok ? "ok" : "failed"}`).join("\n") || "- none"}`;
}
