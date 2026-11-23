// End-to-end test against a real Azure DevOps organization, a real Grafana with Git Sync and,
// optionally, a real Azure Pipelines agent running the installed extension.
//
// It pushes a fixture repository, opens pull requests that exercise every kind of change, runs the
// built task the way an agent would, and checks the pull request comments, the build summaries, the
// output variables, and that every link opens the right dashboard in Grafana in a real browser.
//
// Run with `npm run test:e2e`, after `npm run e2e:up` for the local Grafana. Settings come from the
// environment or a `.env` file (see .env.example):
//   AZDO_URL            https://dev.azure.com/<org>/
//   AZDO_PAT            PAT, see CONTRIBUTING.md for the scopes
//   AZDO_PROJECT        project that holds the test repository
//   AZDO_E2E_REPO       test repository, created when missing (default grafana-git-sync-e2e)
//   GRAFANA_URL         optional; with GIT_PROXY_URL, enables the Grafana and browser checks
//   GRAFANA_USER / GRAFANA_PASSWORD or GRAFANA_TOKEN
//   GRAFANA_ORG_ID      default 1
//   GIT_PROXY_URL       the test repository behind git-v2-azuredevops-proxy, as Grafana reaches it
//   GIT_PROXY_TOKEN     the proxy's token for that repository; empty when the proxy has GIT_PROXY_AUTH=none
//   E2E_PIPELINE_TASK   optional, e.g. GrafanaGitSyncPreviewDev@1: also run that installed task in
//                       real Azure Pipelines runs, for pull requests and for a branch
//   E2E_PIPELINE_POOL   agent pool for those runs (default: the hosted ubuntu-latest image)
//   E2E_BULK_COUNT      dashboards in the large pull request (default 400)
//   E2E_KEEP=1          keep the pull requests, branches and Grafana repositories for inspection
//
// Git Sync speaks Git protocol v2, which Azure Repos rejects (TF401041), so Grafana reads the test
// repository through https://github.com/Dominik-esb/git-v2-azuredevops-proxy.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  agentCheckout, azdo, azdoAuth, branchVariables, classicDashboard, commentWithKey, config, git, grafana,
  grafanaRepos, http, initRepo, jsonDashboard, manifest, parseTable, poll, provisioning, prVariables, runTask,
  tempDir, threadsWithKey, write, yaml, yamlDashboard,
} from "./lib.mjs";

const runId = Date.now().toString(36);
const prefix = `e2e/run-${runId}`;
const grafanaHost = config.grafanaUrl || "https://grafana.example.com";

// Titles on main, and on the main pull request's branch. Keys are file paths.
const mainFiles = {
  "grafana/existing.yaml": { uid: "e2e-existing", title: "E2E existing", kind: "yaml" },
  "grafana/removed.yaml": { uid: "e2e-removed", title: "E2E removed", kind: "yaml" },
  "grafana/renamed-from.yaml": { uid: "e2e-renamed", title: "E2E renamed", kind: "yaml" },
  "grafana/json-resource.json": { uid: "e2e-json", title: "E2E json", kind: "json" },
  "ops/ops.yaml": { uid: "e2e-ops", title: "E2E ops", kind: "yaml" },
  "legacy/classic.json": { uid: "e2e-classic", title: "E2E classic", kind: "classic" },
};
const branchTitles = {
  "grafana/existing.yaml": `E2E existing ${runId} | v2`,
  "grafana/team a/added.yaml": "E2E added",
  "grafana/team-b/unicode_title.yaml": "E2E ünïcode ✓",
  "grafana/renamed-to.yaml": "E2E renamed",
  "grafana/json-resource.json": `E2E json ${runId}`,
  "ops/ops.yaml": `E2E ops ${runId}`,
};
// What the main pull request's comment must list: path -> [change, Grafana repository, path in it].
const expectedMain = {
  "grafana/existing.yaml": ["modified", "azdo-e2e-preview", "existing.yaml"],
  "grafana/team a/added.yaml": ["added", "azdo-e2e-preview", "team a/added.yaml"],
  "grafana/team-b/unicode_title.yaml": ["added", "azdo-e2e-preview", "team-b/unicode_title.yaml"],
  "grafana/removed.yaml": ["deleted", "azdo-e2e-preview", "removed.yaml"],
  "grafana/renamed-from.yaml": ["deleted", "azdo-e2e-preview", "renamed-from.yaml"],
  "grafana/renamed-to.yaml": ["added", "azdo-e2e-preview", "renamed-to.yaml"],
  "grafana/json-resource.json": ["modified", "azdo-e2e-preview", "json-resource.json"],
  "ops/ops.yaml": ["modified", "azdo-e2e-ops", "ops.yaml"],
};

const render = { yaml: yamlDashboard, json: jsonDashboard, classic: classicDashboard };
const uidOf = (path) => mainFiles[path]?.uid ?? { "grafana/team a/added.yaml": "e2e-added", "grafana/team-b/unicode_title.yaml": "e2e-unicode", "grafana/renamed-to.yaml": "e2e-renamed" }[path];

