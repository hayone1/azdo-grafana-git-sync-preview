# Grafana Git Sync PR Preview

Grafana [Git Sync](https://grafana.com/docs/grafana/latest/observability-as-code/provision-resources/intro-git-sync/) keeps Grafana dashboards as files in a Git repository. On GitHub pull requests, Git Sync adds a comment with preview links. Azure Repos has no Git Sync integration. Thus, reviewers on Azure Repos see only raw dashboard JSON or YAML, and cannot see the dashboard.

This task adds the missing comment. In each pull request build, the task adds one comment. The comment lists each changed dashboard with two links:

- The **current** link opens the live dashboard in Grafana.
- The **preview** link opens the Git Sync preview of the file on the source branch. Grafana does not save the preview.

Each new push updates the same comment. Thus, the pull request has only one comment from the task. The comment also lists dashboards that the task cannot read. By default, these dashboards make the build fail.

Outside pull requests, the task uses **branch mode**. Branch mode lists all dashboards on the built branch in the build summary and the log. Use branch mode to preview a branch without a pull request.

## Quick start

```yaml
trigger: none   # Run the pipeline from a build validation policy on the target branch.

steps:
  - checkout: self
    fetchDepth: 2

  - task: GrafanaGitSyncPreview@1
    inputs:
      grafanaUrl: https://grafana.example.com
      organizations: |
        test=1
        production=3
      repositorySource: inline
      repositories: grafana=dashboards   # folder in this repository=Git Sync repository name in Grafana
```

Give the project build service the **Contribute to pull requests** permission on the repository. Without this permission, the task cannot add the comment.

Grafana Git Sync cannot read Azure Repos without help, because Azure Repos does not support Git protocol v2. The README shows how to connect Grafana to Azure Repos through [git-v2-azuredevops-proxy](https://github.com/Dominik-esb/git-v2-azuredevops-proxy).

The [README on GitHub](https://github.com/hayone1/azdo-grafana-git-sync-preview#readme) has all inputs, more examples and troubleshooting.
