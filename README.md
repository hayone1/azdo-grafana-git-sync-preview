# Grafana Git Sync PR Preview for Azure DevOps

An Azure Pipelines task that brings Grafana Git Sync's pull request comment to Azure Repos.

Grafana [Git Sync](https://grafana.com/docs/grafana/latest/observability-as-code/provision-resources/intro-git-sync/) comments "view current" and "preview changes" links on GitHub pull requests. Azure DevOps has no native integration, so reviewers there only see raw JSON or YAML. This task posts the same links on Azure Repos pull requests.

## Modes

| Mode | Lists | Output |
|---|---|---|
| `pullRequest` | Dashboards the pull request adds, changes or deletes | Pull request comment, build summary, log |
| `branch` | Every dashboard on the built branch | Build summary, log |
| `auto` (default) | `pullRequest` for pull request builds, otherwise `branch` | |

Branch mode lets you preview a branch without opening a pull request: push, run the pipeline, and open the **Extensions** tab on the run summary (or the log) for links. It needs no access token and works with any repository provider Azure Pipelines can build, including GitHub.

The build summary is attached with the [`task.uploadsummary`](https://learn.microsoft.com/azure/devops/pipelines/scripts/logging-commands#uploadsummary-add-some-markdown-content-to-the-build-summary) logging command, the Azure DevOps equivalent of a GitHub job summary.

## What it does in a pull request

On a pull request build, the task:

1. Diffs the pull request against its target branch.
2. Keeps the files that sit under a folder Git Sync watches.
3. Parses each one. Files that are not dashboards are skipped.
4. Posts one comment with a row per dashboard:

| Dashboard | Change | Links |
|---|---|---|
| **Service health**<br>`grafana/team-a/health.yaml` | modified | test: [current]() · [preview]()<br>production: [current]() · [preview]() |

- **current** opens the live dashboard (`/d/<uid>`). Not shown for added dashboards.
- **preview** opens Git Sync's preview route for the file on the source branch. Nothing is created or saved in Grafana. Not shown for deleted dashboards.

Every later push updates the same comment, so the pull request never collects duplicates. Dashboards that cannot be parsed, or have no uid, are listed under a warning and fail the task by default.

The task reads dashboard resources (`kind: Dashboard` with `metadata.name`, any `dashboard.grafana.app` version) and classic dashboard JSON (top-level `uid`, `panels` and `schemaVersion`), in YAML or JSON. Grafana 13 Git Sync only syncs dashboard resources. It rejects classic JSON with `unable to read bytes as a resource`, so prefer resources:

```yaml
# grafana/team-a/health.yaml
apiVersion: dashboard.grafana.app/v1beta1
kind: Dashboard
metadata:
  name: service-health   # the dashboard uid
spec:
  title: Service health
  schemaVersion: 39
  panels: []
```

## Requirements

- Pull request comments need Azure Repos Git. Branch mode works with any repository Azure Pipelines can build.
- A Grafana instance with Git Sync reading the same content. The preview route must be able to read the source branch.
- Grafana cannot read Azure Repos directly. See [Connect Grafana to Azure Repos](#connect-grafana-to-azure-repos).
- An agent with `git` on the path and agent version 3.232.1 or later.
- The project build service identity needs **Contribute to pull requests** on the repository. Set it in *Project settings > Repositories > (repo) > Security*.

## Connect Grafana to Azure Repos

Git Sync's Pure Git repository type speaks Git protocol v2. Azure Repos only speaks v0 and v1, and rejects v2 with `TF401041: The Git protocol sent is not as expected`. Put [git-v2-azuredevops-proxy](https://github.com/Dominik-esb/git-v2-azuredevops-proxy) between them. It mirrors every branch of the Azure repository, serves protocol v2 to Grafana, and forwards pushes to Azure DevOps.

1. Deploy the proxy with its `k8s/pat` overlay, or `k8s/entra-workload-identity` to avoid a PAT. Set `AZURE_DEVOPS_URL` to the repository, for example `https://dev.azure.com/contoso/Monitoring/_git/dashboards`.
2. Expose it over HTTPS on a host that resolves to a public address. Grafana refuses `http://` when a token is set, and refuses cluster-internal hosts such as `*.svc.cluster.local`.
3. Read the token for the repository from the proxy log:

   ```sh
   kubectl logs -n git-proxy deploy/git-proxy | grep -A5 '\[credentials\]'
   ```

4. Commit a Repository manifest that points at the proxy. Use the Azure repository name as `tokenUser`:

   ```yaml
   # grafana/repositories/dashboards.yaml
   apiVersion: provisioning.grafana.app/v0alpha1
   kind: Repository
   metadata:
     name: dashboards
   spec:
     title: Dashboards
     type: git
     git:
       url: https://git-proxy.example.com/dashboards.git
       branch: main
       path: grafana/
       tokenUser: dashboards
     sync:
       enabled: true
       target: folder
       intervalSeconds: 60
     workflows: []
   ```

5. Apply it to Grafana with the proxy token in `secure.token`, through your usual tooling or the API:

   ```sh
   yq -o json grafana/repositories/dashboards.yaml      | jq --arg t "$PROXY_TOKEN" '.secure.token.create = $t'      | curl -fsS -X POST -H "Authorization: Bearer $GRAFANA_TOKEN" -H "Content-Type: application/json"          --data @- https://grafana.example.com/apis/provisioning.grafana.app/v0alpha1/namespaces/default/repositories
   ```

The task reads the same manifest through `repositoriesFile`, so its links match what Grafana syncs. The task never talks to the proxy.

The proxy fetches from Azure DevOps every `SYNC_INTERVAL` (default 60 seconds), so a preview link can show "not found" for up to a minute after a push.

## Usage

Add a pipeline and run it as a **build validation** branch policy on your target branch. Azure Repos ignores the YAML `pr:` trigger.

```yaml
trigger: none

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    fetchDepth: 2   # HEAD^1 must exist to diff against the target branch.

  - task: GrafanaGitSyncPreview@0
    inputs:
      grafanaUrl: https://grafana.example.com
      organizations: |
        test=1
        production=3
      repositorySource: file
      repositoriesFile: |
        grafana/repositories/**/*.yaml
```

### Branch previews

Run the same pipeline manually or on push. In `auto` mode a non pull request build lists every dashboard on the branch:

```yaml
trigger:
  branches:
    exclude: [main]

steps:
  - task: GrafanaGitSyncPreview@0
    inputs:
      grafanaUrl: https://grafana.example.com
      repositoriesFile: grafana/repositories/*.yaml
```

Grafana must be able to read the branch through Git Sync for preview links to render.

### Without Repository manifests

If your Git Sync repositories are not defined in this repository, map folders inline:

```yaml
  - task: GrafanaGitSyncPreview@0
    inputs:
      grafanaUrl: https://grafana.example.com
      repositorySource: inline
      repositories: |
        dashboards/team-a=team-a-dashboards
        dashboards/team-b=team-b-dashboards
```

The left side is the folder in this repository (the Git Sync `path`). The right side is the Grafana repository name (`metadata.name` of the `Repository` resource). Use `.` for the repository root. When folders nest, the deepest match wins.

### Source branch checkout

The default `baseRevision` of `HEAD^1` assumes the pipeline checks out the pull request merge commit, which is the Azure Pipelines default. If you check out the source branch instead, diff against the target branch:

```yaml
  - checkout: self
    fetchDepth: 0
  - task: GrafanaGitSyncPreview@0
    inputs:
      grafanaUrl: https://grafana.example.com
      repositoriesFile: grafana/repositories/*.yaml
      baseRevision: origin/$(System.PullRequest.TargetBranchName)
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `grafanaUrl` | (required) | Base URL of the Grafana instance that runs Git Sync. |
| `mode` | `auto` | `auto`, `pullRequest` or `branch`. See [Modes](#modes). |
| `organizations` | `1` | One Grafana organization per line, as `orgId` or `label=orgId`. Each dashboard gets links for every organization. |
| `repositorySource` | `file` | `file` reads Repository manifests. `inline` uses `repositories`. |
| `repositoriesFile` | | Paths or globs, one per line, relative to `workingDirectory`. Accepts Grafana `provisioning.grafana.app` `Repository` manifests and Crossplane `RepositoryV0Alpha1` resources. Multi-document YAML is supported. |
| `repositories` | | Inline mappings, `folder=repository-name`, one per line. |
| `showCurrentLinks` | `true` | Show links to the live dashboard. |
| `showPreviewLinks` | `true` | Show links to the Git Sync preview. |
| `fileExtensions` | `.json,.yaml,.yml` | Comma-separated extensions treated as dashboard files. |
| `commentTitle` | `📊 **Grafana dashboard changes in this pull request**` | Markdown heading of the comment. |
| `commentKey` | `grafana-dashboard-preview` | Hidden marker that identifies the comment to update. Use a different key per task instance, for example one per Grafana instance. |
| `threadStatus` | `closed` | Status of a new comment thread. `closed` never blocks completion under a "resolve all comments" policy. |
| `commentWhenNoChanges` | `false` | Post a comment even when no dashboard changed. An existing comment is always updated. |
| `publishSummary` | `true` | Attach the dashboard table to the run's summary page. |
| `summaryTitle` | | Markdown heading of the build summary in branch mode. Defaults to a title naming the branch. |
| `failOnParseError` | `true` | Fail the task when a changed dashboard cannot be parsed. When `false`, the task succeeds with issues. |
| `baseRevision` | `HEAD^1` | Git revision to diff `HEAD` against. Pull request mode only. |
| `ref` | | Branch or tag to preview. Defaults to the pull request source branch, or the built branch. |
| `syncedBranch` | | Branch Grafana syncs. In branch mode, dashboards missing from it get no `current` link, since Grafana has no live copy. Defaults to the `branch` in each Repository manifest, then `main`. |
| `workingDirectory` | `$(Build.SourcesDirectory)` | Git checkout to inspect. |
| `accessToken` | `$(System.AccessToken)` | Token used to read and write pull request threads. Not used in branch mode. |

## Output variables

| Variable | Description |
|---|---|
| `dashboardCount` | Number of changed dashboards in the comment. |
| `parseErrorCount` | Number of changed dashboard files that could not be parsed. |

Give the task a `name` to read them in later steps, for example `$(preview.dashboardCount)`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `fatal: bad revision 'HEAD^1'` | Shallow checkout. Set `fetchDepth: 2` or more. |
| `401` or `403` on `pullRequests/.../threads` | Build service lacks **Contribute to pull requests**, or the job token is scoped too narrowly. Check *Project settings > Settings > Limit job authorization scope*. |
| Task is skipped | `mode` is `pullRequest` but the build is not for a pull request. Use `auto` or run it from a build validation policy. |
| No pull request comment, warning in log | The repository is not Azure Repos. Links are still in the log and build summary. |
| Preview link shows an error | Grafana cannot read the source branch yet. The proxy and Git Sync can each lag a push by up to a minute. Wait and reload. |
| Preview shows `unable to read bytes as a resource` | The file is classic dashboard JSON. Grafana 13 Git Sync needs a dashboard resource, as in the example above. |
| No rows for a changed file | The file is outside every Git Sync folder, has another extension, or is not a dashboard. |

## Development

Requires Node.js 20 or later.

```sh
npm install        # also installs the task's dependencies
npm test           # builds the task and runs unit tests
npm run package    # builds a .vsix into out/
npm run test:e2e   # end-to-end test, see below
```

### End-to-end test

[e2e/run.mjs](e2e/run.mjs) tests the task against a real Azure DevOps organization and a local Grafana. You need Docker, Node.js 22 and an Azure DevOps project you can create repositories in. A free organization works.

1. Copy [.env.example](.env.example) to `.env` and fill in `AZDO_URL`, `AZDO_PAT` and `AZDO_PROJECT`. `.env` is git-ignored.
2. Start Grafana 13 and [git-v2-azuredevops-proxy](https://github.com/Dominik-esb/git-v2-azuredevops-proxy) from [e2e/docker-compose.yml](e2e/docker-compose.yml):

   ```sh
   npm run e2e:up      # Grafana on http://localhost:3000, admin/admin
   npm run test:e2e
   npm run e2e:down
   ```

The test pushes a YAML fixture to the `grafana-git-sync-e2e` repository and opens a pull request that adds, modifies and deletes dashboards. It runs the built task as an agent would, then checks:

- the pull request comment, and that a second run updates it instead of adding another,
- branch mode and its build summary,
- that Grafana syncs the repository through the proxy, and that every link in the comment resolves: current links through `/api/dashboards/uid`, preview links through Git Sync at the pull request branch.

Remove the `GRAFANA_*` and `GIT_PROXY_URL` lines from `.env` to skip the Grafana checks. Set `E2E_KEEP=1` to keep the pull request and the Grafana repository for a look.

To also test an extension installed in your organization, set `E2E_PIPELINE_TASK`, for example `GrafanaGitSyncPreview@0`. The test then adds a build-validation pipeline that runs that task on the test pull request, using the hosted `ubuntu-latest` agent or the pool in `E2E_PIPELINE_POOL`, and checks that the run succeeds and posts its comment. The release workflow uses this to test each build as a private dev extension before releasing it. See [docs/PUBLISHING.md](docs/PUBLISHING.md#5-release).

The local stack sets `GF_PROVISIONING_ALLOW_INSECURE` and `GF_PROVISIONING_ALLOWED_GIT_URLS` so Grafana accepts the proxy over plain http on a private host. Do not use those settings in production; expose the proxy over HTTPS as described in [Connect Grafana to Azure Repos](#connect-grafana-to-azure-repos).

CI runs the same test on pushes to this repository (not forks). It needs an `e2e` environment with the `AZDO_URL` and `AZDO_PROJECT` variables and the `AZDO_PAT` secret.

To test against a real pull request without publishing, see [docs/PUBLISHING.md](docs/PUBLISHING.md#test-privately).

Releases are built and published from GitHub Actions. See [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License

[MIT](LICENSE)