/** Asserts one parsed table row: change, link kinds, and every link's exact URL. */
function assertRow(rows, path, { change, repository, relPath, ref, prUrl, orgs = [{ id: 1 }], current, preview }) {
  const row = rows.get(path);
  assert.ok(row, `no row for ${path}; rows: ${[...rows.keys()].join(", ")}`);
  assert.equal(row.change, change, `${path} change`);
  assert.equal(row.orgs.length, orgs.length, `${path} organizations`);
  row.orgs.forEach((o, i) => {
    assert.equal(o.label, orgs[i].label, `${path} org label`);
    const orgId = String(orgs[i].id);
    if (current) {
      assert.ok(o.links.current, `${path} has no current link`);
      assert.equal(o.links.current.origin + o.links.current.pathname, `${grafanaHost}/d/${uidOf(path)}`);
      assert.equal(o.links.current.searchParams.get("orgId"), orgId);
    } else assert.equal(o.links.current, undefined, `${path} must not have a current link`);
    if (preview) {
      const p = o.links.preview;
      assert.ok(p, `${path} has no preview link`);
      assert.equal(p.origin, grafanaHost);
      assert.equal(decodeURIComponent(p.pathname), `/dashboard/provisioning/${repository}/preview/${relPath}`);
      assert.equal(p.searchParams.get("ref"), ref);
      assert.equal(p.searchParams.get("orgId"), orgId);
      assert.equal(p.searchParams.get("pull_request_url"), prUrl ?? null);
    } else assert.equal(o.links.preview, undefined, `${path} must not have a preview link`);
  });
}

function assertMainRows(content, { ref, prUrl, orgs, showCurrent = true, showPreview = true, only }) {
  const rows = parseTable(content);
  const expected = Object.entries(expectedMain).filter(([path]) => !only || only(path));
  assert.deepEqual([...rows.keys()].sort(), expected.map(([p]) => p).sort(), "listed files");
  for (const [path, [change, repository, relPath]] of expected) {
    assertRow(rows, path, {
      change, repository, relPath, ref, prUrl, orgs,
      current: showCurrent && change !== "added",
      preview: showPreview && change !== "deleted",
    });
    const title = change === "deleted" ? mainFiles[path].title : branchTitles[path];
    assert.equal(rows.get(path).title, title, `${path} title`);
  }
  return rows;
}

