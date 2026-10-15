import * as fs from "fs";
import * as path from "path";
import * as tl from "azure-pipelines-task-lib/task";
import { buildComment, Change, LinkOptions, linkUrls, marker, parseOrganizations, Row, row } from "./comment";
import { parseDashboard } from "./dashboard";
import { changedFiles, show, trackedFiles } from "./git";
import { findRepository, parseManifests, parseMappings, Repository } from "./repositories";
import { createThread, findThread, PullRequestContext, updateComment } from "./azureDevOps";

type Mode = "pullRequest" | "branch";

interface Scan {
  rows: Row[];
  errors: [string, string][];
}

function lines(name: string): string[] {
  return (tl.getInput(name) ?? "").split(/\r?\n/);
}

function loadRepositories(cwd: string): Repository[] {
  if (tl.getInput("repositorySource", true) === "inline") return parseMappings(lines("repositories"));

  const patterns = lines("repositoriesFile").map((l) => l.trim()).filter(Boolean);
  const files = tl.findMatch(cwd, patterns).filter((f) => fs.statSync(f).isFile());
  if (files.length === 0) throw new Error(`No repository manifest matched: ${patterns.join(", ")}`);
  return files.flatMap((f) => parseManifests(fs.readFileSync(f, "utf8"), f));
}

function collectionBase(): string {
  const uri = tl.getVariable("System.CollectionUri")!;
  return uri.endsWith("/") ? uri : uri + "/";
}

function resolveMode(): Mode {
  const mode = tl.getInput("mode") || "auto";
  if (mode === "pullRequest" || mode === "branch") return mode;
  return tl.getVariable("System.PullRequest.PullRequestId") ? "pullRequest" : "branch";
}

function addRow(scan: Scan, repos: Repository[], file: string, read: () => string, change?: Change) {
  const match = findRepository(repos, file);
  if (!match) return;
  try {
    const dashboard = parseDashboard(read(), file);
    if (dashboard) scan.rows.push({ path: file, ...dashboard, repository: match.repo.name, relPath: match.relPath, change });
  } catch (e) {
    scan.errors.push([file, String((e as Error).message).split("\n")[0]]);
  }
}

function scanChanges(cwd: string, repos: Repository[], isDashboardFile: (f: string) => boolean): Scan {
  const base = tl.getInput("baseRevision") || "HEAD^1";
  const scan: Scan = { rows: [], errors: [] };
  for (const { status, path: file } of changedFiles(cwd, base)) {
    if (!isDashboardFile(file)) continue;
    const deleted = status === "D";
    const change: Change = status === "A" ? "added" : deleted ? "deleted" : "modified";
    addRow(scan, repos, file, () => show(cwd, deleted ? base : "HEAD", file), change);
  }
  return scan;
}

function scanAll(cwd: string, repos: Repository[], isDashboardFile: (f: string) => boolean): Scan {
  const scan: Scan = { rows: [], errors: [] };
  for (const file of trackedFiles(cwd)) {
    if (isDashboardFile(file)) addRow(scan, repos, file, () => fs.readFileSync(path.join(cwd, file), "utf8"));
  }
  scan.rows.sort((a, b) => a.path.localeCompare(b.path));
  return scan;
}

function logLinks(rows: Row[], o: LinkOptions) {
  for (const r of rows) {
    console.log(`${r.title} (${r.path})${r.change ? ` [${r.change}]` : ""}`);
    for (const org of linkUrls(r, o)) {
      for (const u of org.urls) console.log(`  ${org.label ? `${org.label} ` : ""}${u.kind}: ${u.url}`);
    }
  }
}

function publishSummary(content: string) {
  if (!tl.getBoolInput("publishSummary")) return;
  const dir = tl.getVariable("Agent.TempDirectory") || process.cwd();
  const file = path.join(dir, `grafana-git-sync-preview-${tl.getVariable("System.JobId") ?? "job"}-${Date.now()}.md`);
  fs.writeFileSync(file, content);
  tl.uploadSummary(file);
}

