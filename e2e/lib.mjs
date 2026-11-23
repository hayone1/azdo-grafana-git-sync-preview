// Helpers for the end-to-end test in run.mjs: HTTP with retries, Azure DevOps and Grafana clients,
// fixtures, agent-like git checkouts, running the built task, and parsing its comment.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const yaml = require("../tasks/GrafanaGitSyncPreview/node_modules/js-yaml");

const here = dirname(fileURLToPath(import.meta.url));
const taskDir = resolve(here, "../tasks/GrafanaGitSyncPreview");
const taskEntry = join(taskDir, "dist/index.js");
const taskJson = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));

const env = process.env;
export const config = {
  missing: ["AZDO_URL", "AZDO_PAT", "AZDO_PROJECT"].filter((k) => !env[k]),
  org: (env.AZDO_URL ?? "").replace(/\/?$/, "/"),
  project: env.AZDO_PROJECT,
  repoName: env.AZDO_E2E_REPO || "grafana-git-sync-e2e",
  grafanaUrl: (env.GRAFANA_URL ?? "").replace(/\/+$/, ""),
  grafanaOrgId: env.GRAFANA_ORG_ID || "1",
  proxyUrl: env.GIT_PROXY_URL,
  proxyToken: env.GIT_PROXY_TOKEN,
  pipelineTask: env.E2E_PIPELINE_TASK,
  pipelinePool: env.E2E_PIPELINE_POOL,
  keep: Boolean(env.E2E_KEEP),
  bulkCount: Number(env.E2E_BULK_COUNT || 400),
};
config.withGrafana = Boolean(config.grafanaUrl && config.proxyUrl);
config.orgName = config.org ? new URL(config.org).pathname.split("/").filter(Boolean)[0] : "";
config.cloneUrl = `${config.org}${encodeURIComponent(config.project ?? "")}/_git/${encodeURIComponent(config.repoName)}`;

export const azdoAuth = "Basic " + Buffer.from(`:${env.AZDO_PAT}`).toString("base64");
export const grafanaAuth = env.GRAFANA_TOKEN
  ? `Bearer ${env.GRAFANA_TOKEN}`
  : "Basic " + Buffer.from(`${env.GRAFANA_USER}:${env.GRAFANA_PASSWORD}`).toString("base64");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON over HTTP. Retries network errors, 429 and 5xx with backoff, since a single flaky call to a
 * shared service should not fail a 15-minute run. Statuses in `allow` are returned, not thrown.
 */
export async function http(auth, method, url, body, { allow = [], raw = false, retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: raw ? "*/*" : "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw new Error(`${method} ${url}: ${e.message}`);
    }
    if ((resp.status === 429 || resp.status >= 500) && !allow.includes(resp.status) && attempt < retries) {
      const after = Number(resp.headers.get("retry-after"));
      await sleep(after > 0 ? after * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    const text = await resp.text();
    // Azure DevOps answers a bad PAT with a redirect to its sign-in page.
    if (resp.status >= 300 && resp.status < 400) throw new Error(`${method} ${url}: ${resp.status} redirect to sign-in; is the token valid?`);
    if (!resp.ok && !allow.includes(resp.status)) throw new Error(`${method} ${url}: ${resp.status} ${text.slice(0, 500)}`);
    if (raw) return { status: resp.status, text };
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(`${method} ${url}: ${resp.status}, not JSON: ${text.slice(0, 200)}`);
    }
    return { status: resp.status, json };
  }
}

/** Project-scoped Azure DevOps REST call. */
export const azdo = async (method, path, body, opts) =>
  (await http(azdoAuth, method, `${config.org}${encodeURIComponent(config.project)}/_apis/${path}${path.includes("?") ? "&" : "?"}api-version=7.1`, body, opts)).json;
export const grafana = (method, path, body, opts) => http(grafanaAuth, method, `${config.grafanaUrl}${path}`, body, opts);
export const provisioning = `/apis/provisioning.grafana.app/v0alpha1/namespaces/${config.grafanaOrgId === "1" ? "default" : `org-${config.grafanaOrgId}`}`;