describe("Grafana Git Sync preview against a real organization", { skip: config.missing.length ? `set ${config.missing.join(", ")}` : false, timeout: 3_600_000 }, () => {
  let repo, work, mainSha, pipeline;
  const prs = [];
  const branches = [];
  const ctx = { browser: undefined };
  const cleanups = [];
  const onCleanup = (fn) => cleanups.push(fn);

  const prUrl = (pr) => `${config.cloneUrl}/pullrequest/${pr.pullRequestId}`;

  /** Pushes a branch from main with `change` applied, opens a pull request, and waits for its merge commit. */
  async function openPullRequest(name, change, { target = "main", title } = {}) {
    const branch = `${prefix}-${name}`;
    git(work, "checkout", "-q", "-B", branch, mainSha);
    change(work);
    git(work, "add", "-A");
    git(work, "commit", "-qm", title ?? name);
    git(work, "push", "-q", "origin", `${branch}:refs/heads/${branch}`);
    branches.push(branch);
    const sha = git(work, "rev-parse", "HEAD").trim();
    const pr = await azdo("POST", `git/repositories/${repo.id}/pullrequests`, {
      sourceRefName: `refs/heads/${branch}`,
      targetRefName: `refs/heads/${target}`,
      title: `e2e ${runId} ${title ?? name}`,
      description: "Created by the end-to-end test. Abandoned when it finishes.",
    });
    prs.push(pr);
    const merge = await waitForMerge(pr, sha);
    return { pr, branch, sha, merge };
  }

  async function waitForMerge(pr, sha) {
    return poll(`the merge commit of PR ${pr.pullRequestId}`, async () => {
      const cur = await azdo("GET", `git/repositories/${repo.id}/pullrequests/${pr.pullRequestId}`);
      if (cur.mergeStatus === "conflicts" || cur.mergeStatus === "failure") throw new Error(`merge ${cur.mergeStatus}`);
      return cur.lastMergeSourceCommit?.commitId === sha && cur.mergeStatus === "succeeded" && cur.lastMergeCommit?.commitId;
    });
  }

  const taskInputs = (overrides = {}) => ({
    grafanaUrl: grafanaHost,
    organizations: `${config.grafanaOrgId}`,
    repositoriesFile: "grafana-repository.yaml",
    commentKey: "e2e-preview",
    commentTitle: "Grafana dashboard changes",
    ...overrides,
  });

  before(async () => {
    // Fail fast with a clear message on bad credentials, rather than halfway through.
    const project = await http(azdoAuth, "GET", `${config.org}_apis/projects/${encodeURIComponent(config.project)}?api-version=7.1`, undefined, { allow: [401, 403, 404] });
    if (project.status !== 200) throw new Error(`AZDO_PAT cannot read project ${config.project} (${project.status}). Is it expired?`);
    if (config.withGrafana) {
      const health = await grafana("GET", "/api/user", undefined, { allow: [401] });
      if (health.status !== 200) throw new Error(`Grafana at ${config.grafanaUrl} rejected the credentials (${health.status})`);
    }

    repo = await azdo("GET", `git/repositories/${config.repoName}`, undefined, { allow: [404] });
    if (!repo?.id) repo = await azdo("POST", "git/repositories", { name: config.repoName });

    // Leftovers from runs that crashed before cleaning up.
    for (const pr of (await azdo("GET", `git/repositories/${repo.id}/pullrequests?searchCriteria.status=active&$top=200`)).value) {
      await azdo("PATCH", `git/repositories/${repo.id}/pullrequests/${pr.pullRequestId}`, { status: "abandoned" });
    }
    const stale = (await azdo("GET", `git/repositories/${repo.id}/refs?filter=heads/e2e/`)).value;
    if (stale.length) {
      await azdo("POST", `git/repositories/${repo.id}/refs`, stale.map((r) => ({ name: r.name, oldObjectId: r.objectId, newObjectId: "0".repeat(40) })));
    }

    work = tempDir("grafana-e2e-", onCleanup);
    initRepo(work);
    write(work, "README.md", "Fixture for the Grafana Git Sync preview task end-to-end test.\n");
    write(work, "grafana-repository.yaml", manifest(config.proxyUrl || config.cloneUrl));
    for (const [path, f] of Object.entries(mainFiles)) write(work, path, render[f.kind](f.uid, f.title));
    if (config.pipelineTask) {
      const { pipelineYaml } = await import("./pipeline.mjs");
      write(work, "azure-pipelines.yml", pipelineYaml());
    }
    git(work, "add", "-A");
    git(work, "commit", "-qm", `Fixture ${runId}`);
    git(work, "push", "-qf", "origin", "main");
    mainSha = git(work, "rev-parse", "HEAD").trim();
    // Pull requests that must not trigger the pipeline target this copy of main instead.
    git(work, "push", "-q", "origin", `main:refs/heads/${prefix}-base`);
    branches.push(`${prefix}-base`);

    if (config.withGrafana) {
      for (const doc of yaml.loadAll(manifest(config.proxyUrl)).filter((d) => d.kind === "Repository")) {
        const body = config.proxyToken ? { ...doc, secure: { token: { create: config.proxyToken } } } : doc;
        const existing = await grafana("GET", `${provisioning}/repositories/${doc.metadata.name}`, undefined, { allow: [404] });
        if (existing.status === 404) await grafana("POST", `${provisioning}/repositories`, body);
        else await grafana("PUT", `${provisioning}/repositories/${doc.metadata.name}`, { ...body, metadata: existing.json.metadata });
      }
      // The proxy fetches from Azure DevOps every SYNC_INTERVAL, so wait for this run's fixture.
      await poll("Grafana to read this run's fixture through the proxy", async () => {
        const r = await grafana("GET", `${provisioning}/repositories/azdo-e2e-preview/files/existing.yaml?ref=main`, undefined, { allow: [400, 404, 500] });
        return r.status === 200 && (await grafana("GET", `${provisioning}/repositories/azdo-e2e-preview/files/renamed-from.yaml?ref=main`, undefined, { allow: [400, 404, 500] })).status === 200;
      }, 300_000);
      for (const r of grafanaRepos) {
        await grafana("POST", `${provisioning}/repositories/${r.name}/jobs`, { action: "pull", pull: { incremental: false } }, { allow: [409] });
      }
      for (const [path, f] of Object.entries(mainFiles)) {
        if (f.kind === "classic") continue;
        await poll(`Grafana to sync ${path}`, async () => {
          const d = await grafana("GET", `/api/dashboards/uid/${f.uid}`, undefined, { allow: [404] });
          return d.status === 200 && d.json.dashboard.title === f.title;
        }, 300_000);
      }
      const { openBrowser } = await import("./browser.mjs");
      ctx.browser = await openBrowser();
    }

    if (config.pipelineTask) {
      const { ensurePipeline } = await import("./pipeline.mjs");
      pipeline = await ensurePipeline(repo);
    }
  });

  after(async () => {
    await ctx.browser?.close();
    for (const fn of cleanups.reverse()) fn();
    if (config.keep) {
      console.log(`Kept: ${prs.map((pr) => prUrl(pr)).join(", ")}`);
      return;
    }
    for (const pr of prs) {
      await azdo("PATCH", `git/repositories/${repo.id}/pullrequests/${pr.pullRequestId}`, { status: "abandoned" }, { allow: [400, 404] });
    }
    const refs = (await azdo("GET", `git/repositories/${repo.id}/refs?filter=heads/${prefix}`)).value;
    if (refs.length) await azdo("POST", `git/repositories/${repo.id}/refs`, refs.map((r) => ({ name: r.name, oldObjectId: r.objectId, newObjectId: "0".repeat(40) })));
    if (config.withGrafana) {
      for (const r of grafanaRepos) await grafana("DELETE", `${provisioning}/repositories/${r.name}`, undefined, { allow: [404] });
    }
  });

  // -------------------------------------------------------------------------------------------
  // The main pull request: every kind of change, across two Git Sync repositories.

  let main; // { pr, branch, sha, dir, vars, first }

  test("main pull request: comment lists every changed dashboard with correct links", async () => {
    main = await openPullRequest("main", (dir) => {
      write(dir, "grafana/existing.yaml", yamlDashboard("e2e-existing", branchTitles["grafana/existing.yaml"]));
      write(dir, "grafana/team a/added.yaml", yamlDashboard("e2e-added", "E2E added"));
      write(dir, "grafana/team-b/unicode_title.yaml", yamlDashboard("e2e-unicode", "E2E ünïcode ✓"));
      unlinkSync(join(dir, "grafana/removed.yaml"));
      renameSync(join(dir, "grafana/renamed-from.yaml"), join(dir, "grafana/renamed-to.yaml"));
      write(dir, "grafana/json-resource.json", jsonDashboard("e2e-json", branchTitles["grafana/json-resource.json"]));
      write(dir, "ops/ops.yaml", yamlDashboard("e2e-ops", branchTitles["ops/ops.yaml"]));
      // Changes the comment must leave out:
      write(dir, "grafana/config.yaml", "kind: ConfigMap\nmetadata: { name: x }\n"); // not a dashboard
      write(dir, "grafana/notes.md", "# not a dashboard file type\n");
      write(dir, "other/outside.yaml", yamlDashboard("e2e-outside", "Outside every Git Sync folder"));
      write(dir, "legacy/classic.json", classicDashboard("e2e-classic", "E2E classic v2")); // outside the manifests' folders
      write(dir, "notes.txt", "not a dashboard\n");
    }, { title: "main" });

    main.dir = agentCheckout(onCleanup, `pull/${main.pr.pullRequestId}/merge`);
    main.vars = prVariables(repo, main.dir, main.pr, main.branch);
    const run = runTask(main.dir, taskInputs({ commentTitle: "Grafana dashboard changes", threadStatus: "closed" }), main.vars);
    assert.equal(run.result, "Succeeded", run.log);
    assert.equal(run.message, "8 dashboard(s) listed.");
    assert.match(run.stdout, /Pull request comment created/);
    assert.match(run.stdout, /Git Sync repositories: grafana -> azdo-e2e-preview, ops -> azdo-e2e-ops/);
    assert.deepEqual(run.outputs, { dashboardCount: "8", parseErrorCount: "0" });
    assert.deepEqual(run.warnings, []);
    assert.doesNotMatch(run.log, /fatal:/, "git errors leaked into the log");
    assert.doesNotMatch(run.visible, new RegExp(process.env.AZDO_PAT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the token leaked into the log");

    const { thread, content } = await commentWithKey(repo, main.pr.pullRequestId, "e2e-preview");
    assert.equal(thread.status, "closed");
    assert.ok(content.startsWith("<!-- e2e-preview -->\nGrafana dashboard changes\n"), content.slice(0, 200));
    assert.match(content, /\| Dashboard \| Change \| Links \|/);
    assert.match(content, new RegExp(`Previews render \`${main.branch}\``));
    assert.match(content, /E2E existing \w+ \\\| v2/, "a | in a title must be escaped");
    assertMainRows(content, { ref: main.branch, prUrl: prUrl(main.pr) });
    main.content = content;

    // The build summary is the same table, without the marker.
    assert.ok(run.summary.startsWith("Grafana dashboard changes\n"));
    assert.deepEqual([...parseTable(run.summary).keys()].sort(), Object.keys(expectedMain).sort());
  });

  test("main pull request: every link opens the right dashboard in Grafana", { skip: !config.withGrafana && "no Grafana" }, async () => {
    const { openDashboard, pullRequestButtonTarget } = await import("./browser.mjs");
    const rows = parseTable(main.content);
    // Grafana reads the pull request branch through the proxy, which lags a push by SYNC_INTERVAL.
    await poll("Grafana to read the pull request branch", async () =>
      (await grafana("GET", `${provisioning}/repositories/azdo-e2e-preview/files/team-b/unicode_title.yaml?ref=${encodeURIComponent(main.branch)}`, undefined, { allow: [400, 404, 500] })).status === 200, 300_000);

    let checked = 0;
    for (const [path, row] of rows) {
      const { current, preview } = row.orgs[0].links;
      if (current) {
        // The live dashboard is the main version.
        const uid = current.pathname.split("/").pop();
        const api = await grafana("GET", `/api/dashboards/uid/${uid}`);
        assert.equal(api.json.dashboard.title, mainFiles[path].title, `${path}: live dashboard`);
        await (await openDashboard(ctx.browser.context, current, mainFiles[path].title)).close();
        checked++;
      }
      if (preview) {
        // Git Sync's files API at the branch, then the page a reviewer opens.
        const [, repoName, file] = /^\/dashboard\/provisioning\/([^/]+)\/preview\/(.+)$/.exec(preview.pathname);
        const api = (await grafana("GET", `${provisioning}/repositories/${repoName}/files/${file}?ref=${encodeURIComponent(preview.searchParams.get("ref"))}`)).json;
        const resource = api.resource.file;
        assert.equal(resource.metadata?.name, uidOf(path), `${path}: previewed uid`);
        assert.equal(resource.spec?.title, branchTitles[path], `${path}: previewed title`);

        const page = await openDashboard(ctx.browser.context, preview, branchTitles[path]);
        assert.equal(await pullRequestButtonTarget(ctx.browser.context, page, "dev.azure.com"), prUrl(main.pr), `${path}: View pull request button`);
        await page.close();
        checked++;
      }
    }
    // 5 current links (modified and deleted) + 6 previews (modified and added).
    assert.equal(checked, 11);
  });

  test("main pull request: a second run updates the comment instead of adding one", async () => {
    const run = runTask(main.dir, taskInputs({ commentTitle: "Updated title" }), main.vars);
    assert.equal(run.result, "Succeeded", run.log);
    assert.match(run.stdout, /Pull request comment updated/);
    const threads = await threadsWithKey(repo, main.pr.pullRequestId, "e2e-preview");
    assert.equal(threads.length, 1);
    assert.equal(threads[0].comments.length, 1, "the update must edit the comment, not reply to it");
    assert.match(threads[0].comments[0].content, /^<!-- e2e-preview -->\nUpdated title\n/);
  });

  test("main pull request: several organizations and a second comment key", async () => {
    const run = runTask(main.dir, taskInputs({ commentKey: "e2e-orgs", organizations: "test=1\n\n# comment\nprod=3", threadStatus: "active" }), main.vars);
    assert.equal(run.result, "Succeeded", run.log);
    assert.match(run.stdout, /Pull request comment created/);
    const { thread, content } = await commentWithKey(repo, main.pr.pullRequestId, "e2e-orgs");
    assert.equal(thread.status, "active");
    assertMainRows(content, { ref: main.branch, prUrl: prUrl(main.pr), orgs: [{ label: "test", id: 1 }, { label: "prod", id: 3 }] });
    // The first comment is untouched.
    assert.equal((await threadsWithKey(repo, main.pr.pullRequestId, "e2e-preview")).length, 1);
  });

  test("main pull request: inline mappings, link toggles and file extensions", async () => {
    const run = runTask(main.dir, taskInputs({
      commentKey: "e2e-inline",
      repositorySource: "inline",
      repositoriesFile: "",
      // The deepest folder wins: ops/ is its own repository even though "." covers everything.
      repositories: ".=everything\ngrafana=azdo-e2e-preview\nops=azdo-e2e-ops\nlegacy/=legacy",
      showCurrentLinks: "false",
      fileExtensions: " .YAML, .json ",
    }), main.vars);
    assert.equal(run.result, "Succeeded", run.log);
    const rows = parseTable((await commentWithKey(repo, main.pr.pullRequestId, "e2e-inline")).content);
    // Inline mappings cover legacy/ and other/, which no manifest does.
    assert.deepEqual([...rows.keys()].sort(), [...Object.keys(expectedMain), "legacy/classic.json", "other/outside.yaml"].sort());
    assertRow(rows, "legacy/classic.json", { change: "modified", repository: "legacy", relPath: "classic.json", ref: main.branch, prUrl: prUrl(main.pr), current: false, preview: true });
    assertRow(rows, "other/outside.yaml", { change: "added", repository: "everything", relPath: "other/outside.yaml", ref: main.branch, prUrl: prUrl(main.pr), current: false, preview: true });
    assertRow(rows, "ops/ops.yaml", { change: "modified", repository: "azdo-e2e-ops", relPath: "ops.yaml", ref: main.branch, prUrl: prUrl(main.pr), current: false, preview: true });
    for (const row of rows.values()) assert.equal(row.orgs[0].links.current, undefined);

    const yamlOnly = runTask(main.dir, taskInputs({ commentKey: "e2e-yaml-only", fileExtensions: ".yml,.yaml", showPreviewLinks: "false" }), main.vars);
    assert.equal(yamlOnly.result, "Succeeded", yamlOnly.log);
    const yamlRows = parseTable((await commentWithKey(repo, main.pr.pullRequestId, "e2e-yaml-only")).content);
    assert.deepEqual([...yamlRows.keys()].sort(), Object.keys(expectedMain).filter((p) => p.endsWith(".yaml")).sort());
    for (const [path, row] of yamlRows) {
      assert.equal(row.orgs[0].links.preview, undefined, path);
      assert.equal(Boolean(row.orgs[0].links.current), row.change !== "added", path);
    }
  });

  test("main pull request: source branch checkout diffed against the target branch", async () => {
    const dir = agentCheckout(onCleanup, main.branch, { depth: 50, alsoFetch: ["main"] });
    const run = runTask(dir, taskInputs({ commentKey: "e2e-source-checkout", baseRevision: "origin/main" }), { ...prVariables(repo, dir, main.pr, main.branch) });
    assert.equal(run.result, "Succeeded", run.log);
    assertMainRows((await commentWithKey(repo, main.pr.pullRequestId, "e2e-source-checkout")).content, { ref: main.branch, prUrl: prUrl(main.pr) });
  });

  test("main pull request: ref input overrides the previewed branch", async () => {
    const run = runTask(main.dir, taskInputs({ commentKey: "e2e-ref", ref: "release/2026.11" }), main.vars);
    assert.equal(run.result, "Succeeded", run.log);
    const { content } = await commentWithKey(repo, main.pr.pullRequestId, "e2e-ref");
    assertMainRows(content, { ref: "release/2026.11", prUrl: prUrl(main.pr) });
    assert.match(content, /Previews render `release\/2026\.11`/);
  });

  test("main pull request: failures and non-Azure Repos builds", async () => {
    // A rejected token fails the task with the HTTP status, and never prints the token.
    const badToken = "not-a-real-token-" + runId;
    const bad = runTask(main.dir, taskInputs({ commentKey: "e2e-bad-token", accessToken: badToken }), main.vars);
    assert.equal(bad.result, "Failed", bad.log);
    assert.match(bad.message, /\b(401|203|302)\b|sign-?in|Unexpected token/i);
    assert.doesNotMatch(bad.visible, new RegExp(badToken));

    // No token at all.
    const none = runTask(main.dir, taskInputs({ commentKey: "e2e-no-token", accessToken: "" }), { ...main.vars, "System.AccessToken": undefined });
    assert.equal(none.result, "Failed", none.log);
    assert.match(none.message, /No access token/);

    // GitHub and other providers: links go to the log and summary, with a warning instead of a comment.
    const github = runTask(main.dir, taskInputs({ commentKey: "e2e-github" }), { ...main.vars, "Build.Repository.Provider": "GitHub" });
    assert.equal(github.result, "Succeeded", github.log);
    assert.equal(github.warnings.length, 1);
    assert.match(github.warnings[0], /only supported for Azure Repos/);
    assert.equal(parseTable(github.summary).size, 8);
    for (const key of ["e2e-bad-token", "e2e-no-token", "e2e-github"]) {
      assert.equal((await threadsWithKey(repo, main.pr.pullRequestId, key)).length, 0, `${key} must not comment`);
    }

    // Missing manifest.
    const noManifest = runTask(main.dir, taskInputs({ commentKey: "e2e-no-manifest", repositoriesFile: "does/not/exist/*.yaml" }), main.vars);
    assert.equal(noManifest.result, "Failed");
    assert.match(noManifest.message, /No repository manifest matched: does\/not\/exist\/\*\.yaml/);

    // Shallow checkout without the parent commit.
    const shallow = agentCheckout(onCleanup, `pull/${main.pr.pullRequestId}/merge`, { depth: 1 });
    const noParent = runTask(shallow, taskInputs({ commentKey: "e2e-shallow" }), prVariables(repo, shallow, main.pr, main.branch));
    assert.equal(noParent.result, "Failed");
    assert.match(noParent.message, /HEAD\^1/);

    // pullRequest mode outside a pull request build is skipped.
    const skipped = runTask(main.dir, taskInputs({ mode: "pullRequest" }), { ...main.vars, "System.PullRequest.PullRequestId": "" });
    assert.equal(skipped.result, "Skipped", skipped.log);
  });

  test("main pull request: pipeline run with the installed task", { skip: !config.pipelineTask && "set E2E_PIPELINE_TASK" }, async () => {
    const { pullRequestRun, describeRun, runLog, pipelineCommentKey } = await import("./pipeline.mjs");
    const run = await pullRequestRun(pipeline, main.pr.pullRequestId, main.merge);
    assert.equal(run.result, "succeeded", describeRun(run));
    const { content } = await commentWithKey(repo, main.pr.pullRequestId, pipelineCommentKey);
    assertMainRows(content.replaceAll("https://grafana.example.com", grafanaHost), { ref: main.branch, prUrl: prUrl(main.pr), orgs: [{ label: "main", id: 1 }] });
    const log = await runLog(run, "Print output variables");
    assert.match(log, /dashboardCount=8 parseErrorCount=0/);
  });

  test("main pull request: a new push updates the comment", async () => {
    // Drop the added dashboard and bring back the deleted one.
    git(work, "checkout", "-q", main.branch);
    unlinkSync(join(work, "grafana/team a/added.yaml"));
    write(work, "grafana/removed.yaml", render.yaml("e2e-removed", "E2E removed"));
    git(work, "add", "-A");
    git(work, "commit", "-qm", "Second push");
    git(work, "push", "-q", "origin", `${main.branch}:refs/heads/${main.branch}`);
    main.sha2 = git(work, "rev-parse", "HEAD").trim();
    main.merge2 = await waitForMerge(main.pr, main.sha2);

    const dir = agentCheckout(onCleanup, `pull/${main.pr.pullRequestId}/merge`);
    const run = runTask(dir, taskInputs(), prVariables(repo, dir, main.pr, main.branch));
    assert.equal(run.result, "Succeeded", run.log);
    assert.match(run.stdout, /Pull request comment updated/);
    assert.deepEqual(run.outputs, { dashboardCount: "6", parseErrorCount: "0" });
    const threads = await threadsWithKey(repo, main.pr.pullRequestId, "e2e-preview");
    assert.equal(threads.length, 1);
    const rows = parseTable(threads[0].comments[0].content);
    assert.equal(rows.has("grafana/team a/added.yaml"), false);
    assert.equal(rows.has("grafana/removed.yaml"), false);
    assert.equal(rows.size, 6);
  });

  test("main pull request: the pipeline reruns on the new push and updates its comment", { skip: !config.pipelineTask && "set E2E_PIPELINE_TASK" }, async () => {
    const { pullRequestRun, describeRun, pipelineCommentKey } = await import("./pipeline.mjs");
    const run = await pullRequestRun(pipeline, main.pr.pullRequestId, main.merge2);
    assert.equal(run.result, "succeeded", describeRun(run));
    const threads = await threadsWithKey(repo, main.pr.pullRequestId, pipelineCommentKey);
    assert.equal(threads.length, 1);
    assert.equal(parseTable(threads[0].comments[0].content).size, 6);
  });

  // -------------------------------------------------------------------------------------------
  // Other pull requests

  let broken;
  test("broken dashboards: listed under a warning, and the task fails or succeeds with issues", async () => {
    broken = await openPullRequest("broken", (dir) => {
      write(dir, "grafana/broken.yaml", "kind: Dashboard\nmetadata: { name: [unclosed\n");
      write(dir, "grafana/no-uid.yaml", "apiVersion: dashboard.grafana.app/v1beta1\nkind: Dashboard\nmetadata: {}\nspec: { title: No uid }\n");
      write(dir, "grafana/broken.json", "{ not json");
      write(dir, "grafana/good.yaml", yamlDashboard("e2e-good", "E2E good"));
    });
    const dir = agentCheckout(onCleanup, `pull/${broken.pr.pullRequestId}/merge`);
    const vars = prVariables(repo, dir, broken.pr, broken.branch);

    const strict = runTask(dir, taskInputs(), vars);
    assert.equal(strict.result, "Failed", strict.log);
    assert.equal(strict.message, "3 dashboard file(s) could not be parsed.");
    assert.deepEqual(strict.outputs, { dashboardCount: "1", parseErrorCount: "3" });
    assert.equal(strict.errors.filter((e) => e.startsWith("grafana/")).length, 3);
    const { content } = await commentWithKey(repo, broken.pr.pullRequestId, "e2e-preview");
    assert.match(content, /\*\*These files could not be parsed and will fail to sync:\*\*/);
    assert.match(content, /- `grafana\/broken\.yaml`: /);
    assert.match(content, /- `grafana\/broken\.json`: /);
    assert.match(content, /- `grafana\/no-uid\.yaml`: no metadata\.name/);
    assert.deepEqual([...parseTable(content).keys()], ["grafana/good.yaml"]);

    const lenient = runTask(dir, taskInputs({ failOnParseError: "false" }), vars);
    assert.equal(lenient.result, "SucceededWithIssues", lenient.log);
    assert.equal((await threadsWithKey(repo, broken.pr.pullRequestId, "e2e-preview")).length, 1);
  });

  test("broken dashboards: the pipeline run fails and still comments", { skip: !config.pipelineTask && "set E2E_PIPELINE_TASK" }, async () => {
    const { pullRequestRun, describeRun, pipelineCommentKey } = await import("./pipeline.mjs");
    const run = await pullRequestRun(pipeline, broken.pr.pullRequestId, broken.merge);
    assert.equal(run.result, "failed", describeRun(run));
    const { content } = await commentWithKey(repo, broken.pr.pullRequestId, pipelineCommentKey);
    assert.match(content, /could not be parsed/);
    assert.match(content, /grafana\/no-uid\.yaml/);
  });

  test("no dashboard changes: no comment unless asked for", async () => {
    const quiet = await openPullRequest("no-dashboards", (dir) => {
      write(dir, "notes.txt", "only notes\n");
      write(dir, "other/outside.yaml", yamlDashboard("e2e-outside", "Outside"));
    }, { target: `${prefix}-base` });
    const dir = agentCheckout(onCleanup, `pull/${quiet.pr.pullRequestId}/merge`);
    const vars = prVariables(repo, dir, quiet.pr, quiet.branch);

    const run = runTask(dir, taskInputs(), vars);
    assert.equal(run.result, "Succeeded", run.log);
    assert.equal(run.message, "0 dashboard(s) listed.");
    assert.deepEqual(run.outputs, { dashboardCount: "0", parseErrorCount: "0" });
    assert.doesNotMatch(run.stdout, /Pull request comment/);
    assert.equal((await threadsWithKey(repo, quiet.pr.pullRequestId, "e2e-preview")).length, 0);

    const forced = runTask(dir, taskInputs({ commentWhenNoChanges: "true" }), vars);
    assert.equal(forced.result, "Succeeded", forced.log);
    const { content } = await commentWithKey(repo, quiet.pr.pullRequestId, "e2e-preview");
    assert.match(content, /No Git Sync dashboard files changed\./);

    // An existing comment is updated even without changes, so a stale table never lingers.
    const again = runTask(dir, taskInputs({ commentTitle: "Still nothing" }), vars);
    assert.match(again.stdout, /Pull request comment updated/);
  });

  test(`large pull request: ${config.bulkCount} dashboards in one comment`, async () => {
    const bulk = await openPullRequest("bulk", (dir) => {
      for (let i = 0; i < config.bulkCount; i++) {
        write(dir, `grafana/bulk/team-${i % 10}/dashboard-${String(i).padStart(4, "0")}.yaml`, yamlDashboard(`e2e-bulk-${i}`, `E2E bulk ${i}`));
      }
    }, { target: `${prefix}-base` });
    const dir = agentCheckout(onCleanup, `pull/${bulk.pr.pullRequestId}/merge`);
    const started = Date.now();
    const run = runTask(dir, taskInputs(), prVariables(repo, dir, bulk.pr, bulk.branch));
    assert.equal(run.result, "Succeeded", run.log.slice(-2000));
    assert.ok(Date.now() - started < 60_000, `took ${Date.now() - started} ms`);
    assert.equal(run.outputs.dashboardCount, String(config.bulkCount));
    const { content } = await commentWithKey(repo, bulk.pr.pullRequestId, "e2e-preview");
    // Every dashboard is in the summary; the comment lists them all or says where the rest are.
    assert.equal(parseTable(run.summary).size, config.bulkCount);
    const listed = parseTable(content).size;
    if (listed < config.bulkCount) assert.match(content, new RegExp(`${config.bulkCount - listed} more`), "a truncated comment must say so");
  });

  // -------------------------------------------------------------------------------------------
  // Branch mode

  test("branch mode on the pull request branch: no current link where main has no copy", async () => {
    const dir = agentCheckout(onCleanup, main.branch);
    const run = runTask(dir, taskInputs({ mode: "auto" }), branchVariables(repo, dir, main.branch));
    assert.equal(run.result, "Succeeded", run.log);
    assert.match(run.stdout, /Mode: branch/);
    assert.doesNotMatch(run.stdout, /Pull request comment/);
    assert.deepEqual(run.warnings, []);
    assert.doesNotMatch(run.log, /fatal:/);
    assert.ok(run.summary.startsWith(`📊 **Grafana dashboard previews for \`${main.branch}\`**`), run.summary.slice(0, 200));
    const rows = parseTable(run.summary);
    // Branch after the second push: added.yaml dropped, removed.yaml restored, rename kept.
    assert.deepEqual([...rows.keys()], [
      "grafana/existing.yaml", "grafana/json-resource.json", "grafana/removed.yaml", "grafana/renamed-to.yaml", "grafana/team-b/unicode_title.yaml", "ops/ops.yaml",
    ].sort((a, b) => a.localeCompare(b)));
    for (const [path, row] of rows) {
      assert.equal(row.change, undefined);
      const onMain = Boolean(mainFiles[path]);
      assert.equal(Boolean(row.orgs[0].links.current), onMain, `${path} current link`);
      assert.equal(row.orgs[0].links.preview.searchParams.get("ref"), main.branch);
      assert.equal(row.orgs[0].links.preview.searchParams.get("pull_request_url"), null);
    }

    // A synced branch the agent cannot read: warn and keep every current link.
    const unknown = runTask(dir, taskInputs({ mode: "branch", syncedBranch: "no-such-branch" }), branchVariables(repo, dir, main.branch));
    assert.equal(unknown.result, "Succeeded", unknown.log);
    assert.equal(unknown.warnings.length, 1);
    assert.match(unknown.warnings[0], /Cannot read branch 'no-such-branch'/);
    assert.doesNotMatch(unknown.log, /fatal:/);
    for (const row of parseTable(unknown.summary).values()) assert.ok(row.orgs[0].links.current);

    // Without a token the agent cannot fetch main: same fallback, and no credential prompt hangs the task.
    const fresh = agentCheckout(onCleanup, main.branch);
    const noToken = runTask(fresh, taskInputs({ mode: "branch", accessToken: "" }), { ...branchVariables(repo, fresh, main.branch), "System.AccessToken": undefined });
    assert.equal(noToken.result, "Succeeded", noToken.log);
    assert.match(noToken.warnings.join(" "), /Cannot read branch .main./);
    for (const row of parseTable(noToken.summary).values()) assert.ok(row.orgs[0].links.current);
  });

  test("branch mode on main: every dashboard, custom title, no access token needed", async () => {
    const dir = agentCheckout(onCleanup, "main");
    const run = runTask(dir, taskInputs({ mode: "branch", summaryTitle: "All dashboards", accessToken: "" }), branchVariables(repo, dir, "main"));
    assert.equal(run.result, "Succeeded", run.log);
    assert.ok(run.summary.startsWith("All dashboards\n"));
    const rows = parseTable(run.summary);
    assert.deepEqual([...rows.keys()].sort(), Object.keys(mainFiles).filter((p) => !p.startsWith("legacy/")).sort());
    for (const [path, row] of rows) {
      assert.ok(row.orgs[0].links.current, path);
      assert.equal(row.orgs[0].links.preview.searchParams.get("ref"), "main");
    }
    assert.deepEqual(run.outputs, { dashboardCount: "5", parseErrorCount: "0" });

    const noSummary = runTask(dir, taskInputs({ mode: "branch", publishSummary: "false" }), branchVariables(repo, dir, "main"));
    assert.equal(noSummary.result, "Succeeded");
    assert.equal(noSummary.summary, undefined);
  });

  test("branch mode in a real pipeline run: build summary attached", { skip: !config.pipelineTask && "set E2E_PIPELINE_TASK" }, async () => {
    const { branchRun, describeRun, runSummary } = await import("./pipeline.mjs");
    const run = await branchRun(pipeline, main.branch);
    assert.equal(run.result, "succeeded", describeRun(run));
    const summary = await runSummary(run);
    assert.match(summary, new RegExp(`Grafana dashboard previews for \`${main.branch.replace(/[/.]/g, "\\$&")}\``));
    const rows = parseTable(summary);
    assert.equal(rows.size, 6);
    // The agent's checkout has origin/main, so dashboards only on this branch get no current link.
    assert.equal(rows.get("grafana/team-b/unicode_title.yaml").orgs[0].links.current, undefined);
    assert.ok(rows.get("grafana/existing.yaml").orgs[0].links.current);
  });
});
