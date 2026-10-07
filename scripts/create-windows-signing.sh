#!/usr/bin/env bash
set -euo pipefail
umask 077

output="${1:?Pass an output directory for the Windows signing identity.}"
: "${ROVE_CERTIFICATE_PASSWORD:?Set ROVE_CERTIFICATE_PASSWORD to protect the signing identity.}"
mkdir -p "$output"
if [[ -e "$output/rove-windows-signing.pfx" || -e "$output/rove-windows-signing.cer" ]]; then
  echo "Refusing to replace an existing signing identity." >&2
  exit 1
fi
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
printf '%s\n' \
  '[req]' \
  'distinguished_name = subject' \
  'x509_extensions = signing' \
  'prompt = no' \
  '[subject]' \
  'CN = Rove Code Release Signing' \
  '[signing]' \
  'basicConstraints = critical,CA:false' \
  'keyUsage = critical,digitalSignature' \
  'extendedKeyUsage = codeSigning' > "$stage/certificate.cnf"
openssl req -x509 -newkey rsa:3072 -noenc -sha256 -days 3650 \
  -config "$stage/certificate.cnf" \
  -keyout "$stage/key.pem" -out "$stage/certificate.pem"
openssl pkcs12 -export -name 'Rove Code Release Signing' \
  -inkey "$stage/key.pem" -in "$stage/certificate.pem" \
  -passout env:ROVE_CERTIFICATE_PASSWORD \
  -out "$stage/rove-windows-signing.pfx"
openssl x509 -in "$stage/certificate.pem" -outform DER -out "$stage/rove-windows-signing.cer"
cp "$stage/rove-windows-signing.pfx" "$stage/rove-windows-signing.cer" "$output/"
openssl x509 -in "$stage/certificate.pem" -noout -fingerprint -sha256
printf 'Keep %s/rove-windows-signing.pfx and its password private. Reuse this identity for future releases.\n' "$output"
