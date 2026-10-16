// End-to-end test against a real Azure DevOps organization and, optionally, a real Grafana with Git Sync.
//
// It pushes a fixture repository, opens a pull request, runs the built task the way an agent would,
// and checks the pull request comment, the build summary and the links Grafana serves.
//
// Run with `npm run test:e2e`, after `npm run e2e:up` for the local Grafana. Settings come from the
// environment or a `.env` file (see .env.example):
//   AZDO_URL            https://dev.azure.com/<org>/
//   AZDO_PAT            PAT with Code (read, write) and Pull request threads scopes
//   AZDO_PROJECT        project that holds the test repository
//   AZDO_E2E_REPO       test repository, created when missing (default grafana-git-sync-e2e)
//   GRAFANA_URL         optional; with GIT_PROXY_URL, enables the Grafana checks
//   GRAFANA_USER / GRAFANA_PASSWORD or GRAFANA_TOKEN
//   GRAFANA_ORG_ID      default 1
//   GIT_PROXY_URL       the test repository behind git-v2-azuredevops-proxy, as Grafana reaches it
//   GIT_PROXY_TOKEN     the proxy's token for that repository; empty when the proxy has GIT_PROXY_AUTH=none
//   E2E_PIPELINE_TASK   optional, e.g. GrafanaGitSyncPreviewDev@0: also run that installed task in a
//                       real Azure Pipelines build-validation run on the pull request
//   E2E_PIPELINE_POOL   agent pool for that run (default: the hosted ubuntu-latest image)
//   E2E_KEEP=1          keep the pull request and the Grafana repository for manual inspection
//
// Git Sync speaks Git protocol v2, which Azure Repos rejects (TF401041), so Grafana reads the test
// repository through https://github.com/Dominik-esb/git-v2-azuredevops-proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("../tasks/GrafanaGitSyncPreview/node_modules/js-yaml");

const env = process.env;
const missing = ["AZDO_URL", "AZDO_PAT", "AZDO_PROJECT"].filter((k) => !env[k]);
const taskEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../tasks/GrafanaGitSyncPreview/dist/index.js");

const org = (env.AZDO_URL ?? "").replace(/\/?$/, "/");
const project = env.AZDO_PROJECT;
const repoName = env.AZDO_E2E_REPO || "grafana-git-sync-e2e";
const grafanaUrl = (env.GRAFANA_URL ?? "").replace(/\/+$/, "");
const grafanaOrgId = env.GRAFANA_ORG_ID || "1";
const grafanaRepo = "azdo-e2e-preview";
const withGrafana = Boolean(grafanaUrl && env.GIT_PROXY_URL);
const runId = Date.now().toString(36);
const branch = `e2e/run-${runId}`;
const commentKey = "grafana-dashboard-preview";
const pipelineTask = env.E2E_PIPELINE_TASK;
const pipelineCommentKey = "pipeline-preview";

const azdoAuth = "Basic " + Buffer.from(`:${env.AZDO_PAT}`).toString("base64");
const grafanaAuth = env.GRAFANA_TOKEN
  ? `Bearer ${env.GRAFANA_TOKEN}`
  : "Basic " + Buffer.from(`${env.GRAFANA_USER}:${env.GRAFANA_PASSWORD}`).toString("base64");

async function http(auth, method, url, body, { allow = [] } = {}) {
  const resp = await fetch(url, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok && !allow.includes(resp.status)) throw new Error(`${method} ${url}: ${resp.status} ${text.slice(0, 500)}`);
  return { status: resp.status, json: text ? JSON.parse(text) : undefined };
}
const azdo = async (method, path, body, opts) =>
  (await http(azdoAuth, method, `${org}${encodeURIComponent(project)}/_apis/${path}${path.includes("?") ? "&" : "?"}api-version=7.1`, body, opts)).json;
