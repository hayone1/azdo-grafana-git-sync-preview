import { execFileSync } from "child_process";

export interface FileChange {
  status: "A" | "M" | "D";
  path: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function changedFiles(cwd: string, base: string): FileChange[] {
  const out = git(cwd, ["diff", "--name-status", "--no-renames", "-z", base, "HEAD"]);
  const fields = out.split("\0").filter(Boolean);
  const changes: FileChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const s = fields[i][0];
    changes.push({ status: s === "A" || s === "D" ? s : "M", path: fields[i + 1] });
  }
  return changes;
}

export function trackedFiles(cwd: string): string[] {
  return git(cwd, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

/** Whether `path` exists at `rev`. */
export function existsAt(cwd: string, rev: string, path: string): boolean {
  try {
    git(cwd, ["cat-file", "-e", `${rev}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/** Resolves origin/<branch>, fetching it shallowly when the checkout lacks it. Undefined when unreachable. */
export function remoteBranch(cwd: string, branch: string): string | undefined {
  const ref = `refs/remotes/origin/${branch}`;
  for (const fetch of [false, true]) {
    if (fetch) {
      try {
        git(cwd, ["fetch", "--quiet", "--depth=1", "origin", `+refs/heads/${branch}:${ref}`]);
      } catch {
        return undefined;
      }
    }
    try {
      git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
      return ref;
    } catch {
      // not there yet
    }
  }
  return undefined;
}

export function show(cwd: string, rev: string, path: string): string {
  return git(cwd, ["show", `${rev}:${path}`]);
}
