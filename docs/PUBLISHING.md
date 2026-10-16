# Publishing

This guide covers the one-time setup and the release flow. Releases are published from GitHub Actions when you push a version tag.

The extension starts **private**: only the Azure DevOps organizations you share it with can install it. Making it public later is one variable change, after the publisher is verified.

Publishing uses a Microsoft Entra service principal that signs in through GitHub's OIDC token. No PAT and no stored secret are involved. Global PATs, which `tfx` used to need, are retired on December 1, 2026.

## 1. Marketplace publisher

The publisher is `hayone1` (<https://marketplace.visualstudio.com/manage/publishers/hayone1>). It is set as `publisher` in [vss-extension.json](../vss-extension.json). The ID is permanent.

Optional: add a second owner in *Manage publisher > Members*, so publishing never depends on one account.

## 2. Provision the service principal and GitHub settings

[infra/](../infra) is a Terraform configuration that creates and tracks everything except the Marketplace membership:

- a Microsoft Entra app registration and service principal, `marketplace-publisher-azdo-grafana-git-sync-preview`
- a federated credential that trusts GitHub Actions in this repository's `marketplace` environment, so no secret is stored anywhere
- the GitHub `marketplace` environment with the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `ADO_SHARE_WITH` and `MARKETPLACE_PUBLIC` variables
- the GitHub `e2e` environment with `AZDO_URL` and `AZDO_PROJECT`, when `e2e_azdo_url` is set in [terraform.tfvars](../infra/terraform.tfvars)

The GitHub repository must exist first. Sign in with `az login` and `gh auth login`, then:

```sh
cd infra
export GITHUB_TOKEN=$(gh auth token)
terraform init
terraform apply
```

State is local and git-ignored. Keep `terraform.tfstate` somewhere safe, or add a remote backend.

The e2e PAT is kept out of Terraform state. Set it with:

```sh
gh secret set AZDO_PAT --env e2e --repo hayone1/azdo-grafana-git-sync-preview
```

## 3. Add the service principal to the publisher

There is no API or provider for publisher membership, so this step is manual, once.

1. Find the service principal's Azure DevOps profile ID. Sign in as the service principal with a short-lived secret, in a separate Azure CLI config so your own login is untouched:

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

2. In the [publisher management page](https://marketplace.visualstudio.com/manage/publishers/hayone1), open *Members > Add*, paste the profile ID and choose **Contributor**.

## 4. GitHub repository

The repository is `hayone1/azdo-grafana-git-sync-preview`. If the owner or name changes, update the URLs in [vss-extension.json](../vss-extension.json), [task.json](../tasks/GrafanaGitSyncPreview/task.json), [overview.md](../overview.md) and the [README](../README.md), and the variables in [infra/variables.tf](../infra/variables.tf), then apply again.

## 5. Release

Versions come from the tag. The release workflow writes them into `vss-extension.json`, both `package.json` files and `task.json` before packaging.

```sh
git tag v0.1.0
git push origin v0.1.0
```

Every build is tested as an installed extension before it is released:

1. **build**: runs the unit tests and packages two `.vsix` files from one build: the release extension and a private **dev** extension. The dev extension has its own extension id (`grafana-git-sync-preview-dev`), task id and task name (`GrafanaGitSyncPreviewDev`), so both can be installed in the same organization. See [scripts/package.mjs](../scripts/package.mjs).
2. **publish-dev**: signs in as the service principal and publishes the dev extension, waits for Marketplace validation, and shares it with `ADO_SHARE_WITH`.
3. **test-dev**: installs that dev version in the test organization, starts the local Grafana stack, and runs the end-to-end test with `E2E_PIPELINE_TASK=GrafanaGitSyncPreviewDev@<major>`. Besides the usual checks, the test makes the `grafana-git-sync-e2e-preview` pipeline a build-validation policy on the test repository, and asserts that the real pipeline run on the pull request succeeds and posts its comment.
4. **publish**: promotes the same tested build: publishes the release extension, shares it, and creates a GitHub release with both `.vsix` files.

If any step fails, the release extension is not published.

If a version of an extension fails Marketplace validation, later uploads of that extension can be accepted by `tfx` and then silently dropped, and the workflow fails with "never appeared on the Marketplace". Check the extension on the publisher page. For the dev extension, remove it on the publisher page (*... > Remove*), which deletes it; `tfx extension unpublish` only hides it, and the next upload then fails with "The extension already exists". Then rerun the failed jobs. Tag a new patch version after fixing; the Marketplace never accepts the same version twice, for either extension.

Every release needs a higher version than the last one. Pipelines reference the task by major version, `GrafanaGitSyncPreview@0` for 0.x, and pick up new minors and patches automatically. A new major version needs pipelines to opt in, for example `@1`.

The pipeline test needs, in the test organization: one Azure Pipelines parallel job (free tier is enough), a PAT in the `e2e` environment with Code, Pull Request Threads, Build, Policy, Extensions and Security scopes, and permission to install extensions.

## 6. Install in Azure DevOps

1. An organization administrator opens *Organization settings > Extensions > Shared*.
2. Select **Grafana Git Sync PR Preview** and **Install**.
3. Add the task to a pipeline as shown in the [README](../README.md#usage).

## Test privately

Before the first tagged release, you can publish from your machine with your own Entra token. Your account must be a member of the publisher:

```sh
npm install
npm run package
az login --allow-no-subscriptions
npx tfx extension publish --vsix out/<file>.vsix --auth-type pat --share-with <your-org> \
  --token "$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)"
```

Or upload the `.vsix` in the [publisher management page](https://marketplace.visualstudio.com/manage/publishers/hayone1).

Bump the version between test uploads, or the Marketplace rejects the upload. `npm run version:set -- 1.0.1` updates all files at once.

## Going public

Public extensions need a **verified** publisher.

1. Make the GitHub repository public. Check the history for secrets and internal URLs first.
2. Publish at least one private version.
3. In the [publisher management page](https://marketplace.visualstudio.com/manage), open the publisher and request verification. Microsoft reviews the publisher details and the domain. This takes a few business days.
4. When verified, set the `MARKETPLACE_PUBLIC` variable to `true` and release a new version. The workflow publishes with `"public": true`.

Once public, an extension cannot be made private again. You can only unpublish it.
