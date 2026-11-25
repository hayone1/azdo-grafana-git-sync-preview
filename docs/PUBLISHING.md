# Publishing

This guide is for maintainers. The guide shows the one-time setup and the release process. GitHub Actions publishes a release when you push a version tag.

The extension starts as a **private** extension. Only the Azure DevOps organizations that you share the extension with can install a private extension. To make the extension public later, you change one variable. Before that, Microsoft must verify the publisher.

The release workflow publishes with a Microsoft Entra service principal. The service principal signs in with the OpenID Connect (OIDC) token of GitHub Actions. Thus, the workflow needs no personal access token (PAT) and no stored secret. This is important because Microsoft retires global PATs on December 1, 2026. The `tfx` tool needed a global PAT before.

## 1. Marketplace publisher

The publisher is `hayone1` (<https://marketplace.visualstudio.com/manage/publishers/hayone1>). The `publisher` field in [vss-extension.json](../vss-extension.json) contains this ID. You cannot change the publisher ID.

Optional: add a second owner in *Manage publisher > Members*. Then the publication does not depend on one account.

## 2. Create the service principal and the GitHub settings

The [infra/](../infra) folder contains a Terraform configuration. The configuration creates and tracks all items except the Marketplace membership:

- A Microsoft Entra app registration and service principal, `marketplace-publisher-azdo-grafana-git-sync-preview`.
- A federated credential that trusts GitHub Actions in the `marketplace` environment of this repository. Thus, no secret is stored.
- The GitHub `marketplace` environment with the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `ADO_SHARE_WITH` and `MARKETPLACE_PUBLIC` variables.
- The GitHub `e2e` environment with `AZDO_URL` and `AZDO_PROJECT`. Terraform creates this environment only when `e2e_azdo_url` is set in [terraform.tfvars](../infra/terraform.tfvars).

The GitHub repository must exist before you apply the configuration.

1. Sign in with `az login` and `gh auth login`.
2. Apply the configuration:

   ```sh
   cd infra
   export GITHUB_TOKEN=$(gh auth token)
   terraform init
   terraform apply
   ```

Terraform keeps the state in a local file. Git ignores the state file. Keep `terraform.tfstate` in a safe place, or add a remote backend. Without the state file, Terraform cannot change or delete the resources.

Terraform does not keep the e2e PAT, so the PAT is not in the state file. Set the PAT with this command:

```sh
gh secret set AZDO_PAT --env e2e --repo hayone1/azdo-grafana-git-sync-preview
```

## 3. Add the service principal to the publisher

No API or Terraform provider can add a member to a publisher. Thus, you do this step manually, one time.

1. Get the Azure DevOps profile ID of the service principal. To get the ID, sign in as the service principal with a secret that expires after one day. Use a separate Azure CLI configuration, so your own sign-in does not change:

   ```sh
   APP=$(terraform -chdir=infra output -raw client_id)
   TENANT=$(terraform -chdir=infra output -raw tenant_id)
   SECRET=$(az ad app credential reset --id $APP --append --display-name temp-profile --end-date $(date -u -d '+1 day' +%Y-%m-%d) --query password -o tsv)
   sleep 30
   AZURE_CONFIG_DIR=/tmp/az-sp az login --service-principal -u $APP -p $SECRET --tenant $TENANT --allow-no-subscriptions -o none
   AZURE_CONFIG_DIR=/tmp/az-sp az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id -o tsv
   rm -rf /tmp/az-sp
   for k in $(az ad app credential list --id $APP --query "[?displayName=='temp-profile'].keyId" -o tsv); do az ad app credential delete --id $APP --key-id $k; done
   ```

   The last command deletes the temporary secret.

2. Open the [publisher management page](https://marketplace.visualstudio.com/manage/publishers/hayone1). Open *Members > Add*, paste the profile ID and select **Contributor**.

## 4. GitHub repository

The repository is `hayone1/azdo-grafana-git-sync-preview`. If the owner or the name changes, do these steps:

1. Update the URLs in [vss-extension.json](../vss-extension.json), [task.json](../tasks/GrafanaGitSyncPreview/task.json), [overview.md](../overview.md) and the [README](../README.md).
2. Update the variables in [infra/variables.tf](../infra/variables.tf).
3. Apply the Terraform configuration again.

## 5. Release

The version comes from the tag. Before the release workflow builds the package, the workflow writes the version into `vss-extension.json`, both `package.json` files and `task.json`.

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow tests each build as an installed extension before the release. The workflow has these jobs:

1. **build**: Runs the unit tests. Then makes two `.vsix` files from one build: the release extension and a private **dev** extension. The dev extension has its own extension ID (`grafana-git-sync-preview-canary`), task ID and task name (`GrafanaGitSyncPreviewDev`). Thus, an organization can install both extensions at the same time. See [scripts/package.mjs](../scripts/package.mjs).
2. **publish-dev**: Signs in as the service principal and publishes the dev extension. Then waits for the Marketplace validation and shares the dev extension with `ADO_SHARE_WITH`.
3. **test-dev**: Installs the dev version in the test organization, starts the local Grafana stack and runs the end-to-end test with `E2E_PIPELINE_TASK=GrafanaGitSyncPreviewDev@<major>`. [CONTRIBUTING.md](../CONTRIBUTING.md#end-to-end-test) shows what the test checks. In this job, the test also makes the `grafana-git-sync-e2e-preview` pipeline a build validation policy on the test repository. Then the test makes sure that the real pipeline run on the pull request succeeds and adds its comment.
4. **publish**: Publishes the same tested build as the release extension, and shares the release extension. The job does not share a public extension, because all organizations can install a public extension.
5. **verify-release**: Installs the release extension from the Marketplace in the test organization. Then runs the same end-to-end test with `GrafanaGitSyncPreview@<major>`.
6. **github-release**: Creates a GitHub release with both `.vsix` files. This job runs only after **verify-release** passes.

If a job before **publish** fails, the workflow does not publish the release extension. If **verify-release** fails, the version is already on the Marketplace, but has no GitHub release. Correct the problem and tag a new patch version.

### When a version fails the Marketplace validation

After a version of an extension fails the Marketplace validation, `tfx` can accept later uploads of the same extension, and then the Marketplace drops these uploads without a message. The workflow then fails with "never appeared on the Marketplace". Do these steps:

1. Examine the extension on the publisher page.
2. For the dev extension, remove the extension on the publisher page (*... > Remove*). Removal deletes the extension. Do not use `tfx extension unpublish`, because unpublish only hides the extension, and the next upload then fails with "The extension already exists".
3. The Marketplace never lets you use a deleted extension ID again. Thus, change the dev ID suffix in [scripts/package.mjs](../scripts/package.mjs) and in the release workflow.
4. Tag a new patch version. The Marketplace never accepts the same version two times, for both extensions.

### Version rules

Each release needs a version that is higher than the last version. Pipelines refer to the task by its major version, for example `GrafanaGitSyncPreview@1` for 1.x. Thus, pipelines get new minor and patch versions automatically. For a new major version, each pipeline must change to the new version, for example `@2`. Put breaking changes to inputs only in a new major version.

### Requirements for the pipeline test

The test organization needs these items:

- One Azure Pipelines parallel job. The free tier is sufficient.
- A PAT in the `e2e` environment with the Code, Pull Request Threads, Build, Policy, Extensions and Security scopes.
- Permission to install extensions.

## 6. Install in Azure DevOps

1. An organization administrator opens *Organization settings > Extensions > Shared*.
2. The administrator selects **Grafana Git Sync PR Preview** and **Install**.
3. Add the task to a pipeline. The [README](../README.md#usage) shows an example.

## Test privately

Before the first tagged release, you can publish from your computer with your own Entra token. Your account must be a member of the publisher.

```sh
npm install
npm run package
az login --allow-no-subscriptions
npx tfx extension publish --vsix out/<file>.vsix --auth-type pat --share-with <your-org> \
  --token "$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)"
```

As an alternative, upload the `.vsix` file on the [publisher management page](https://marketplace.visualstudio.com/manage/publishers/hayone1).

Increase the version before each test upload, because the Marketplace rejects a version that it already has. The command `npm run version:set -- 1.0.1` updates the version in all files.

## Make the extension public

A public extension needs a **verified** publisher.

1. Make the GitHub repository public. Before you do this, examine the history for secrets and internal URLs.
2. Publish at least one private version.
3. Open the [publisher management page](https://marketplace.visualstudio.com/manage), open the publisher and request verification. Microsoft examines the publisher details and the domain. The verification takes a few business days.
4. After the verification, set the `MARKETPLACE_PUBLIC` variable to `true` and release a new version. The workflow then publishes with `"public": true`.

You cannot make a public extension private again. You can only unpublish the extension.
