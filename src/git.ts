/**
 * Git adapter for the ticket dispatcher.
 *
 * Handles worktree creation, branch management, commits, and integration
 * using git worktrees. Each ticket gets its own worktree so multiple
 * workers can operate in parallel without conflicts.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

/** Result of running a git command. */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a git command in the given directory. No shell: args are passed verbatim. */
export function gitRun(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    return {
      stdout: "",
      stderr: result.error.message || String(result.error),
      exitCode: 1,
    };
  }
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    exitCode: result.status ?? 1,
  };
}

/** Get the current branch name of a repo. */
export function getCurrentBranch(repoPath: string): string {
  const result = gitRun(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get current branch: ${result.stderr}`);
  }
  return result.stdout;
}

/** Get the absolute path to the main repo's git directory. */
export function getGitDir(repoPath: string): string {
  const result = gitRun(repoPath, ["rev-parse", "--git-dir"]);
  if (result.exitCode !== 0) {
    throw new Error(`Not a git repo: ${repoPath}`);
  }
  return path.resolve(repoPath, result.stdout);
}

/** Check if a branch already exists. */
export function branchExists(repoPath: string, branchName: string): boolean {
  const result = gitRun(repoPath, ["branch", "--list", branchName]);
  return result.exitCode === 0 && result.stdout.length > 0;
}

/** Canonicalize a path so symlinked prefixes (e.g. /var vs /private/var on macOS) compare equal. */
export function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** List existing worktrees for a repo. */
export function listWorktrees(repoPath: string): Array<{ path: string; branch: string; bare: boolean }> {
  const result = gitRun(repoPath, ["worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list worktrees: ${result.stderr}`);
  }

  const worktrees: Array<{ path: string; branch: string; bare: boolean }> = [];
  let current: any = {};

  for (const line of result.stdout.split("\n")) {
    if (line === "") {
      if (current.path) {
        worktrees.push(current);
        current = {};
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      current.path = line.slice(9);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  if (current.path) {
    worktrees.push(current);
  }

  return worktrees;
}

/**
 * Create a worktree for a ticket branch.
 * If the branch doesn't exist, it's created from baseBranch.
 * Returns the absolute path to the new worktree.
 */
export function createWorktree(params: {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
}): string {
  const { repoPath, worktreePath, branchName, baseBranch } = params;

  // Check if worktree already exists (compare canonically: git may record
  // the realpath, e.g. /private/var when we passed /var on macOS).
  const existing = listWorktrees(repoPath).find(
    (w) => canonicalPath(w.path) === canonicalPath(worktreePath)
  );
  if (existing) {
    return existing.path;
  }

  // Create branch if it doesn't exist
  if (!branchExists(repoPath, branchName)) {
    const result = gitRun(repoPath, ["branch", branchName, baseBranch]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create branch ${branchName}: ${result.stderr}`);
    }
  }

  // Create worktree directory parent
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Create worktree
  const result = gitRun(repoPath, [
    "worktree",
    "add",
    worktreePath,
    branchName,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create worktree at ${worktreePath}: ${result.stderr}`
    );
  }

  return worktreePath;
}

/** Remove a worktree. */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  const existing = listWorktrees(repoPath).find(
    (w) => canonicalPath(w.path) === canonicalPath(worktreePath)
  );
  if (!existing) {
    return; // already gone
  }

  const result = gitRun(repoPath, ["worktree", "remove", "--force", worktreePath]);
  if (result.exitCode !== 0) {
    // Fallback: just prune
    gitRun(repoPath, ["worktree", "prune"]);
  }
}

/** Get the latest commit SHA for a branch in a worktree. */
export function getHeadCommit(worktreePath: string): string {
  const result = gitRun(worktreePath, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get HEAD commit: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Check if the worktree has any new commits compared to the base branch.
 * Returns true if there are new commits.
 */
export function hasNewCommits(worktreePath: string, baseBranch: string): boolean {
  const result = gitRun(worktreePath, [
    "rev-list",
    "--count",
    `origin/${baseBranch}..HEAD`,
  ]);
  // Try without origin prefix if that fails
  if (result.exitCode !== 0) {
    const result2 = gitRun(worktreePath, [
      "rev-list",
      "--count",
      `${baseBranch}..HEAD`,
    ]);
    return result2.exitCode === 0 && parseInt(result2.stdout, 10) > 0;
  }
  return parseInt(result.stdout, 10) > 0;
}

/**
 * Get the diff of changes in the worktree compared to the base branch.
 */
export function getDiff(worktreePath: string, baseBranch: string): string {
  const result = gitRun(worktreePath, ["diff", `${baseBranch}...HEAD`]);
  if (result.exitCode !== 0) {
    // Try without ...
    const result2 = gitRun(worktreePath, ["diff", baseBranch, "HEAD"]);
    if (result2.exitCode !== 0) {
      throw new Error(`Failed to get diff: ${result.stderr}`);
    }
    return result2.stdout;
  }
  return result.stdout;
}

/**
 * Integrate (merge) a ticket branch into the base branch.
 * Performs the merge in the main repo.
 * Returns the merge commit SHA.
 */
export function integrateBranch(params: {
  repoPath: string;
  branchName: string;
  baseBranch: string;
  ticketId: string;
}): string {
  const { repoPath, branchName, baseBranch, ticketId } = params;

  // Checkout base branch
  let result = gitRun(repoPath, ["checkout", baseBranch]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to checkout ${baseBranch}: ${result.stderr}`);
  }

  // Merge with --no-ff to preserve branch topology
  result = gitRun(repoPath, [
    "merge",
    "--no-ff",
    branchName,
    "-m",
    `Integrate ticket ${ticketId}: ${branchName}`,
  ]);

  if (result.exitCode !== 0) {
    // Merge conflict - abort and report
    gitRun(repoPath, ["merge", "--abort"]);
    throw new Error(
      `Merge conflict when integrating ${branchName} into ${baseBranch}: ${result.stderr}`
    );
  }

  return getHeadCommit(repoPath);
}

/**
 * Get a short commit log (subject lines) between base and branch.
 */
export function getCommitLog(worktreePath: string, baseBranch: string): string {
  const result = gitRun(worktreePath, [
    "log",
    `--oneline`,
    `${baseBranch}..HEAD`,
  ]);
  if (result.exitCode !== 0) return "";
  return result.stdout;
}

/**
 * Check if the worktree has uncommitted changes.
 */
export function isWorktreeDirty(worktreePath: string): boolean {
  const result = gitRun(worktreePath, ["status", "--porcelain"]);
  return result.exitCode === 0 && result.stdout.length > 0;
}