const grafana = (method, path, body, opts) => http(grafanaAuth, method, `${grafanaUrl}${path}`, body, opts);
const provisioning = `/apis/provisioning.grafana.app/v0alpha1/namespaces/${grafanaOrgId === "1" ? "default" : `org-${grafanaOrgId}`}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(what, fn, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(3000);
  }
}

// Grafana 13 Git Sync reads dashboard resources only; classic dashboard JSON fails with
// "unable to read bytes as a resource".
function dashboard(uid, title) {
  const spec = { title, schemaVersion: 39, panels: [{ id: 1, type: "text", title: "e2e", gridPos: { x: 0, y: 0, w: 12, h: 4 }, options: { content: title } }] };
  return yaml.dump({ apiVersion: "dashboard.grafana.app/v1beta1", kind: "Dashboard", metadata: { name: uid }, spec });
}

const manifest = (url) => `apiVersion: provisioning.grafana.app/v0alpha1
kind: Repository
metadata:
  name: ${grafanaRepo}
spec:
  title: Azure DevOps e2e preview
  type: git
  git:
    url: ${url}
    branch: main
    path: grafana/
    tokenUser: ${repoName}
  sync:
    enabled: true
    target: folder
    intervalSeconds: 60
  workflows: []
`;

// Build validation pipeline that runs the installed task on every pull request into main.
const pipelineYaml = () => `trigger: none
pool:
  ${env.E2E_PIPELINE_POOL ? `name: ${env.E2E_PIPELINE_POOL}` : "vmImage: ubuntu-latest"}
steps:
  - checkout: self
    fetchDepth: 2
  - task: ${pipelineTask}
    inputs:
      grafanaUrl: https://grafana.example.com
      organizations: main=1
      repositoriesFile: grafana-repository.yaml
      commentKey: ${pipelineCommentKey}