export async function poll(what, fn, timeoutMs = 120_000, intervalMs = 3000) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? `: ${last.message}` : ""}`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures. Grafana 13 Git Sync reads dashboard resources; classic dashboard JSON fails with
// "unable to read bytes as a resource", so classic JSON lives outside every synced folder.

function dashboardSpec(title) {
  return { title, schemaVersion: 39, panels: [{ id: 1, type: "text", title: "e2e", gridPos: { x: 0, y: 0, w: 12, h: 4 }, options: { content: title } }] };
}
export const yamlDashboard = (uid, title) =>
  yaml.dump({ apiVersion: "dashboard.grafana.app/v1beta1", kind: "Dashboard", metadata: { name: uid }, spec: dashboardSpec(title) });
export const jsonDashboard = (uid, title) =>
  JSON.stringify({ apiVersion: "dashboard.grafana.app/v1beta1", kind: "Dashboard", metadata: { name: uid }, spec: dashboardSpec(title) }, null, 2) + "\n";
export const classicDashboard = (uid, title) => JSON.stringify({ uid, ...dashboardSpec(title) }, null, 2) + "\n";

export const grafanaRepos = [
  { name: "azdo-e2e-preview", path: "grafana/", title: "Azure DevOps e2e preview" },
  { name: "azdo-e2e-ops", path: "ops/", title: "Azure DevOps e2e ops" },
];

/** Multi-document manifest: both Git Sync repositories, plus an unrelated resource the task skips. */
export function manifest(url) {
  const docs = grafanaRepos.map((r) => ({
    apiVersion: "provisioning.grafana.app/v0alpha1",
    kind: "Repository",
    metadata: { name: r.name },
    spec: {
      title: r.title,
      type: "git",
      git: { url, branch: "main", path: r.path, tokenUser: config.repoName },
      sync: { enabled: true, target: "folder", intervalSeconds: 60 },
      workflows: [],
    },
  }));
  docs.push({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "not-a-repository" }, data: { a: "b" } });
  return docs.map((d) => yaml.dump(d)).join("---\n");
}

// ---------------------------------------------------------------------------------------------
// Git

/** Runs git with the PAT as a one-off header, so nothing credential-bearing is written to disk. */
export function git(cwd, ...args) {
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: ${azdoAuth}`, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function write(dir, file, content) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

export function tempDir(prefix, after) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function initRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [["core.autocrlf", "false"], ["core.quotepath", "false"], ["user.email", "e2e@example.com"], ["user.name", "e2e"]]) {
    git(dir, "config", k, v);
  }
  git(dir, "remote", "add", "origin", config.cloneUrl);
}

/**
 * Checks out `ref` the way the Azure Pipelines agent does for a shallow build: it fetches only the
 * built commit (`+<sha>:refs/remotes/origin/<sha>`, or the pull request merge ref), checks it out
 * detached, and keeps no credentials. So no other branch, not even the target, is in the checkout.
 * `ref` is `pull/<id>/merge` or a branch name. `alsoFetch` lists branches a pipeline fetches itself.
 */
