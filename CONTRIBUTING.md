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

[e2e/run.mjs](e2e/run.mjs) tests the task against a real Azure DevOps organization, a local Grafana and a real browser. You need Docker, Node.js 22 and an Azure DevOps project you can create repositories in. A free organization works.

1. Copy [.env.example](.env.example) to `.env` and fill in `AZDO_URL`, `AZDO_PAT` and `AZDO_PROJECT`. `.env` is git-ignored.
2. Install the browser once: `npx playwright install chromium`.
3. Start Grafana 13 and [git-v2-azuredevops-proxy](https://github.com/Dominik-esb/git-v2-azuredevops-proxy) from [e2e/docker-compose.yml](e2e/docker-compose.yml), then run the test:

   ```sh
   npm run e2e:up      # Grafana on http://localhost:3000, admin/admin
   npm run test:e2e
   npm run e2e:down
   ```

The PAT needs these scopes: Code (read and write), Pull request threads (read and write), Build (read and execute), Project and team (read), Identity (read), Security (manage), Extensions (read and manage) and Agent pools (read). Most of them are only for the pipeline checks below, which create a pipeline, a branch policy and permissions in the test project. The extension itself needs none of this. In a pipeline it uses the job token.

The test pushes a fixture to the `grafana-git-sync-e2e` repository, with dashboards in two Git Sync repositories (`grafana/` and `ops/`). It opens several pull requests and runs the built task as an agent would, from a shallow checkout of the merge commit with no stored credentials. It checks:

| Area | What is checked |
|---|---|
| Comment | Exact rows and links for added, modified, deleted and renamed dashboards, in YAML and JSON, in folders with spaces, with Unicode and `\|` in titles. Files outside Git Sync folders, and files that are not dashboards, are left out. |
| Updates | A second run edits the comment in place. A new push to the pull request updates the rows. |
| Inputs | Several organizations, a second comment key, inline mappings (deepest folder wins), link toggles, file extensions, `ref`, `baseRevision` with a source branch checkout, `threadStatus`, `commentWhenNoChanges`, `summaryTitle`, `publishSummary` and `syncedBranch`. |
| Errors | Unparseable dashboards fail the task, or succeed with issues, and are listed in the comment. A bad or missing token, a missing manifest and a too-shallow checkout fail with a clear message. A build of a repository outside Azure Repos warns instead of commenting. No token is printed. |
| Scale | A pull request with 400 dashboards. Set `E2E_BULK_COUNT` to change it. |
| Branch mode | Every dashboard on the branch, and no `current` link for dashboards the synced branch lacks. |
| Grafana | Grafana syncs both repositories through the proxy. Every link in the comment opens in Chromium and shows the expected dashboard: the live version for `current`, the branch version for `preview`. The preview's **View pull request** button opens the pull request. |
| Output variables | `dashboardCount` and `parseErrorCount`. |

Remove the `GRAFANA_*` and `GIT_PROXY_URL` lines from `.env` to skip the Grafana and browser checks. Set `E2E_KEEP=1` to keep the pull requests and the Grafana repositories for a look. Each run first removes what an earlier crashed run left behind.

To also test an extension installed in your organization, set `E2E_PIPELINE_TASK`, for example `GrafanaGitSyncPreview@1`. The test then adds a build-validation pipeline on `main` that runs that task with the job token, on the hosted `ubuntu-latest` agent or the pool in `E2E_PIPELINE_POOL`. It checks that:

- the pull request run succeeds and comments,
- a new push reruns it and updates the same comment,
- a pull request with broken dashboards fails the run,
- a manual run on a branch attaches the build summary.

The release workflow uses this to test each build as a private canary extension before it is released, and the published extension after. See [docs/PUBLISHING.md](docs/PUBLISHING.md#5-release).

The local stack sets `GF_PROVISIONING_ALLOW_INSECURE` and `GF_PROVISIONING_ALLOWED_GIT_URLS` so Grafana accepts the proxy over plain http on a private host. Do not use those settings in production; expose the proxy over HTTPS as described in [Connect Grafana to Azure Repos](README.md#connect-grafana-to-azure-repos).

CI runs the same test on pushes to this repository (not forks). It needs an `e2e` environment with the `AZDO_URL` and `AZDO_PROJECT` variables and the `AZDO_PAT` secret.

## Project layout

| Path | Contents |
|---|---|
| [tasks/GrafanaGitSyncPreview/](tasks/GrafanaGitSyncPreview) | The pipeline task: `task.json` and the TypeScript source in `src/`. |
| [test/](test) | Unit tests, run by `npm test`. |
| [e2e/](e2e) | End-to-end test: scenarios in `run.mjs`, helpers in `lib.mjs`, `pipeline.mjs` and `browser.mjs`, and the local Grafana and proxy stack. |
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
