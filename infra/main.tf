# Release and CI plumbing for this repository:
# - a Microsoft Entra app that GitHub Actions signs in as, through OIDC, to publish to the Marketplace
# - the GitHub environments and variables the workflows read
#
# Adding the service principal to the Marketplace publisher has no Terraform provider; see
# docs/PUBLISHING.md.

terraform {
  required_version = ">= 1.6"
  required_providers {
    azuread = { source = "hashicorp/azuread", version = "~> 3.0" }
    github  = { source = "integrations/github", version = "~> 6.0" }
  }
}

provider "azuread" {} # Uses the Azure CLI login.

provider "github" {
  owner = var.github_owner # Token from GITHUB_TOKEN, e.g. GITHUB_TOKEN=$(gh auth token).
}

data "azuread_client_config" "current" {}

resource "azuread_application" "publisher" {
  display_name = "marketplace-publisher-${var.github_repository}"
  owners       = [data.azuread_client_config.current.object_id]
}

resource "azuread_service_principal" "publisher" {
  client_id = azuread_application.publisher.client_id
  owners    = [data.azuread_client_config.current.object_id]
}

resource "azuread_application_federated_identity_credential" "marketplace" {
  application_id = azuread_application.publisher.id
  display_name   = "github-marketplace-env"
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:${var.github_owner}/${var.github_repository}:environment:marketplace"
  audiences      = ["api://AzureADTokenExchange"]
}

resource "github_repository_environment" "marketplace" {
  repository  = var.github_repository
  environment = "marketplace"
}

resource "github_actions_environment_variable" "marketplace" {
  for_each = {
    AZURE_CLIENT_ID    = azuread_application.publisher.client_id
    AZURE_TENANT_ID    = data.azuread_client_config.current.tenant_id
    ADO_SHARE_WITH     = join(" ", var.share_with)
    MARKETPLACE_PUBLIC = tostring(var.marketplace_public)
  }
  repository    = var.github_repository
  environment   = github_repository_environment.marketplace.environment
  variable_name = each.key
  value         = each.value
}

# End-to-end test environment, created only when e2e_azdo_url is set.
resource "github_repository_environment" "e2e" {
  count       = var.e2e_azdo_url == "" ? 0 : 1
  repository  = var.github_repository
  environment = "e2e"
}

resource "github_actions_environment_variable" "e2e" {
  for_each      = var.e2e_azdo_url == "" ? {} : { AZDO_URL = var.e2e_azdo_url, AZDO_PROJECT = var.e2e_azdo_project }
  repository    = var.github_repository
  environment   = github_repository_environment.e2e[0].environment
  variable_name = each.key
  value         = each.value
}

# The PAT stays out of Terraform state: set it with
#   gh secret set AZDO_PAT --env e2e --repo <owner>/<repo>
