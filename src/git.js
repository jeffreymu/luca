/**
 * Git operations on a workspace's local repo (worktree), via the git CLI.
 * All invocations use argument arrays (no shell), with timeouts and
 * captured stderr for operator-friendly error messages.
 */
import { execFile } from "node:child_process";

const GIT_TIMEOUT = 60_000;

export function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message).trim().slice(0, 500);
        reject(new Error(`git ${args[0]} 失败: ${detail}`));
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

async function tryGit(args, cwd) {
  try {
    return await runGit(args, cwd);
  } catch {
    return null;
  }
}

/** Snapshot of the worktree: branch, cleanliness, changes, ahead/behind, remote. */
export async function gitStatus(repoPath) {
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath)).stdout.trim();
  const porcelain = (await runGit(["status", "--porcelain=v1", "--branch"], repoPath)).stdout;
  const lines = porcelain.split("\n").filter(Boolean);

  let ahead = 0;
  let behind = 0;
  let upstream = null;
  const header = lines[0]?.startsWith("##") ? lines.shift() : "";
  const upMatch = header.match(/\.\.\.([^\s\[]+)/);
  if (upMatch) upstream = upMatch[1];
  const aheadMatch = header.match(/ahead (\d+)/);
  const behindMatch = header.match(/behind (\d+)/);
  if (aheadMatch) ahead = Number(aheadMatch[1]);
  if (behindMatch) behind = Number(behindMatch[1]);

  const changes = lines.map((line) => ({
    xy: line.slice(0, 2),
    path: line.slice(3).replace(/^"(.*)"$/, "$1"),
  }));

  const remoteUrl = (await tryGit(["remote", "get-url", "origin"], repoPath))?.stdout.trim() || null;
  const last = (await tryGit(["log", "-1", "--format=%h|%s|%cr"], repoPath))?.stdout.trim();
  const [lastHash, lastSubject, lastWhen] = last ? last.split("|") : [];

  return {
    repoPath,
    branch,
    upstream,
    ahead,
    behind,
    clean: changes.length === 0,
    changes,
    remoteUrl,
    lastCommit: lastHash ? { hash: lastHash, subject: lastSubject, when: lastWhen } : null,
  };
}

/** git pull (--ff-only by default, --rebase on request). */
export async function gitPull(repoPath, { rebase = false } = {}) {
  const args = rebase ? ["pull", "--rebase"] : ["pull", "--ff-only"];
  const { stdout, stderr } = await runGit(args, repoPath);
  return { output: (stdout + stderr).trim() || "Already up to date." };
}

/**
 * Stage everything, commit with `message` (if there is anything to commit),
 * then push to origin with upstream tracking. Returns what happened.
 */
export async function gitPush(repoPath, { message }) {
  await runGit(["add", "-A"], repoPath);

  let committed = null;
  const staged = await tryGit(["diff", "--cached", "--quiet"], repoPath);
  if (staged === null) {
    // exit code 1: there are staged changes
    const msg = (message ?? "").trim() || "chore: update via Luca";
    await runGit(["commit", "-m", msg], repoPath);
    committed = (await runGit(["rev-parse", "--short", "HEAD"], repoPath)).stdout.trim();
  }

  const { stdout, stderr } = await runGit(["push", "-u", "origin", "HEAD"], repoPath);
  return {
    committed,
    pushed: true,
    output: (stdout + stderr).trim(),
    note: committed ? `已提交 ${committed} 并推送。` : "工作区无新变更，已推送现有提交。",
  };
}
