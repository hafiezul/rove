$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) "rove-windows-signing-test-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $root | Out-Null
$signingScript = Join-Path $PSScriptRoot 'windows-self-signed.ps1'
$certificate = $null

function ExpectFailure([scriptblock]$Run, [string]$Message) {
    $failure = $null
    try { & $Run } catch { $failure = $_.Exception.Message }
    if (!$failure -or !$failure.Contains($Message)) {
        throw "Expected '$Message', received '$failure'."
    }
}

try {
    $env:RUNNER_TEMP = $root
    $env:GITHUB_ENV = Join-Path $root 'github-env'
    $env:GITHUB_STEP_SUMMARY = Join-Path $root 'summary'
    $env:WIN_CSC_LINK = ''
    $env:WIN_CSC_KEY_PASSWORD = ''
    ExpectFailure { & $signingScript -Action Import } 'require WIN_CSC_LINK'
    Write-Host 'Creating a temporary Windows signing identity.'
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Rove Signing Test $([Guid]::NewGuid())" `
        -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable -NotBefore (Get-Date).AddMinutes(-5) -NotAfter (Get-Date).AddDays(1)
    $password = [Guid]::NewGuid().ToString()
    $pfx = Join-Path $root 'fixture.pfx'
    Export-PfxCertificate -Cert $certificate -FilePath $pfx -Password (ConvertTo-SecureString $password -AsPlainText -Force) | Out-Null
    $env:WIN_CSC_LINK = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfx))
    $env:WIN_CSC_KEY_PASSWORD = $password
    & $signingScript -Action Import
    if (!(Test-Path -LiteralPath "Cert:\LocalMachine\Root\$($certificate.Thumbprint)")) {
        throw 'The runner machine root store must trust the signing certificate.'
    }
    $payload = Join-Path $root 'payload'
    New-Item -ItemType Directory -Path (Join-Path $payload 'resource-monitor') -Force | Out-Null
    $unsignedBytes = [IO.File]::ReadAllBytes("$env:SystemRoot\System32\where.exe")
    $unsignedBytes[0x50] = $unsignedBytes[0x50] -bxor 1
    foreach ($name in @('rove.exe', 'native.dll', 'native.node', 'resource-monitor\rove-resource-monitor.exe')) {
        [IO.File]::WriteAllBytes((Join-Path $payload $name), $unsignedBytes)
    }
    & $signingScript -Action Sign -Path $payload -NoTimestamp
    & $signingScript -Action Verify -Path $payload
    if (!(Test-Path -LiteralPath (Join-Path $payload 'rove-windows-signing.cer'))) {
        throw 'The public signing certificate was not packaged.'
    }
    $publicCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $payload 'rove-windows-signing.cer'))
    if ($publicCertificate.HasPrivateKey -or $publicCertificate.Thumbprint -ne $certificate.Thumbprint) {
        throw 'The published certificate must match the signer and contain no private key.'
    }
    $env:ROVE_WINDOWS_SIGNING_THUMBPRINT = '0' * 40
    ExpectFailure { & $signingScript -Action Verify -Path $payload } 'Invalid Windows signature'
    $env:ROVE_WINDOWS_SIGNING_THUMBPRINT = $certificate.Thumbprint
    $executable = Join-Path $payload 'rove.exe'
    $bytes = [IO.File]::ReadAllBytes($executable)
    $bytes[0x51] = $bytes[0x51] -bxor 1
    [IO.File]::WriteAllBytes($executable, $bytes)
    ExpectFailure { & $signingScript -Action Verify -Path $payload } 'Invalid Windows signature'
    Write-Host 'Windows self-signing passed. Signed payloads verify; changed payloads and wrong identities fail.'
} finally {
    if ($certificate) {
        foreach ($store in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\Root', 'Cert:\CurrentUser\TrustedPublisher')) {
            $path = "$store\$($certificate.Thumbprint)"
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
        }
    }
    Remove-Item -LiteralPath $root -Recurse -Force
}
