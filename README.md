# Grafana Git Sync PR Preview for Azure DevOps

Grafana Git Sync PR Preview is an Azure Pipelines task. The task adds Grafana dashboard links to Azure Repos pull requests.

Grafana [Git Sync](https://grafana.com/docs/grafana/latest/observability-as-code/provision-resources/intro-git-sync/) keeps Grafana dashboards as files in a Git repository. On GitHub pull requests, Git Sync adds a comment with "view current" and "preview changes" links. Azure DevOps has no Git Sync integration. Thus, reviewers on Azure Repos see only raw JSON or YAML. This task adds the same links to Azure Repos pull requests.

## Modes

The task has two modes. The `mode` input selects the mode.

| Mode | Dashboards in the list | Output |
|---|---|---|
| `pullRequest` | The dashboards that the pull request adds, changes or deletes | Pull request comment, build summary and log |
| `branch` | All dashboards on the built branch | Build summary and log |
| `auto` (default) | `pullRequest` for a pull request build, `branch` for all other builds | |

Use branch mode to preview a branch without a pull request:

1. Push the branch.
2. Run the pipeline on the branch.
3. Open the **Extensions** tab on the run summary page. The log also shows the links.

Branch mode works with all repository providers that Azure Pipelines can build, GitHub included.

In branch mode, the task does not show a `current` link for a dashboard that is not on the synced branch yet. The synced branch is the branch that Grafana reads, for example `main`. To find these dashboards, the task must read the synced branch. A shallow checkout does not contain the synced branch. On Azure Repos, the task gets the synced branch with the job token. On other providers, set `fetchDepth: 0` on the checkout step.

The task attaches the build summary with the [`task.uploadsummary`](https://learn.microsoft.com/azure/devops/pipelines/scripts/logging-commands#uploadsummary-add-some-markdown-content-to-the-build-summary) logging command. A build summary in Azure DevOps is the same as a job summary in GitHub Actions.

## What the task does in a pull request

In a pull request build, the task does these steps:

1. The task compares the pull request with its target branch.
2. The task keeps only the changed files in a folder that Git Sync reads.
3. The task reads each file. The task ignores a file that is not a dashboard.
4. The task adds one comment with one row for each dashboard:

| Dashboard | Change | Links |
|---|---|---|
| **Service health**<br>`grafana/team-a/health.yaml` | modified | test: [current]() · [preview]()<br>production: [current]() · [preview]() |

- The **current** link opens the live dashboard (`/d/<uid>`). An added dashboard has no current link, because Grafana does not have the dashboard yet.
- The **preview** link opens the Git Sync preview of the file on the source branch. Grafana does not save the preview. A deleted dashboard has no preview link, because the source branch does not have the file.

Each new push updates the same comment. Thus, the pull request has only one comment from the task. The comment lists dashboards that the task cannot read, or that have no uid, under a warning. By default, these dashboards make the task fail. The failure stops a broken dashboard before it gets to the target branch.

The task reads two dashboard formats, in YAML or JSON:

- A dashboard resource has `kind: Dashboard` and a `metadata.name`. All `dashboard.grafana.app` versions are supported.
- A classic dashboard JSON file has a top-level `uid`, `panels` and `schemaVersion`.

Use dashboard resources. Grafana 13 Git Sync syncs only dashboard resources. Git Sync rejects classic dashboard JSON with the error `unable to read bytes as a resource`. This example is a dashboard resource:

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

- Pull request comments need an Azure Repos Git repository. Branch mode works with all repositories that Azure Pipelines can build.
- You need a Grafana instance with Git Sync. Git Sync must read the same repository as the pipeline. Git Sync must also read the source branch of the pull request, or the preview links show an error.
- Grafana cannot read Azure Repos without help. See [Connect Grafana to Azure Repos](#connect-grafana-to-azure-repos).
- The agent must have `git` on the path. The agent version must be 3.232.1 or later.
- The project build service identity must have the **Contribute to pull requests** permission on the repository. Without this permission, the task cannot add the comment. Set the permission in *Project settings > Repositories > (repository) > Security*.

## Connect Grafana to Azure Repos

Git Sync uses the **Pure Git** repository type for Azure Repos. Pure Git uses Git protocol v2. Azure Repos supports only Git protocol v0 and v1. Azure Repos rejects Git protocol v2 with the error `TF401041: The Git protocol sent is not as expected`.

[git-v2-azuredevops-proxy](https://github.com/Dominik-esb/git-v2-azuredevops-proxy) solves this problem. The proxy keeps a copy of all branches of the Azure repository. The proxy serves this copy to Grafana with Git protocol v2. The proxy also sends the commits from Grafana to Azure DevOps.

These steps install the proxy in the same Kubernetes cluster as Grafana. Grafana then connects to the proxy through the proxy's cluster-internal address.

1. Create an Azure DevOps personal access token (PAT) with the scope **Code > Read & write**. The proxy needs read access to copy the repository. The proxy needs write access to push the commits that Grafana makes.

2. Put the PAT in a Kubernetes Secret:

   ```sh
   kubectl -n grafana create secret generic azure-devops-pat --from-literal=AZURE_PAT='<your PAT>'
   ```

3. Install the proxy with its [Helm chart](https://artifacthub.io/packages/helm/git-v2-azuredevops-proxy/git-v2-azuredevops-proxy). These values turn off proxy authentication. The network policy lets only Grafana pods connect to the proxy, so the proxy does not need its own token:

   ```yaml
   # git-proxy-values.yaml
   repos:
     - https://dev.azure.com/contoso/Monitoring/_git/dashboards
   upstream:
     auth: pat
     pat:
       existingSecret: azure-devops-pat   # the Secret has the key AZURE_PAT
   proxyAuth: none
   networkPolicy:
     enabled: true   # by default, admits only pods with the label app.kubernetes.io/name: grafana
   ```

   ```sh
   helm install git-proxy oci://ghcr.io/dominik-esb/charts/git-v2-azuredevops-proxy \
     --version 2.2.0 -n grafana -f git-proxy-values.yaml --wait
   ```

   The network policy works only if the cluster network plugin (CNI) enforces NetworkPolicies, for example Cilium or Calico.

4. Let Grafana connect to the proxy. By default, Git Sync rejects private addresses such as `*.svc.cluster.local`, and Git Sync rejects `http://` URLs. Add these settings to `grafana.ini`:

   ```ini
   [provisioning]
   allowed_git_urls = git-proxy-git-v2-azuredevops-proxy.grafana.svc.cluster.local
   allow_insecure = true
   ```

   With `allow_insecure`, Git traffic between Grafana and the proxy is not encrypted. Use a CNI that encrypts traffic between pods, for example Cilium or Calico with WireGuard. As an alternative, give the proxy a certificate from your own certificate authority with the chart's `tls.existingSecret` value, and keep `allow_insecure` off.

5. Create the Git Sync repository in Grafana. The proxy URL ends with the name of the Azure repository and `.git`. Grafana needs a token for the Pure Git type, but the proxy ignores the token:

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
       url: http://git-proxy-git-v2-azuredevops-proxy.grafana.svc.cluster.local/dashboards.git
       branch: main
       path: grafana/
       tokenUser: git   # Grafana needs a value. The proxy ignores the value.
     sync:
       enabled: true
       target: folder
       intervalSeconds: 60
     workflows: [write, branch]
   secure:
     token:
       create: unused   # Grafana needs a value. The proxy ignores the value.
   ```

   Send the manifest to Grafana with one of these tools:

   - The Grafana UI: open **Administration > Provisioning** and enter the same values.
   - [gcx](https://github.com/grafana/gcx), the Grafana CLI: `gcx resources push --path grafana/repositories`.
   - The Grafana API: send a `POST` request to `/apis/provisioning.grafana.app/v0alpha1/namespaces/default/repositories`.
   - Crossplane with [provider-grafana](https://marketplace.upbound.io/providers/grafana/provider-grafana): use a `RepositoryV0Alpha1` resource.

The task does not connect to the proxy. The task needs only the mapping from the folder (`grafana`) to the Grafana repository name (`dashboards`). See [Usage](#usage).

The proxy gets new commits from Azure DevOps at an interval. The `syncInterval` chart value sets the interval in seconds. Git Sync also reads the proxy at an interval, set by `intervalSeconds`. Thus, a preview link can show "not found" for a short time after a push.

## Usage

Add a pipeline to the repository. Then add the pipeline as a **build validation** branch policy on the target branch. Azure Repos ignores the YAML `pr:` trigger, so the branch policy is necessary to run the pipeline on each pull request.

```yaml
trigger: none

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    fetchDepth: 2   # The task compares HEAD with HEAD^1, so HEAD^1 must exist.

  - task: GrafanaGitSyncPreview@1
    inputs:
      grafanaUrl: https://grafana.example.com
      organizations: |
        test=1
        production=3
      repositorySource: inline
      repositories: grafana=dashboards
```

The `repositories` input tells the task where Git Sync reads dashboards. Each line has the format `folder=repository-name`:

- The left side is the folder in this Git repository. The folder is the `path` of the Git Sync repository.
- The right side is the name of the Git Sync repository in Grafana. The name is the `metadata.name` of the `Repository` resource. The preview links need this name.

Use `.` for the root of the Git repository. Write one line for each Git Sync repository. When one folder is in another folder, the task uses the deepest folder that matches:

```yaml
      repositories: |
        dashboards/team-a=team-a-dashboards
        dashboards/team-b=team-b-dashboards
```

### Read the Repository manifests

If the Git repository contains the Git Sync `Repository` manifests, the task can read the folders and names from these manifests:

```yaml
  - task: GrafanaGitSyncPreview@1
    inputs:
      grafanaUrl: https://grafana.example.com
      repositorySource: file
      repositoriesFile: grafana/repositories/*.yaml
```

The task reads Grafana `provisioning.grafana.app` `Repository` manifests and Crossplane `RepositoryV0Alpha1` resources. The task gets the folder from `spec.git.path`, the name from `metadata.name` or `metadata.uid`, and the synced branch from `spec.git.branch`. Thus, the links always agree with the manifests that Grafana uses.

### Branch previews

Run the same pipeline manually, or on each push. In `auto` mode, a build that is not for a pull request lists all dashboards on the branch:

```yaml
trigger:
  branches:
    exclude: [main]

steps:
  - task: GrafanaGitSyncPreview@1
    inputs:
      grafanaUrl: https://grafana.example.com
      repositorySource: inline
      repositories: grafana=dashboards
```

The preview links work only when Git Sync can read the branch.

### Source branch checkout

By default, the task compares `HEAD` with `HEAD^1`. This default is correct when the pipeline checks out the pull request merge commit. Azure Pipelines checks out the merge commit by default. If you check out the source branch, compare with the target branch:

```yaml
  - checkout: self
    fetchDepth: 0
  - task: GrafanaGitSyncPreview@1
    inputs:
      grafanaUrl: https://grafana.example.com
      repositorySource: inline
      repositories: grafana=dashboards
      baseRevision: origin/$(System.PullRequest.TargetBranchName)
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `grafanaUrl` | (required) | The base URL of the Grafana instance that runs Git Sync. |
| `mode` | `auto` | `auto`, `pullRequest` or `branch`. See [Modes](#modes). |
| `organizations` | `1` | One Grafana organization on each line, as `orgId` or `label=orgId`. Each dashboard gets links for all organizations. |
| `repositorySource` | `file` | `inline` uses the `repositories` input. `file` reads the Repository manifests in `repositoriesFile`. |
| `repositories` | | Inline mappings, one on each line, as `folder=repository-name`. |
| `repositoriesFile` | | Paths or globs, one on each line, relative to `workingDirectory`. The task reads Grafana `provisioning.grafana.app` `Repository` manifests and Crossplane `RepositoryV0Alpha1` resources. One file can contain more than one YAML document. |
| `showCurrentLinks` | `true` | Show links to the live dashboard. |
| `showPreviewLinks` | `true` | Show links to the Git Sync preview. |
| `fileExtensions` | `.json,.yaml,.yml` | The file extensions of dashboard files, separated by commas. |
| `commentTitle` | `📊 **Grafana dashboard changes in this pull request**` | The Markdown heading of the comment. |
| `commentKey` | `grafana-dashboard-preview` | A hidden marker that identifies the comment to update. Give each task in a pipeline a different key, for example one key for each Grafana instance. |
| `threadStatus` | `closed` | The status of a new comment thread. A `closed` thread does not block a "resolve all comments" policy. |
| `commentWhenNoChanges` | `false` | Add a comment also when no dashboard changed. The task always updates an existing comment. |
| `publishSummary` | `true` | Attach the dashboard table to the summary page of the run. |
| `summaryTitle` | | The Markdown heading of the build summary in branch mode. The default title contains the branch name. |
| `failOnParseError` | `true` | Make the task fail when the task cannot read a changed dashboard. When `false`, the task succeeds with issues. |
| `baseRevision` | `HEAD^1` | The Git revision that the task compares `HEAD` with. Only for pull request mode. |
| `ref` | | The branch or tag to preview. The default is the pull request source branch, or the built branch. |
| `syncedBranch` | | The branch that Grafana syncs. In branch mode, a dashboard that is not on this branch gets no `current` link, because Grafana has no live copy. This input overrides the `branch` in each Repository manifest. The default is the `branch` in the manifest, then `main`. |
| `workingDirectory` | `$(Build.SourcesDirectory)` | The Git checkout that the task reads. |
| `accessToken` | `$(System.AccessToken)` | The token that the task uses to read and write pull request threads. In branch mode on Azure Repos, the task uses the token only to get the synced branch. |

## Output variables

| Variable | Description |
|---|---|
| `dashboardCount` | The number of changed dashboards in the comment. |
| `parseErrorCount` | The number of changed dashboard files that the task cannot read. |

To read the variables in a later step, give the task a `name`. For example, with `name: preview`, use `$(preview.dashboardCount)`.

## Troubleshooting

| Problem | Cause and correction |
|---|---|
| `Cannot find base revision 'HEAD^1'` | The checkout is too shallow. Set `fetchDepth: 2` or more. |
| `Azure DevOps did not accept the access token`, or `403` on `pullRequests/.../threads` | The build service does not have the **Contribute to pull requests** permission, or the job token has a too small scope. Examine *Project settings > Settings > Limit job authorization scope*. |
| The task is skipped | `mode` is `pullRequest`, but the build is not for a pull request. Use `auto`, or run the pipeline from a build validation policy. |
| No pull request comment, and a warning in the log | The repository is not an Azure Repos repository. The log and the build summary still show the links. |
| `No repository manifest matched` | `repositorySource` is `file`, but no file matches `repositoriesFile`. Correct the path, or use `repositorySource: inline` with `repositories`. |
| A preview link shows an error | Grafana cannot read the source branch yet. The proxy and Git Sync each read new commits at an interval. Wait for one minute and load the page again. |
| A preview shows `unable to read bytes as a resource` | The file is a classic dashboard JSON file. Grafana 13 Git Sync needs a dashboard resource. See the example in [What the task does in a pull request](#what-the-task-does-in-a-pull-request). |
| A preview shows `path contains invalid characters` | Git Sync rejects file paths with characters other than ASCII letters, digits and a small set of symbols. Accented letters are an example. Change the file name. Dashboard titles can contain all characters. |
| A changed file has no row | The file is not in a Git Sync folder, has a different extension, or is not a dashboard. |

## Contributing

Bug reports, feature requests and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and the tests.

## License

[MIT](LICENSE)
