# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting issues

Use the [issue templates](https://github.com/hayone1/azdo-grafana-git-sync-preview/issues/new/choose). Include the task version, the Grafana version and the relevant part of the pipeline log. Remove tokens, internal hostnames and other secrets before posting.

Report security problems privately through [GitHub security advisories](https://github.com/hayone1/azdo-grafana-git-sync-preview/security/advisories/new), not in a public issue.

## Development setup

Requires Node.js 20 or later.

```sh
npm install        # also installs the task's dependencies
npm test           # builds the task and runs unit tests
npm run package    # builds a .vsix into out/
npm run test:e2e   # end-to-end test, see below
```

## End-to-end test

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

To also test an extension installed in your organization, set `E2E_PIPELINE_TASK`, for example `GrafanaGitSyncPreview@0`. The test then adds a build-validation pipeline that runs that task on the test pull request, using the hosted `ubuntu-latest` agent or the pool in `E2E_PIPELINE_POOL`, and checks that the run succeeds and posts its comment. The release workflow uses this to test each build as a private canary extension before releasing it. See [docs/PUBLISHING.md](docs/PUBLISHING.md#5-release).

The local stack sets `GF_PROVISIONING_ALLOW_INSECURE` and `GF_PROVISIONING_ALLOWED_GIT_URLS` so Grafana accepts the proxy over plain http on a private host. Do not use those settings in production; expose the proxy over HTTPS as described in [Connect Grafana to Azure Repos](README.md#connect-grafana-to-azure-repos).

CI runs the same test on pushes to this repository (not forks). It needs an `e2e` environment with the `AZDO_URL` and `AZDO_PROJECT` variables and the `AZDO_PAT` secret.

## Project layout

| Path | Contents |
|---|---|
| [tasks/GrafanaGitSyncPreview/](tasks/GrafanaGitSyncPreview) | The pipeline task: `task.json` and the TypeScript source in `src/`. |
| [test/](test) | Unit tests, run by `npm test`. |
| [e2e/](e2e) | End-to-end test and the local Grafana and proxy stack. |
| [scripts/](scripts) | Packaging, versioning, publishing and icon rendering. |
| [infra/](infra) | Terraform for the release identity and GitHub environments. Maintainers only. |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | Release process. Maintainers only. |

## Pull requests

1. Open an issue first for anything bigger than a small fix, so the approach can be agreed before you write it.
2. Keep each pull request to one change. Add or update unit tests in [test/task.test.mjs](test/task.test.mjs) for behavior changes.
3. Run `npm test`. Run `npm run test:e2e` too when you change how the task reads git, parses files or talks to Azure DevOps.
4. Update [README.md](README.md) when you add or change an input, and keep `task.json` help text in step.
5. Do not change version numbers. Maintainers set them when they tag a release.

CI runs the unit tests and packaging on every pull request. The end-to-end job needs repository secrets, so it only runs on pushes to this repository, not on forks.

## Releases

Maintainers release by pushing a `vX.Y.Z` tag. Each build is published as a private canary extension and run in a real Azure Pipelines pull request build before it is promoted. See [docs/PUBLISHING.md](docs/PUBLISHING.md).
