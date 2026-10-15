# Publishing

This guide covers the one-time setup and the release flow. Releases are published from GitHub Actions when you push a version tag.

The extension starts **private**: only the Azure DevOps organizations you share it with can install it. Making it public later is one variable change, after the publisher is verified.

Publishing uses a Microsoft Entra service principal that signs in through GitHub's OIDC token. No PAT and no stored secret are involved. Global PATs, which `tfx` used to need, are retired on December 1, 2026.

## 1. Marketplace publisher

The publisher is `hayone1` (<https://marketplace.visualstudio.com/manage/publishers/hayone1>). It is set as `publisher` in [vss-extension.json](../vss-extension.json). The ID is permanent.

Optional: add a second owner in *Manage publisher > Members*, so publishing never depends on one account.

## 2. Create the service principal

You need a Microsoft Entra tenant. If you sign in to Azure DevOps with a personal Microsoft account, use the tenant your Azure DevOps organization is connected to, or the default directory that comes with an Azure account.

1. In the [Azure portal](https://portal.azure.com), open *Microsoft Entra ID > App registrations > New registration*. Name it `marketplace-publisher-azdo-grafana-git-sync-preview`, single tenant, no redirect URI.
2. Note the **Application (client) ID** and the **Directory (tenant) ID**.
3. Open *Certificates & secrets > Federated credentials > Add credential*:
   - **Scenario**: GitHub Actions deploying Azure resources
   - **Organization**: `hayone1`, **Repository**: `azdo-grafana-git-sync-preview`
   - **Entity type**: Environment, **Environment name**: `marketplace`
4. Find the service principal's Azure DevOps profile ID. Sign in as the service principal once, from a machine with the Azure CLI. A short-lived client secret is the simplest way; delete it afterwards:

   ```sh
   az login --service-principal --username <client-id> --password <temporary-secret> --tenant <tenant-id> --allow-no-subscriptions
   az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798
   ```

   The `id` in the response is the profile ID.

5. In the [publisher management page](https://marketplace.visualstudio.com/manage/publishers/hayone1), open *Members > Add*, paste the profile ID and give it the **Contributor** role.
6. Delete the temporary client secret from the app registration.

## 3. Create the GitHub repository

1. Create a **private** repository `hayone1/azdo-grafana-git-sync-preview`. Do not add a README or license, since they exist here.
2. Push this folder:

   ```sh
   git remote add origin https://github.com/hayone1/azdo-grafana-git-sync-preview.git
   git push -u origin main
   ```

3. If the owner or repository name differs, update the URLs in [vss-extension.json](../vss-extension.json), [task.json](../tasks/GrafanaGitSyncPreview/task.json), [overview.md](../overview.md) and the [README](../README.md), and the federated credential.

## 4. Configure GitHub Actions

In the repository, open *Settings > Environments > New environment* and create `marketplace`. Add required reviewers if you want a manual approval before each publish.

In that environment, add these **variables**. None of them is secret:

| Name | Value |
|---|---|
| `AZURE_CLIENT_ID` | Application (client) ID from step 2. |
| `AZURE_TENANT_ID` | Directory (tenant) ID from step 2. |
| `ADO_SHARE_WITH` | Space-separated Azure DevOps organization names to share the private extension with, for example `hayone1`. |
| `MARKETPLACE_PUBLIC` | `false` for now. |

## 5. Release

Versions come from the tag. The release workflow writes them into `vss-extension.json`, both `package.json` files and `task.json` before packaging.

```sh
git tag v1.0.0
git push origin v1.0.0
```

The workflow then:

1. Runs the tests.
2. Builds the `.vsix`.
3. Signs in as the service principal and gets an Entra token for Azure DevOps.
4. Publishes the `.vsix` to the Marketplace and shares it with `ADO_SHARE_WITH`.
5. Creates a GitHub release with the `.vsix` attached.

Every release needs a higher version than the last one. Azure Pipelines picks up a new minor or patch automatically for `GrafanaGitSyncPreview@1`. A breaking change needs a new major version, which pipelines must opt in to with `@2`.

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
