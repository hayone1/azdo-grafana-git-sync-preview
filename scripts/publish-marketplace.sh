#!/usr/bin/env bash
# Publishes a .vsix, waits for Marketplace validation, then shares it.
#   scripts/publish-marketplace.sh <file.vsix> <version> [organizations to share with...]
# Needs MARKETPLACE_TOKEN: a Microsoft Entra token for 499b84ac-1321-427f-aa17-267ca6975798, or a PAT
# with Marketplace (publish) scope.
set -euo pipefail
vsix=$1 version=$2; shift 2

auth=(--auth-type pat --token "$MARKETPLACE_TOKEN" --no-prompt)
manifest=$(unzip -p "$vsix" extension.vsixmanifest)
publisher=$(grep -oP '<Identity [^>]*Publisher="\K[^"]+' <<<"$manifest")
extension=$(grep -oP '<Identity [^>]*Id="\K[^"]+' <<<"$manifest")
id=(--publisher "$publisher" --extension-id "$extension")

npx tfx extension publish --vsix "$vsix" --no-wait-validation "${auth[@]}"

# tfx gives up waiting after a few minutes while the Marketplace keeps validating, so poll here.
for _ in $(seq 1 60); do
  status=$(npx tfx extension isvalid "${id[@]}" --version "$version" --json "${auth[@]}" | jq -r .status)
  echo "Validation of $extension $version: $status"
  case "$status" in
    success) break ;;
    pending) sleep 30 ;;
    *) exit 1 ;;
  esac
done
[ "$status" = success ] || { echo "Validation did not finish in 30 minutes"; exit 1; }

if [ $# -gt 0 ]; then npx tfx extension share "${id[@]}" --share-with "$@" "${auth[@]}"; fi
