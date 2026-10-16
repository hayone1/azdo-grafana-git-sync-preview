// Installs or updates a private extension version in an Azure DevOps organization, then waits until
// its pipeline task with that version is available.
//   node scripts/install-extension.mjs <publisher> <extension-id> <version> <task-id>
// Needs AZDO_URL and AZDO_PAT (scope: Extensions read & manage, Agent Pools read).
const [publisher, extension, version, taskId] = process.argv.slice(2);
const org = process.env.AZDO_URL.replace(/\/?$/, "/");
const orgName = new URL(org).pathname.split("/").filter(Boolean)[0];
const headers = { Authorization: "Basic " + Buffer.from(`:${process.env.AZDO_PAT}`).toString("base64"), "Content-Type": "application/json" };

const install = await fetch(
  `https://extmgmt.dev.azure.com/${orgName}/_apis/extensionmanagement/installedextensionsbyname/${publisher}/${extension}/${version}?api-version=7.1-preview.1`,
  { method: "POST", headers },
);
// 409 means this version is already installed.
if (!install.ok && install.status !== 409) throw new Error(`Install failed: ${install.status} ${await install.text()}`);

const [major, minor, patch] = version.split(".").map(Number);
for (let i = 0; i < 60; i++) {
  const resp = await fetch(`${org}_apis/distributedtask/tasks/${taskId}?api-version=7.1`, { headers });
  const tasks = resp.ok ? (await resp.json()).value ?? [] : [];
  if (tasks.some((t) => t.version.major === major && t.version.minor === minor && t.version.patch === patch)) {
    console.log(`${extension} ${version} installed; task ${taskId} is available.`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
throw new Error(`Task ${taskId} ${version} did not appear in ${orgName} within 10 minutes`);
