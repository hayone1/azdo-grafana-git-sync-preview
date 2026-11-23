# Grafana Git Sync PR Preview

Grafana [Git Sync](https://grafana.com/docs/grafana/latest/observability-as-code/provision-resources/intro-git-sync/) comments preview links on GitHub pull requests. Azure Repos has no native integration, so reviewers there see raw dashboard JSON or YAML with no way to look at the result.

This task closes that gap. On every pull request build it posts one comment that lists each changed dashboard with:

- **current**: the live dashboard in Grafana,
- **preview**: Git Sync's render of the file on the source branch. Nothing is saved to Grafana.

The comment is updated in place on every push, so the pull request never collects duplicates. Dashboards that fail to parse are listed too, and fail the build by default.

Outside pull requests, **branch mode** lists every dashboard on the built branch in the run's build summary and log, so you can preview a branch without opening a pull request.

## Quick start

```yaml
trigger: none   # Run from a branch policy build validation on your target branch.

steps:
  - checkout: self
    fetchDepth: 2

  - task: GrafanaGitSyncPreview@1
    inputs:
      grafanaUrl: https://grafana.example.com
      organizations: |
        test=1
        production=3
      repositoriesFile: grafana/repositories/*.yaml
```

Grant the project build service **Contribute to pull requests** on the repository.

Grafana Git Sync cannot read Azure Repos directly, because Azure Repos does not speak Git protocol v2. The README shows how to connect them through [git-v2-azuredevops-proxy](https://github.com/Dominik-esb/git-v2-azuredevops-proxy).

Full input reference, examples and troubleshooting: [README on GitHub](https://github.com/hayone1/azdo-grafana-git-sync-preview#readme).
