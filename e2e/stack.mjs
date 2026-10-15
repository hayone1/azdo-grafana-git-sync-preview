// Starts or stops the local Grafana + proxy stack in docker-compose.yml.
//   node --env-file=.env e2e/stack.mjs up|down
// The proxy mirrors the test repository when it starts, so `up` creates the repository first.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const action = process.argv[2];
const compose = join(dirname(fileURLToPath(import.meta.url)), "docker-compose.yml");
const org = (env.AZDO_URL ?? "").replace(/\/?$/, "/");
const repoName = env.AZDO_E2E_REPO || "grafana-git-sync-e2e";
const docker = (...args) => execFileSync("docker", ["compose", "-f", compose, ...args], { stdio: "inherit", env: { ...env, AZURE_DEVOPS_URL: `${org}${encodeURIComponent(env.AZDO_PROJECT ?? "")}/_git/${encodeURIComponent(repoName)}` } });

if (action === "up") {
  for (const k of ["AZDO_URL", "AZDO_PAT", "AZDO_PROJECT"]) if (!env[k]) throw new Error(`Set ${k}`);
  const api = `${org}${encodeURIComponent(env.AZDO_PROJECT)}/_apis/git/repositories`;
  const headers = { Authorization: "Basic " + Buffer.from(`:${env.AZDO_PAT}`).toString("base64"), "Content-Type": "application/json" };
  const found = await fetch(`${api}/${repoName}?api-version=7.1`, { headers });
  if (found.status === 404) {
    const created = await fetch(`${api}?api-version=7.1`, { method: "POST", headers, body: JSON.stringify({ name: repoName }) });
    if (!created.ok) throw new Error(`Creating ${repoName}: ${created.status} ${await created.text()}`);
  } else if (!found.ok) throw new Error(`Reading ${repoName}: ${found.status} ${await found.text()}`);
  docker("up", "-d", "--wait");
  console.log("Grafana: http://localhost:3000 (admin/admin)");
} else if (action === "down") {
  docker("down", "-v");
} else {
  console.error("Usage: node e2e/stack.mjs up|down");
  process.exit(1);
}