`;

/** Creates or finds the pipeline, lets its build identity comment, and requires it on pull requests. */
async function ensurePipeline(repo) {
  const name = `${repoName}-preview`;
  let def = (await azdo("GET", `build/definitions?name=${encodeURIComponent(name)}`)).value[0];
  if (!def) {
    def = await azdo("POST", "build/definitions", {
      name,
      type: "build",
      process: { type: 2, yamlFilename: "azure-pipelines.yml" },
      repository: { id: repo.id, type: "TfsGit", name: repoName, defaultBranch: "refs/heads/main" },
      queue: { name: "Azure Pipelines" },
    });
  }

  // Grant both build identities; which one a job runs as depends on the job authorization scope setting.
  const orgName = new URL(org).pathname.split("/").filter(Boolean)[0];
  const projectId = (await http(azdoAuth, "GET", `${org}_apis/projects/${encodeURIComponent(project)}?api-version=7.1`)).json.id;
  for (const identity of [`${project} Build Service (${orgName})`, `Project Collection Build Service (${orgName})`]) {
    const found = (await http(azdoAuth, "GET", `https://vssps.dev.azure.com/${orgName}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(identity)}&api-version=7.1`)).json.value[0];
    if (!found) continue;
    // Git repositories security namespace; 16384 = Contribute to pull requests.
    await http(azdoAuth, "POST", `${org}_apis/accesscontrolentries/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87?api-version=7.1`, {
      token: `repoV2/${projectId}/${repo.id}`,
      merge: true,
      accessControlEntries: [{ descriptor: found.descriptor, allow: 16384, deny: 0 }],
    });
  }

  const buildPolicy = "0609b952-1397-4640-95ec-e00a01b2c241";
  const policies = (await azdo("GET", `policy/configurations?repositoryId=${repo.id}&refName=refs/heads/main&policyType=${buildPolicy}`)).value;
  if (!policies.some((p) => p.settings?.buildDefinitionId === def.id)) {
    await azdo("POST", "policy/configurations", {
      isEnabled: true,
      isBlocking: false,
      type: { id: buildPolicy },
      settings: {
        buildDefinitionId: def.id,
        queueOnSourceUpdateOnly: false,
        manualQueueOnly: false,
        validDuration: 0,
        displayName: "Grafana preview",
        scope: [{ repositoryId: repo.id, refName: "refs/heads/main", matchKind: "exact" }],
      },
    });
  }
  return def;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: ${azdoAuth}`, ...args], { cwd, encoding: "utf8" });
}
function write(dir, file, content) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

/** Runs the compiled task like the agent does: inputs and variables as environment variables. */
function runTask(cwd, inputs, variables) {
  const taskEnv = { PATH: env.PATH, SystemRoot: env.SystemRoot, AGENT_TEMPDIRECTORY: cwd };
  for (const [k, v] of Object.entries(inputs)) taskEnv[`INPUT_${k.toUpperCase()}`] = v;
  for (const [k, v] of Object.entries(variables)) taskEnv[k.replace(/\./g, "_").toUpperCase()] = v;
  const stdout = execFileSync(process.execPath, [taskEntry], { cwd, env: taskEnv, encoding: "utf8" });
  const result = /##vso\[task\.complete result=(\w+);\]/.exec(stdout)?.[1];
  const summary = /##vso\[task\.uploadsummary\](.+)/.exec(stdout)?.[1]?.trim();
  return { stdout, result, summary: summary && readFileSync(summary, "utf8") };
}

test("pull request and branch mode against a real organization", { skip: missing.length ? `set ${missing.join(", ")}` : false, timeout: 1_500_000 }, async (t) => {
  // Repository: create once, then reset main to the fixture on every run.
  let repo = (await azdo("GET", `git/repositories/${repoName}`, undefined, { allow: [404] }));
  if (!repo?.id) repo = await azdo("POST", "git/repositories", { name: repoName });
  const cloneUrl = `${org}${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}`;

  for (const pr of (await azdo("GET", `git/repositories/${repo.id}/pullrequests?searchCriteria.status=active`)).value) {
    await azdo("PATCH", `git/repositories/${repo.id}/pullrequests/${pr.pullRequestId}`, { status: "abandoned" });
  }

  const work = mkdtempSync(join(tmpdir(), "grafana-e2e-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "core.autocrlf", "false");
  git(work, "config", "user.email", "e2e@example.com");
  git(work, "config", "user.name", "e2e");
  write(work, "README.md", "Fixture for the Grafana Git Sync preview task end-to-end test.\n");
  write(work, "grafana-repository.yaml", manifest(env.GIT_PROXY_URL || cloneUrl));
  write(work, "grafana/existing.yaml", dashboard("e2e-existing", "E2E existing"));
  write(work, "grafana/removed.yaml", dashboard("e2e-removed", "E2E removed"));
  if (pipelineTask) write(work, "azure-pipelines.yml", pipelineYaml());
  git(work, "add", "-A");
  git(work, "commit", "-qm", "Fixture");
  git(work, "push", "-qf", cloneUrl, "main");


  if (withGrafana) {
    // Grafana gets the same manifest the task reads, plus the proxy token.
    const spec = yaml.load(manifest(env.GIT_PROXY_URL));
    const body = env.GIT_PROXY_TOKEN ? { ...spec, secure: { token: { create: env.GIT_PROXY_TOKEN } } } : spec;
    const existing = await grafana("GET", `${provisioning}/repositories/${grafanaRepo}`, undefined, { allow: [404] });
    if (existing.status === 404) await grafana("POST", `${provisioning}/repositories`, body);
    else await grafana("PUT", `${provisioning}/repositories/${grafanaRepo}`, { ...body, metadata: existing.json.metadata });
    if (!env.E2E_KEEP) t.after(() => grafana("DELETE", `${provisioning}/repositories/${grafanaRepo}`, undefined, { allow: [404] }));

    // The proxy fetches from Azure DevOps every SYNC_INTERVAL, so wait for this run's fixture.
    await poll("Grafana to see the fixture", async () =>
      (await grafana("GET", `${provisioning}/repositories/${grafanaRepo}/files/removed.yaml?ref=main`, undefined, { allow: [400, 404, 500] })).status === 200, 300_000);
    await grafana("POST", `${provisioning}/repositories/${grafanaRepo}/jobs`, { action: "pull", pull: { incremental: false } }, { allow: [409] });
    await poll("Grafana to sync main", async () => (await grafana("GET", "/api/dashboards/uid/e2e-removed", undefined, { allow: [404] })).status === 200, 300_000);
  }

  const pipeline = pipelineTask ? await ensurePipeline(repo) : undefined;

  // Pull request: modify one dashboard, add one, delete one, and touch a non-dashboard file.
  git(work, "checkout", "-qb", branch);
  write(work, "grafana/existing.yaml", dashboard("e2e-existing", `E2E existing ${runId}`));
  write(work, "grafana/team a/added.yaml", dashboard("e2e-added", "E2E added"));
  unlinkSync(join(work, "grafana/removed.yaml"));
  write(work, "notes.txt", "not a dashboard\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "Change dashboards");
  git(work, "push", "-q", cloneUrl, branch);
  const branchSha = git(work, "rev-parse", "HEAD").trim();

  const pr = await azdo("POST", `git/repositories/${repo.id}/pullrequests`, {
    sourceRefName: `refs/heads/${branch}`,
    targetRefName: "refs/heads/main",
    title: `e2e ${runId}`,
    description: "Created by the end-to-end test.",
  });
  t.after(async () => {
    if (env.E2E_KEEP) return console.log(`Kept ${cloneUrl}/pullrequest/${pr.pullRequestId}`);
    await azdo("PATCH", `git/repositories/${repo.id}/pullrequests/${pr.pullRequestId}`, { status: "abandoned" });
    await azdo("POST", `git/repositories/${repo.id}/refs`, [
      { name: `refs/heads/${branch}`, oldObjectId: branchSha, newObjectId: "0".repeat(40) },
    ]);
  });
  await poll("the pull request merge commit", async () =>
    (await azdo("GET", `git/repositories/${repo.id}/pullrequests/${pr.pullRequestId}`)).mergeStatus === "succeeded");

  // An agent checks out the merge commit, so HEAD^1 is the target branch.
  git(work, "fetch", "-q", cloneUrl, `refs/pull/${pr.pullRequestId}/merge`);
  git(work, "checkout", "-q", "--detach", "FETCH_HEAD");

  const inputs = {
    grafanaUrl: grafanaUrl || "https://grafana.example.com",
    mode: "auto",
    organizations: `main=${grafanaOrgId}`,
    repositorySource: "file",
    repositoriesFile: "grafana-repository.yaml",
    showCurrentLinks: "true",
    showPreviewLinks: "true",
    commentKey,
    commentTitle: "Grafana dashboard changes",
    threadStatus: "closed",
    publishSummary: "true",
    failOnParseError: "true",
    accessToken: env.AZDO_PAT,
  };
  const variables = {
    "System.CollectionUri": org,
    "System.TeamProject": project,
    "Build.Repository.ID": repo.id,
    "Build.Repository.Name": repoName,
    "Build.Repository.Provider": "TfsGit",
    "Build.SourcesDirectory": work,
    "System.PullRequest.PullRequestId": String(pr.pullRequestId),
    "System.PullRequest.SourceBranch": `refs/heads/${branch}`,
  };

  const first = runTask(work, inputs, variables);
  assert.equal(first.result, "Succeeded", first.stdout);
  assert.match(first.stdout, /Pull request comment created/);
  assert.match(first.summary, /\| Dashboard \| Change \| Links \|/);

  const threadsPath = `git/repositories/${repo.id}/pullRequests/${pr.pullRequestId}/threads`;
  const ours = async () => (await azdo("GET", threadsPath)).value.filter((th) => th.comments?.[0]?.content?.includes(`<!-- ${commentKey} -->`));
  let [thread] = await ours();
  const comment = thread.comments[0].content;
  assert.equal(thread.status, "closed");

  const rowOf = (uid) => comment.split("\n").find((l) => l.includes(uid === "e2e-added" ? "added.yaml" : `${uid.slice(4)}.yaml`));
  const added = rowOf("e2e-added"), modified = rowOf("e2e-existing"), deleted = rowOf("e2e-removed");
  assert.match(added, /\| added \|/);
  assert.doesNotMatch(added, /\[current\]/);
  assert.match(added, /preview\/team%20a\/added\.yaml\?ref=e2e%2Frun-/);
  assert.match(modified, /\| modified \|.*\[current\].*\[preview\]/);
  assert.match(modified, new RegExp(`E2E existing ${runId}`));
  assert.match(deleted, /\| deleted \|.*\[current\]/);
  assert.doesNotMatch(deleted, /\[preview\]/);
  assert.doesNotMatch(comment, /notes\.txt|grafana-repository\.yaml/);
  assert.match(comment, new RegExp(`pull_request_url=${encodeURIComponent(`${cloneUrl}/pullrequest/${pr.pullRequestId}`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  // A second run updates the same comment instead of adding a thread.
  const second = runTask(work, { ...inputs, commentTitle: "Updated title" }, variables);
  assert.equal(second.result, "Succeeded", second.stdout);
  assert.match(second.stdout, /Pull request comment updated/);
  const after = await ours();
  assert.equal(after.length, 1);
  assert.match(after[0].comments[0].content, /Updated title/);


  if (withGrafana) {
    // Every link in the comment must point at something Grafana serves.
    await poll("Grafana to see the pull request branch", async () =>
      (await grafana("GET", `${provisioning}/repositories/${grafanaRepo}/files/team%20a/added.yaml?ref=${encodeURIComponent(branch)}`, undefined, { allow: [400, 404, 500] })).status === 200, 300_000);
    const urls = [...comment.matchAll(/\[(current|preview)\]\(([^)]+)\)/g)].map((m) => ({ kind: m[1], url: new URL(m[2]) }));
    assert.equal(urls.length, 4);
    for (const { kind, url } of urls) {
      if (kind === "current") {
        const uid = url.pathname.split("/").pop();
        assert.equal((await grafana("GET", `/api/dashboards/uid/${uid}`)).json.dashboard.uid, uid);
      } else {
        const [, repoInUrl, file] = /^\/dashboard\/provisioning\/([^/]+)\/preview\/(.+)$/.exec(url.pathname);
        const ref = url.searchParams.get("ref");
        const previewed = (await grafana("GET", `${provisioning}/repositories/${repoInUrl}/files/${file}?ref=${encodeURIComponent(ref)}`)).json;
        const resource = previewed.resource.file;
        assert.ok(["e2e-existing", "e2e-added"].includes(resource.uid ?? resource.metadata?.name), JSON.stringify(previewed).slice(0, 300));
        if (file === "existing.yaml") assert.equal(resource.title ?? resource.spec?.title, `E2E existing ${runId}`);
      }
    }
  }

  if (pipeline) {
    // The build-validation policy queues the pipeline for the pull request; wait for its verdict.
    const build = await poll("the pull request pipeline run", async () => {
      const runs = (await azdo("GET", `build/builds?definitions=${pipeline.id}&branchName=refs/pull/${pr.pullRequestId}/merge&$top=1`)).value;
      return runs[0]?.status === "completed" ? runs[0] : undefined;
    }, 900_000);
    assert.equal(build.result, "succeeded", `${build._links.web.href} finished ${build.result}`);
    const threads = (await azdo("GET", threadsPath)).value;
    const fromPipeline = threads.find((th) => th.comments?.[0]?.content?.includes(`<!-- ${pipelineCommentKey} -->`));
    assert.ok(fromPipeline, `${pipelineTask} posted no comment on the pull request`);
    const body = fromPipeline.comments[0].content;
    assert.match(body, /added\.yaml[^\n]*\| added \|/);
    assert.match(body, /existing\.yaml[^\n]*\| modified \|/);
    assert.match(body, /removed\.yaml[^\n]*\| deleted \|/);
  }

  // Branch mode on main lists every dashboard and needs no pull request.
  git(work, "checkout", "-q", "main");
  const branchRun = runTask(work, { ...inputs, mode: "branch" }, {
    ...variables,
    "System.PullRequest.PullRequestId": "",
    "System.PullRequest.SourceBranch": "",
    "Build.SourceBranch": "refs/heads/main",
  });
  assert.equal(branchRun.result, "Succeeded", branchRun.stdout);
  assert.doesNotMatch(branchRun.stdout, /Pull request comment/);
  assert.match(branchRun.summary, /\| Dashboard \| Links \|/);
  assert.match(branchRun.summary, /existing\.yaml[^\n]*\[current\][^\n]*preview\/existing\.yaml\?ref=main/);
  assert.match(branchRun.summary, /removed\.yaml/);
});

