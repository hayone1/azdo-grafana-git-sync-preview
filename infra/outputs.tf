output "client_id" {
  value = azuread_application.publisher.client_id
}

output "tenant_id" {
  value = data.azuread_client_config.current.tenant_id
}

output "service_principal_object_id" {
  value = azuread_service_principal.publisher.object_id
}
