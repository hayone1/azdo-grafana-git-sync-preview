variable "github_owner" {
  type    = string
  default = "hayone1"
}

variable "github_repository" {
  type    = string
  default = "azdo-grafana-git-sync-preview"
}

variable "share_with" {
  description = "Azure DevOps organizations to share the private extension with."
  type        = list(string)
  default     = ["hayone1"]
}

variable "marketplace_public" {
  description = "Publish the extension publicly. Needs a verified publisher."
  type        = bool
  default     = false
}

variable "e2e_azdo_url" {
  description = "Azure DevOps organization URL for the CI end-to-end test, e.g. https://dev.azure.com/<org>/. Empty skips the e2e environment."
  type        = string
  default     = ""
}

variable "e2e_azdo_project" {
  type    = string
  default = ""
}
