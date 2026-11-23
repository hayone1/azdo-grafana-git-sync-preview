// Real Azure Pipelines runs of an installed task (E2E_PIPELINE_TASK), for run.mjs.
import { azdo, azdoAuth, config, http, poll } from "./lib.mjs";

export const pipelineCommentKey = "pipeline-preview";

/** Build-validation pipeline that runs the installed task on every pull request into main. */
export const pipelineYaml = () => `trigger: none
pool:
  ${config.pipelinePool ? `name: ${config.pipelinePool}` : "vmImage: ubuntu-latest"}
steps:
  - checkout: self
    fetchDepth: 2
  - task: ${config.pipelineTask}
    name: preview
    inputs:
      grafanaUrl: https://grafana.example.com
      organizations: main=1
      repositoriesFile: grafana-repository.yaml
      commentKey: ${pipelineCommentKey}
  - bash: |
      echo "dashboardCount=$(preview.dashboardCount) parseErrorCount=$(preview.parseErrorCount)"
    displayName: Print output variables
    condition: always()
`;

/** Creates or finds the pipeline, lets its build identity comment, and requires it on pull requests into main. */
export async function ensurePipeline(repo) {
  const name = `${config.repoName}-preview`;
  let def = (await azdo("GET", `build/definitions?name=${encodeURIComponent(name)}`)).value[0];
  if (!def) {
    def = await azdo("POST", "build/definitions", {
      name,
      type: "build",
      process: { type: 2, yamlFilename: "azure-pipelines.yml" },
      repository: { id: repo.id, type: "TfsGit", name: config.repoName, defaultBranch: "refs/heads/main" },
      queue: { name: "Azure Pipelines" },
    });
  }

  // The task posts with System.AccessToken. Grant both build identities Contribute to pull requests;
  // which one a job runs as depends on the "Limit job authorization scope" setting.
  const projectId = (await http(azdoAuth, "GET", `${config.org}_apis/projects/${encodeURIComponent(config.project)}?api-version=7.1`)).json.id;
  let granted = 0;
  for (const identity of [`${config.project} Build Service (${config.orgName})`, `Project Collection Build Service (${config.orgName})`]) {
    const found = (await http(azdoAuth, "GET", `https://vssps.dev.azure.com/${config.orgName}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(identity)}&api-version=7.1`)).json.value[0];
    if (!found) continue;
    // Git repositories security namespace; 16384 = Contribute to pull requests.
    await http(azdoAuth, "POST", `${config.org}_apis/accesscontrolentries/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87?api-version=7.1`, {
      token: `repoV2/${projectId}/${repo.id}`,
      merge: true,
      accessControlEntries: [{ descriptor: found.descriptor, allow: 16384, deny: 0 }],
    });
    granted++;
  }
  if (!granted) throw new Error("Found no build service identity to grant Contribute to pull requests");

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

/** Waits for the policy-queued run of a pull request merge commit to finish. */
export async function pullRequestRun(def, prId, mergeSha) {
  return poll(`the pipeline run for PR ${prId} at merge commit ${mergeSha.slice(0, 8)}`, async () => {
    const runs = (await azdo("GET", `build/builds?definitions=${def.id}&branchName=refs/pull/${prId}/merge&$top=10&queryOrder=queueTimeDescending`)).value;
    // A pull request build checks out the merge commit, so that is its sourceVersion.
    const run = runs.find((r) => r.sourceVersion === mergeSha);
    return run?.status === "completed" ? run : undefined;
  }, 1_200_000, 10_000);
}

/** Queues the pipeline on a branch (branch mode) and waits for it to finish. */
export async function branchRun(def, branch) {
  const queued = await azdo("POST", "build/builds", { definition: { id: def.id }, sourceBranch: `refs/heads/${branch}` });
  return poll(`the branch pipeline run ${queued.id}`, async () => {
    const run = await azdo("GET", `build/builds/${queued.id}`);
    return run.status === "completed" ? run : undefined;
  }, 1_200_000, 10_000);
}

/** The markdown the task attached with ##vso[task.uploadsummary]. */
export async function runSummary(run) {
  const list = (await azdo("GET", `build/builds/${run.id}/attachments/DistributedTask.Core.Summary`)).value;
  if (!list.length) throw new Error(`Run ${run.id} has no summary attachment`);
  return (await http(azdoAuth, "GET", list[0]._links.self.href, undefined, { raw: true })).text;
}

/** The text of the run's log for the task step, to check output variables and warnings. */
export async function runLog(run, stepName) {
  const timeline = await azdo("GET", `build/builds/${run.id}/timeline`);
  const record = timeline.records.find((r) => r.type === "Task" && r.name === stepName && r.log);
  if (!record) throw new Error(`Run ${run.id} has no step '${stepName}' with a log`);
  return (await http(azdoAuth, "GET", record.log.url, undefined, { raw: true })).text;
}

export const describeRun = (run) => `${run._links?.web?.href ?? run.id} finished ${run.result}`;
