#!/usr/bin/env bash
set -euo pipefail

: "${ROVE_MACOS_SIGNING_CERT_SHA1:?The expected signing certificate fingerprint is required}"
if [[ ! "$ROVE_MACOS_SIGNING_CERT_SHA1" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  echo "The signing certificate fingerprint must contain 40 hexadecimal characters." >&2
  exit 1
fi

app="${1:?Pass the signed app bundle path}"
codesign --verify --deep --strict --all-architectures \
  -R "anchor = H\"$ROVE_MACOS_SIGNING_CERT_SHA1\"" "$app"
requirement="$(codesign -d -r- "$app" 2>&1 | grep '^designated =>')"
if ! printf '%s\n' "$requirement" | grep -qiF "$ROVE_MACOS_SIGNING_CERT_SHA1"; then
  echo "The app's designated requirement does not pin the expected signing certificate." >&2
  exit 1
fi
if printf '%s\n' "$requirement" | grep -qiE '(^|[^[:alnum:]_])(trusted|cdhash)([^[:alnum:]_]|$)'; then
  echo "The app's designated requirement must not depend on installed certificate trust or a build-specific code hash." >&2
  exit 1
fi
printf '%s\n' "$requirement"
