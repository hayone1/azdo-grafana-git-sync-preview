import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dist = "../tasks/GrafanaGitSyncPreview/dist/";
const { parseManifests, parseMappings, findRepository } = require(dist + "repositories.js");
const { parseDashboard } = require(dist + "dashboard.js");
const { parseOrganizations, links, buildComment, row } = require(dist + "comment.js");

test("reads Grafana Repository manifests", () => {
  const repos = parseManifests(
    `apiVersion: provisioning.grafana.app/v0alpha1
kind: Repository
metadata: { name: team-a }
spec: { type: git, git: { url: x, branch: main, path: dashboards/team-a/ } }
---
kind: ConfigMap
`,
    "r.yaml",
  );
  assert.deepEqual(repos, [{ path: "dashboards/team-a", name: "team-a" }]);
});

test("reads Crossplane RepositoryV0Alpha1 resources", () => {
  const repos = parseManifests(
    `kind: RepositoryV0Alpha1
spec:
  forProvider:
    metadata: { uid: shared }
    spec: { type: git, git: { path: /grafana/shared } }
`,
    "r.yaml",
  );
  assert.deepEqual(repos, [{ path: "grafana/shared", name: "shared" }]);
});

test("deepest mapped folder wins", () => {
  const repos = parseMappings(["dashboards=all", "dashboards/team-a=team-a", ".=root"]);
  assert.equal(findRepository(repos, "dashboards/team-a/x.json").repo.name, "team-a");
  assert.equal(findRepository(repos, "dashboards/x.json").relPath, "x.json");
  assert.equal(findRepository(repos, "README.json").repo.name, "root");
});

test("parses v2 and classic dashboards, ignores other files", () => {
  assert.deepEqual(parseDashboard("kind: Dashboard\nmetadata: { name: abc }\nspec: { title: T }", "a.yaml"), {
    uid: "abc",
    title: "T",
  });
  assert.deepEqual(parseDashboard('{"uid":"u","title":"C","panels":[],"schemaVersion":39}', "a.json"), {
    uid: "u",
    title: "C",
  });
  assert.equal(parseDashboard('{"kind":"Folder"}', "a.json"), undefined);
  assert.throws(() => parseDashboard("kind: Dashboard\nmetadata: {}", "a.yaml"), /metadata.name/);
});

test("parses organizations", () => {
  assert.deepEqual(parseOrganizations(["test=1", "", "3"]), [{ label: "test", id: 1 }, { label: undefined, id: 3 }]);
  assert.throws(() => parseOrganizations(["x=abc"]));
  assert.throws(() => parseOrganizations([""]));
});

const linkOptions = {
  grafanaUrl: "https://g.example/",
  organizations: [{ id: 1 }],
  ref: "feature/x",
  pullRequestUrl: "https://dev.azure.com/o/p/_git/r/pullrequest/7",
  showCurrent: true,
  showPreview: true,
};
const base = { path: "d/a b.json", title: "A|B", uid: "u1", repository: "repo", relPath: "a b.json" };

test("builds current and preview links per change type", () => {
  const modified = links({ ...base, change: "modified" }, linkOptions);
  assert.match(modified, /\[current\]\(https:\/\/g\.example\/d\/u1\?orgId=1\)/);
  assert.match(modified, /\/dashboard\/provisioning\/repo\/preview\/a%20b\.json\?ref=feature%2Fx/);
  assert.doesNotMatch(links({ ...base, change: "added" }, linkOptions), /current/);
  assert.doesNotMatch(links({ ...base, change: "deleted" }, linkOptions), /preview/);
});

test("branch rows have no change column and previews omit pull_request_url", () => {
  const branchOptions = { ...linkOptions, pullRequestUrl: undefined };
  const r = row(base, branchOptions);
  assert.match(r, /^\| \*\*A\\\|B\*\*<br>`d\/a b\.json` \| \[current\]/);
  assert.doesNotMatch(r, /pull_request_url/);
  const body = buildComment([r], [], { title: "T", ref: "main", withChange: false });
  assert.ok(body.startsWith("T\n"));
  assert.match(body, /\| Dashboard \| Links \|/);
});

test("builds comment with marker, escaped rows and errors", () => {
  const body = buildComment([row({ ...base, change: "added" }, linkOptions)], [["bad.json", "oops"]], {
    key: "k",
    title: "Title",
    ref: "feature/x",
  });
  assert.ok(body.startsWith("<!-- k -->\nTitle"));
  assert.match(body, /A\\\|B/);
  assert.match(body, /`bad.json`: oops/);
});
