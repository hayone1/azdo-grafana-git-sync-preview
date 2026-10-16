// Builds the .vsix files into out/.
//   node scripts/package.mjs           release extension
//   node scripts/package.mjs --dev     dev extension only
//   node scripts/package.mjs --all     both, from one build
//
// The dev extension is the same build under another extension id, task id and task name
// (GrafanaGitSyncPreviewDev), so it can be installed next to the release one and tested in a real
// pipeline before the release extension is published. Extra arguments go to `tfx extension create`
// for the release extension only, so `--override '{"public": true}'` never makes the dev one public.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const task = "tasks/GrafanaGitSyncPreview";
const args = process.argv.slice(2);
const variants = args.includes("--all") ? ["release", "dev"] : args.includes("--dev") ? ["dev"] : ["release"];
const tfxArgs = args.filter((a) => a !== "--all" && a !== "--dev").map((a) => JSON.stringify(a)).join(" ");
const run = (cmd, cwd) => execSync(cmd, { stdio: "inherit", cwd });

// Fixed so every dev release updates the same task in Azure DevOps.
const DEV_TASK_ID = "5b0b0a8e-6f0e-4c39-9d2a-3b7c1d6e2f41";

run("npm ci", task);
run("npm run build", task);
// The .vsix ships the task folder as-is, so only runtime dependencies may remain.
run("npm prune --omit=dev", task);
mkdirSync("out", { recursive: true });

for (const variant of variants) {
  if (variant === "release") {
    run(`npx tfx extension create --manifest-globs vss-extension.json --output-path out ${tfxArgs}`);
    continue;
  }

  const stage = join("out", "dev-stage");
  rmSync(stage, { recursive: true, force: true });
  for (const p of [task, "images", "overview.md", "LICENSE", "vss-extension.json"]) cpSync(p, join(stage, p), { recursive: true });

  const manifestPath = join(stage, "vss-extension.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.id += "-dev";
  manifest.name += " (dev)";
  manifest.public = false;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const taskPath = join(stage, task, "task.json");
  const taskJson = JSON.parse(readFileSync(taskPath, "utf8"));
  taskJson.id = DEV_TASK_ID;
  taskJson.name += "Dev";
  taskJson.friendlyName += " (dev)";
  writeFileSync(taskPath, JSON.stringify(taskJson, null, 2));

  run("npx tfx extension create --manifest-globs vss-extension.json --output-path ..", stage);
  rmSync(stage, { recursive: true, force: true });
}
