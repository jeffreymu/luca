import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git.js";

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "task";
}

export class WorktreeManager {
  async ensure({ repoPath, card }) {
    if (card.worktree_path) return { path: card.worktree_path, branch: card.branch_name, reused: true };
    const baseBranch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath)).stdout.trim();
    const baseCommit = (await runGit(["rev-parse", "HEAD"], repoPath)).stdout.trim();
    const branch = `lucapi/${slug(card.title)}-${card.id.slice(0, 8)}`;
    // Recover a worktree created just before a process crash but not yet saved.
    const listing=(await runGit(["worktree","list","--porcelain"],repoPath)).stdout.split("\n\n");
    for(const block of listing){const lines=block.split("\n"),branchLine=lines.find((l)=>l===`branch refs/heads/${branch}`),pathLine=lines.find((l)=>l.startsWith("worktree "));if(branchLine&&pathLine)return{path:pathLine.slice(9),branch,baseBranch,baseCommit,reused:true};}
    // Keep execution copies outside the primary worktree so they never appear
    // as untracked content in the user's repository.
    const root = path.join(path.dirname(repoPath), ".lucapi-worktrees", path.basename(repoPath));
    const worktreePath = path.join(root, card.id);
    await mkdir(root, { recursive: true });
    await runGit(["worktree", "add", "-b", branch, worktreePath, baseCommit], repoPath);
    return { path: worktreePath, branch, baseBranch, baseCommit, reused: false };
  }

  async validate(worktreePath) {
    const root = (await runGit(["rev-parse", "--show-toplevel"], worktreePath)).stdout.trim();
    const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)).stdout.trim();
    const [realRoot, realExpected] = await Promise.all([realpath(root), realpath(worktreePath)]);
    return { healthy: realRoot === realExpected, root, branch };
  }

  async remove(repoPath, worktreePath, { force = false } = {}) {
    await runGit(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], repoPath);
    await rm(worktreePath, { recursive: true, force: true });
    await runGit(["worktree", "prune"], repoPath);
  }
}
