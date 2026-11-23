import { execFileSync } from "child_process";

export interface FileChange {
  status: "A" | "M" | "D";
  path: string;
}

// stderr is captured rather than inherited, so expected failures (a probe for a missing file or
// branch) do not print "fatal: ..." into the pipeline log. A real failure still carries it in the
// thrown error's message.
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    // Never wait on a credential prompt or a credential manager window.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...env },
  });
}

/**
 * Git config for one command that sends `token` to the remote, passed through the environment so it
 * never appears on a command line. Basic auth with an empty user accepts both the job token and a PAT.
 */
function authEnv(token: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`:${token}`).toString("base64")}`,
  };
}

export function changedFiles(cwd: string, base: string): FileChange[] {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    throw new Error(
      `Cannot find base revision '${base}' in the checkout. For a pull request merge checkout, set fetchDepth: 2 or more ` +
        "on the checkout step. For a source branch checkout, fetch the target branch and set baseRevision.",
    );
  }
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

/**
 * Resolves origin/<branch>, fetching it shallowly when the checkout lacks it. The agent's shallow
 * checkout fetches only the built commit and keeps no credentials, so `token` (the job token, for
 * Azure Repos) is used for that fetch. Undefined when unreachable.
 */
export function remoteBranch(cwd: string, branch: string, token?: string): string | undefined {
  const ref = `refs/remotes/origin/${branch}`;
  for (const fetch of [false, true]) {
    if (fetch) {
      try {
        git(cwd, ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", `+refs/heads/${branch}:${ref}`], token ? authEnv(token) : {});
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
