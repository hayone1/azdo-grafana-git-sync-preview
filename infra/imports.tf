# Resources created with the Azure CLI before this configuration existed.
# Safe to delete after the first apply.
import {
  to = azuread_application.publisher
  id = "/applications/c60bccc1-72cb-483b-922a-be53403af1c6"
}

import {
  to = azuread_service_principal.publisher
  id = "/servicePrincipals/d3dcd1b2-49cb-428e-b664-fba47eec911e"
}

import {
  to = azuread_application_federated_identity_credential.marketplace
  id = "c60bccc1-72cb-483b-922a-be53403af1c6/federatedIdentityCredential/8d99aebc-3f62-4cf4-b5f4-e2fc53c33c38"
}
