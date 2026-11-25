# Contributing

Thank you for your help. We welcome bug reports, ideas and pull requests.

## Report a problem

Use the [issue templates](https://github.com/hayone1/azdo-grafana-git-sync-preview/issues/new/choose). Include the task version, the Grafana version and the related part of the pipeline log. Before you send the log, remove tokens, internal host names and other secrets.

Report security problems privately through [GitHub security advisories](https://github.com/hayone1/azdo-grafana-git-sync-preview/security/advisories/new). Do not report a security problem in a public issue, because everybody can read public issues.

## Development setup

You need Node.js 20 or later.

```sh
npm install        # installs the dependencies of the project and of the task
npm test           # builds the task and runs the unit tests
npm run package    # builds a .vsix file into out/
npm run test:e2e   # runs the end-to-end test, see below
```

## End-to-end test

The end-to-end test in [e2e/run.mjs](e2e/run.mjs) tests the task with a real Azure DevOps organization, a local Grafana and a real browser. You need Docker, Node.js 22 and an Azure DevOps project. You must have permission to create repositories in the project. A free organization is sufficient.

1. Copy [.env.example](.env.example) to `.env`. Git ignores `.env`, so your secrets stay on your computer.
2. Set `AZDO_URL`, `AZDO_PAT` and `AZDO_PROJECT` in `.env`.
3. Install the browser one time: `npx playwright install chromium`.
4. Start Grafana 13 and [git-v2-azuredevops-proxy](https://github.com/Dominik-esb/git-v2-azuredevops-proxy) from [e2e/docker-compose.yml](e2e/docker-compose.yml). Then run the test, and stop the stack:

   ```sh
   npm run e2e:up      # Grafana on http://localhost:3000, admin/admin
   npm run test:e2e
   npm run e2e:down
   ```

The personal access token (PAT) in `AZDO_PAT` needs these scopes:

- Code (read and write)
- Pull request threads (read and write)
- Build (read and execute)
- Project and team (read)
- Identity (read)
- Security (manage)
- Extensions (read and manage)
- Agent pools (read)

The pipeline checks need most of these scopes, because the pipeline checks create a pipeline, a branch policy and permissions in the test project. The extension does not need these scopes. In a pipeline, the extension uses the job token.

The test pushes a fixture to the `grafana-git-sync-e2e` repository. The fixture has dashboards in two Git Sync repositories, `grafana/` and `ops/`. The test opens pull requests. Then the test runs the built task in the same way as an agent: from a shallow checkout of the merge commit, with no stored credentials. The test checks these areas:

| Area | What the test checks |
|---|---|
| Comment | The exact rows and links for added, modified, deleted and renamed dashboards. The dashboards are in YAML and JSON, in folders with spaces, with Unicode and `\|` in titles. The comment does not contain files outside Git Sync folders, or files that are not dashboards. |
| Updates | A second run changes the existing comment. A new push to the pull request updates the rows. |
| Inputs | More than one organization, a second comment key, inline mappings (the deepest folder wins), link settings, file extensions, `ref`, `baseRevision` with a source branch checkout, `threadStatus`, `commentWhenNoChanges`, `summaryTitle`, `publishSummary` and `syncedBranch`. |
| Errors | A dashboard that the task cannot read makes the task fail, or succeed with issues. The comment lists the dashboard. A bad or missing token, a missing manifest and a too shallow checkout make the task fail with a clear message. A build of a repository outside Azure Repos gives a warning and no comment. The log contains no token. |
| Scale | A pull request with 400 dashboards. Set `E2E_BULK_COUNT` to change the number. |
| Branch mode | All dashboards on the branch. No `current` link for a dashboard that is not on the synced branch. |
| Grafana | Grafana syncs both repositories through the proxy. Chromium opens each link in the comment, and the link shows the correct dashboard. A `current` link shows the live version. A `preview` link shows the version on the branch. The **View pull request** button on the preview opens the pull request. |
| Output variables | `dashboardCount` and `parseErrorCount`. |

To skip the Grafana and browser checks, remove the `GRAFANA_*` and `GIT_PROXY_URL` lines from `.env`. To keep the pull requests and the Grafana repositories after the test, set `E2E_KEEP=1`. At the start, each run removes the items that an earlier failed run did not remove.

You can also test an extension that is installed in your organization. Set `E2E_PIPELINE_TASK` to the task, for example `GrafanaGitSyncPreview@1`. The test then adds a build validation pipeline on `main` that runs this task with the job token. The pipeline runs on the hosted `ubuntu-latest` agent, or on the pool in `E2E_PIPELINE_POOL`. The test checks these results:

- The pull request run succeeds and adds the comment.
- A new push runs the pipeline again and updates the same comment.
- A pull request with broken dashboards makes the run fail.
- A manual run on a branch attaches the build summary.

The release workflow uses this test on each build. The workflow tests the build as a private canary extension before the release, and tests the published extension after the release. See [docs/PUBLISHING.md](docs/PUBLISHING.md#5-release).

The local stack sets `GF_PROVISIONING_ALLOW_INSECURE` and `GF_PROVISIONING_ALLOWED_GIT_URLS`. With these settings, Grafana accepts the proxy over plain `http://` on a private host. With `allow_insecure`, the Git traffic between Grafana and the proxy is not encrypted. Before you use these settings outside a test, read [Connect Grafana to Azure Repos](README.md#connect-grafana-to-azure-repos).

Continuous integration (CI) runs the same test on pushes to this repository. CI does not run the test for forks. The test needs an `e2e` environment with the `AZDO_URL` and `AZDO_PROJECT` variables and the `AZDO_PAT` secret.

## Project layout

| Path | Contents |
|---|---|
| [tasks/GrafanaGitSyncPreview/](tasks/GrafanaGitSyncPreview) | The pipeline task: `task.json`, and the TypeScript source in `src/`. |
| [test/](test) | The unit tests. `npm test` runs these tests. |
| [e2e/](e2e) | The end-to-end test. The scenarios are in `run.mjs`. The helpers are in `lib.mjs`, `pipeline.mjs` and `browser.mjs`. The folder also has the local Grafana and proxy stack. |
| [scripts/](scripts) | The scripts for packages, versions, publication and the icon. |
| [infra/](infra) | The Terraform configuration for the release identity and the GitHub environments. Only for maintainers. |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | The release process. Only for maintainers. |

## Pull requests

1. For a change that is larger than a small correction, open an issue first. Then we can agree on the approach before you write the code.
2. Put only one change in each pull request. For a change in behavior, add or update unit tests in [test/task.test.mjs](test/task.test.mjs).
3. Run `npm test`. When you change how the task reads Git, reads files or calls Azure DevOps, also run `npm run test:e2e`.
4. When you add or change an input, update [README.md](README.md). Also make the help text in `task.json` agree with the README.
5. Do not change version numbers. Maintainers set the version numbers when they tag a release.

CI runs the unit tests and builds the package on each pull request. The end-to-end job needs repository secrets. Thus, the end-to-end job runs only on pushes to this repository, not on forks.

## Releases

Maintainers release a version when they push a `vX.Y.Z` tag. The release workflow publishes each build as a private canary extension first. Then the workflow runs the canary extension in a real Azure Pipelines pull request build. Only after this test does the workflow publish the release. See [docs/PUBLISHING.md](docs/PUBLISHING.md).
