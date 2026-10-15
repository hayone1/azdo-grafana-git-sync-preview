import { readFileSync, writeFileSync } from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!match) {
  console.error("Usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(1);
}
const [major, minor, patch] = match.slice(1).map(Number);

function update(path, change) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  change(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

update("vss-extension.json", (m) => (m.version = version));
update("package.json", (p) => (p.version = version));
update("tasks/GrafanaGitSyncPreview/package.json", (p) => (p.version = version));
update("tasks/GrafanaGitSyncPreview/task.json", (t) => (t.version = { Major: major, Minor: minor, Patch: patch }));
console.log(`Version set to ${version}`);
