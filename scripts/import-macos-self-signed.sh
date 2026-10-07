#!/usr/bin/env bash
set -euo pipefail

: "${CSC_LINK:?CSC_LINK must contain the Base64-encoded signing identity}"
: "${CSC_KEY_PASSWORD:?CSC_KEY_PASSWORD must contain the export password}"
: "${CSC_NAME:?CSC_NAME must select the signing identity}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"

if [[ "$CSC_NAME" == *$'\n'* || "$CSC_NAME" == *$'\r'* || "$CSC_NAME" == *'"'* ]]; then
  echo "CSC_NAME must be a single certificate name without quotes." >&2
  exit 1
fi

signing_dir="$(mktemp -d "$RUNNER_TEMP/rove-self-signed.XXXXXX")"
keychain="$signing_dir/signing.keychain-db"
identity_file="$signing_dir/identity.p12"
certificate="$signing_dir/certificate.pem"
trap 'rm -f "$identity_file" "$certificate"' EXIT
umask 077

keychain_password="$(openssl rand -hex 16)"
echo "::add-mask::$keychain_password"
printf '%s' "$CSC_LINK" | base64 --decode > "$identity_file"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$identity_file" -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
security find-certificate -a -c "$CSC_NAME" -p "$keychain" > "$certificate"
if [[ "$(grep -c 'BEGIN CERTIFICATE' "$certificate")" != "1" ]]; then
  echo "CSC_NAME must match exactly one certificate in the signing identity." >&2
  exit 1
fi

sudo security add-trusted-cert -d -r trustRoot -p codeSign -k "$keychain" "$certificate"
fingerprint="$(openssl x509 -in "$certificate" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':' | tr '[:lower:]' '[:upper:]')"
if [[ ! "$fingerprint" =~ ^[0-9A-F]{40}$ ]]; then
  echo "Could not read the signing certificate fingerprint." >&2
  exit 1
fi
security find-identity -v -p codesigning "$keychain" | grep -F "$fingerprint \"$CSC_NAME\"" >/dev/null
keychains=("$keychain")
while read -r existing_keychain; do
  keychains+=("${existing_keychain//\"/}")
done < <(security list-keychains -d user)
security list-keychains -d user -s "${keychains[@]}"

{
  printf 'CSC_KEYCHAIN=%s\n' "$keychain"
  printf 'CSC_NAME=%s\n' "$CSC_NAME"
  printf 'ROVE_MACOS_SIGNING_CERT_SHA1=%s\n' "$fingerprint"
  printf 'ROVE_CLI_MAC_SIGN_IDENTITY=%s\n' "$fingerprint"
} >> "$GITHUB_ENV"
echo "Self-signed macOS identity imported and validated."
