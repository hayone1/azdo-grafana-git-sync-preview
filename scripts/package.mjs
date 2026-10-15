import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const task = "tasks/GrafanaGitSyncPreview";
const run = (cmd, cwd) => execSync(cmd, { stdio: "inherit", cwd });

run("npm ci", task);
run("npm run build", task);
// The .vsix ships the task folder as-is, so only runtime dependencies may remain.
run("npm prune --omit=dev", task);
mkdirSync("out", { recursive: true });
run(`npx tfx extension create --manifest-globs vss-extension.json --output-path out ${process.argv.slice(2).join(" ")}`);