export function agentCheckout(after, ref, { depth = 2, alsoFetch = [] } = {}) {
  const dir = tempDir("grafana-e2e-agent-", after);
  git(dir, "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "remote", "add", "origin", config.cloneUrl);
  let target;
  if (ref.startsWith("pull/")) {
    target = `refs/remotes/${ref}`;
    git(dir, "fetch", "-q", "--force", "--no-tags", `--depth=${depth}`, "origin", `+refs/${ref}:${target}`);
  } else {
    const sha = git(dir, "ls-remote", "origin", `refs/heads/${ref}`).split("\t")[0];
    if (!sha) throw new Error(`No branch ${ref}`);
    target = `refs/remotes/origin/${sha}`;
    git(dir, "fetch", "-q", "--force", "--no-tags", `--depth=${depth}`, "origin", `+${sha}:${target}`);
  }
  for (const branch of alsoFetch) {
    git(dir, "fetch", "-q", "--no-tags", `--depth=${depth}`, "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  }
  git(dir, "checkout", "-q", "--force", target);
  return dir;
}

// ---------------------------------------------------------------------------------------------
// Running the task

const expand = (value, variables) => value.replace(/\$\(([^)]+)\)/g, (m, name) => variables[name] ?? m);

/**
 * Runs the compiled task like the agent does: inputs (with task.json defaults filled in and macros
 * expanded) and variables as environment variables, then parses the logging commands it prints.
 */
export function runTask(cwd, inputs, variables) {
  const all = {};
  for (const input of taskJson.inputs) if (input.defaultValue !== undefined) all[input.name] = expand(String(input.defaultValue), variables);
  Object.assign(all, inputs);

  // A clean agent: no system or user git config, so no credential helper with this machine's sign-ins.
  const emptyConfig = join(tmpdir(), "grafana-e2e-empty.gitconfig");
  writeFileSync(emptyConfig, "");
  const taskEnv = {
    PATH: env.PATH, SystemRoot: env.SystemRoot, TEMP: env.TEMP, TMP: env.TMP, HOME: env.HOME, USERPROFILE: env.USERPROFILE,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig,
    AGENT_TEMPDIRECTORY: cwd, SYSTEM_JOBID: "e2e-job",
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) taskEnv[`INPUT_${k.replace(/ /g, "_").toUpperCase()}`] = v;
  for (const [k, v] of Object.entries(variables)) if (v !== undefined) taskEnv[k.replace(/\./g, "_").toUpperCase()] = v;

  let stdout, stderr = "";
  try {
    stdout = execFileSync(process.execPath, [taskEntry], { cwd, env: taskEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (e) {
    // The task reports failure through ##vso[task.complete], not its exit code; anything else is a crash.
    throw new Error(`Task process failed: ${e.message}\n${e.stdout}\n${e.stderr}`);
  }
  const complete = /##vso\[task\.complete result=(\w+);\](.*)/.exec(stdout);
  const summaryFile = /##vso\[task\.uploadsummary\](.+)/.exec(stdout)?.[1]?.trim();
  const outputs = {};
  for (const m of stdout.matchAll(/##vso\[task\.setvariable variable=([^;]+);([^\]]*)\](.*)/g)) {
    if (/isOutput=true/i.test(m[2])) outputs[m[1]] = m[3].trim();
  }
  const issues = (type) => [...stdout.matchAll(new RegExp(`##vso\\[task\\.(?:issue|logissue) type=${type};[^\\]]*\\](.*)`, "g"))].map((m) => m[1]);
  return {
    stdout,
    stderr,
    log: `${stdout}\n${stderr}`,
    result: complete?.[1],
    message: complete?.[2]?.trim(),
    summary: summaryFile ? readFileSync(summaryFile, "utf8") : undefined,
    outputs,
    // What the agent shows without system.debug. Debug lines echo input values, secrets included, and
    // the agent consumes logging commands such as task.setsecret instead of printing them.
    visible: stdout.split(/\r?\n/).filter((line) => !/^##vso\[task\.(debug|setsecret)\]/.test(line)).join("\n"),
    warnings: issues("warning"),
    errors: issues("error"),
  };
}

/** Variables the agent sets for a pull request build of the test repository. */
export function prVariables(repo, dir, pr, branch) {
  return {
    "System.CollectionUri": config.org,
    "System.TeamProject": config.project,
    "System.AccessToken": env.AZDO_PAT,
    "Build.Repository.ID": repo.id,
    "Build.Repository.Name": config.repoName,
    "Build.Repository.Provider": "TfsGit",
    "Build.SourcesDirectory": dir,
    "Build.SourceBranch": `refs/pull/${pr.pullRequestId}/merge`,
    "System.PullRequest.PullRequestId": String(pr.pullRequestId),
    "System.PullRequest.SourceBranch": `refs/heads/${branch}`,
    "System.PullRequest.TargetBranch": pr.targetRefName,
  };
}

/** Variables the agent sets for a branch (CI or manual) build. */
export function branchVariables(repo, dir, branch) {
  return {
    "System.CollectionUri": config.org,
    "System.TeamProject": config.project,
    "System.AccessToken": env.AZDO_PAT,
    "Build.Repository.ID": repo.id,
    "Build.Repository.Name": config.repoName,
    "Build.Repository.Provider": "TfsGit",
    "Build.SourcesDirectory": dir,
    "Build.SourceBranch": `refs/heads/${branch}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Parsing the comment and the build summary

const cells = (line) => line.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());

/**
 * Parses the dashboard table into rows keyed by file path:
 * { title, change, orgs: [{ label, links: { current?: URL, preview?: URL } }] }.
 */
export function parseTable(markdown) {
  const rows = new Map();
  for (const line of markdown.split("\n")) {
    const m = /^\| \*\*(.*?)\*\*<br>`([^`]+)` \|/.exec(line);
    if (!m) continue;
    const c = cells(line);
    const linkCell = c[c.length - 1];
    const orgs = linkCell.split("<br>").map((part) => {
      const label = /^([^[:]+): /.exec(part)?.[1];
      const links = {};
      for (const l of part.matchAll(/\[(current|preview)\]\(([^)]+)\)/g)) links[l[1]] = new URL(l[2]);
      return { label, links };
    });
    rows.set(m[2], { title: m[1].replace(/\\\|/g, "|"), change: c.length === 3 ? c[1] : undefined, orgs });
  }
  return rows;
}

/** The pull request's threads whose first comment carries `<!-- key -->`. */
export async function threadsWithKey(repo, prId, key) {
  const threads = (await azdo("GET", `git/repositories/${repo.id}/pullRequests/${prId}/threads`)).value;
  return threads.filter((th) => !th.isDeleted && th.comments?.[0]?.content?.includes(`<!-- ${key} -->`));
}

export async function commentWithKey(repo, prId, key) {
  const found = await threadsWithKey(repo, prId, key);
  if (found.length !== 1) throw new Error(`Expected one thread with key ${key} on PR ${prId}, found ${found.length}`);
  return { thread: found[0], content: found[0].comments[0].content };
}
