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

export function show(cwd: string, rev: string, path: string): string {
  return git(cwd, ["show", `${rev}:${path}`]);
}