async function commentOnPullRequest(content: string, key: string, hasContent: boolean) {
  if (tl.getVariable("Build.Repository.Provider") !== "TfsGit") {
    tl.warning("Pull request comments are only supported for Azure Repos. Links are in the log and build summary.");
    return;
  }
  const token = tl.getInput("accessToken") || tl.getVariable("System.AccessToken");
  if (!token) throw new Error("No access token. Set the accessToken input or allow scripts to access the OAuth token.");
  tl.setSecret(token);

  const ctx: PullRequestContext = {
    collectionUri: collectionBase(),
    project: tl.getVariable("System.TeamProject")!,
    repositoryId: tl.getVariable("Build.Repository.ID")!,
    pullRequestId: tl.getVariable("System.PullRequest.PullRequestId")!,
    token,
  };

  const existing = await findThread(ctx, marker(key));
  if (existing) {
    await updateComment(ctx, existing.threadId, existing.commentId, content);
    console.log("Pull request comment updated.");
  } else if (hasContent || tl.getBoolInput("commentWhenNoChanges")) {
    await createThread(ctx, content, tl.getInput("threadStatus") || "closed");
    console.log("Pull request comment created.");
  }
}

async function run() {
  const mode = resolveMode();
  const pullRequestId = tl.getVariable("System.PullRequest.PullRequestId");
  if (mode === "pullRequest" && !pullRequestId) {
    tl.setResult(tl.TaskResult.Skipped, "Not a pull request build, nothing to comment on.");
    return;
  }

  const cwd = tl.getPathInput("workingDirectory") || tl.getVariable("Build.SourcesDirectory") || process.cwd();
  const project = tl.getVariable("System.TeamProject")!;
  const sourceBranch = mode === "pullRequest"
    ? tl.getVariable("System.PullRequest.SourceBranch")
    : tl.getVariable("Build.SourceBranch");
  const ref = tl.getInput("ref") || (sourceBranch ?? "").replace(/^refs\/(heads|tags)\//, "");
  if (!ref) throw new Error("Cannot tell which branch to preview. Set the ref input.");

  const linkOptions: LinkOptions = {
    grafanaUrl: tl.getInput("grafanaUrl", true)!,
    organizations: parseOrganizations(lines("organizations")),
    ref,
    pullRequestUrl: mode === "pullRequest"
      ? `${collectionBase()}${encodeURIComponent(project)}/_git/${encodeURIComponent(tl.getVariable("Build.Repository.Name")!)}/pullrequest/${pullRequestId}`
      : undefined,
    showCurrent: tl.getBoolInput("showCurrentLinks"),
    showPreview: tl.getBoolInput("showPreviewLinks"),
  };
  const extensions = (tl.getInput("fileExtensions") || ".json,.yaml,.yml")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const isDashboardFile = (f: string) => extensions.some((e) => f.toLowerCase().endsWith(e));
  const key = tl.getInput("commentKey") || "grafana-dashboard-preview";
  const title = tl.getInput("commentTitle") || "Grafana dashboard changes";

  const repos = loadRepositories(cwd);
  console.log(`Mode: ${mode}, ref: ${ref}`);
  console.log(`Git Sync repositories: ${repos.map((r) => `${r.path || "."} -> ${r.name}`).join(", ")}`);

  const { rows, errors } = mode === "pullRequest"
    ? scanChanges(cwd, repos, isDashboardFile)
    : scanAll(cwd, repos, isDashboardFile);

  tl.debug(`Found ${rows.length} dashboard(s) and ${errors.length} parse error(s).`);
  logLinks(rows, linkOptions);
  for (const [file, err] of errors) tl.error(`${file}: ${err}`, tl.IssueSource.CustomerScript);

  const tableRows = rows.map((r) => row(r, linkOptions));
  if (mode === "pullRequest") {
    const comment = buildComment(tableRows, errors, { key, ref, title });
    publishSummary(buildComment(tableRows, errors, { ref, title }));
    await commentOnPullRequest(comment, key, rows.length > 0 || errors.length > 0);
  } else {
    const summaryTitle = tl.getInput("summaryTitle") || `📊 **Grafana dashboard previews for \`${ref}\`**`;
    publishSummary(buildComment(tableRows, errors, { ref, title: summaryTitle, withChange: false }));
  }

  tl.setVariable("dashboardCount", String(rows.length), false, true);
  tl.setVariable("parseErrorCount", String(errors.length), false, true);

  if (errors.length) {
    const message = `${errors.length} dashboard file(s) could not be parsed.`;
    if (tl.getBoolInput("failOnParseError")) tl.setResult(tl.TaskResult.Failed, message);
    else tl.setResult(tl.TaskResult.SucceededWithIssues, message);
  } else {
    tl.setResult(tl.TaskResult.Succeeded, `${rows.length} dashboard(s) listed.`);
  }
}

run().catch((e) => tl.setResult(tl.TaskResult.Failed, (e as Error).message));
