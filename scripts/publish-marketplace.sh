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
  # Right after publishing, the new version can be missing for a moment. If it stays missing, the
  # Marketplace dropped the upload, for example because an earlier version of the extension failed
  # validation; see docs/PUBLISHING.md.
  status=$(npx tfx extension isvalid "${id[@]}" --version "$version" --json "${auth[@]}" 2>/dev/null | jq -r .status 2>/dev/null || true)
  if [ -z "$status" ]; then
    missing=$(( ${missing:-0} + 1 ))
    [ "$missing" -lt 10 ] || { echo "Version $version never appeared on the Marketplace"; exit 1; }
    status=pending
  fi
  echo "Validation of $extension $version: $status"
  case "$status" in
    success) break ;;
    pending) sleep 30 ;;
    *) exit 1 ;;
  esac
done
[ "$status" = success ] || { echo "Validation did not finish in 30 minutes"; exit 1; }

# A public extension is visible to every organization, and the Marketplace refuses to share one.
if grep -q "<GalleryFlags>[^<]*Public" <<<"$manifest"; then
  echo "$extension is public; not sharing."
elif [ $# -gt 0 ]; then
  npx tfx extension share "${id[@]}" --share-with "$@" "${auth[@]}"
fi
