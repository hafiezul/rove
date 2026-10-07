param(
    [Parameter(Mandatory)]
    [ValidateSet('Import', 'Sign', 'Verify')]
    [string]$Action,
    [string]$Path,
    [switch]$NoTimestamp
)

$ErrorActionPreference = 'Stop'

if ($Action -eq 'Import') {
    if (!$env:WIN_CSC_LINK -or !$env:WIN_CSC_KEY_PASSWORD) {
        throw 'Self-signed Windows builds require WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD.'
    }
    $pfxPath = Join-Path $env:RUNNER_TEMP 'rove-windows-signing.pfx'
    [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:WIN_CSC_LINK))
    $password = ConvertTo-SecureString $env:WIN_CSC_KEY_PASSWORD -AsPlainText -Force
    $certificates = @(Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation Cert:\CurrentUser\My -Password $password |
        Where-Object { $_.HasPrivateKey })
    if ($certificates.Count -ne 1) {
        throw 'WIN_CSC_LINK must contain exactly one code-signing identity with a private key.'
    }
    $certificate = $certificates[0]
    $codeSigningUsage = $certificate.Extensions |
        Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
        ForEach-Object { $_.EnhancedKeyUsages } |
        Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' }
    if (!$codeSigningUsage) { throw 'The Windows certificate must permit code signing.' }
    if ($certificate.Subject -ne $certificate.Issuer -or $certificate.NotAfter -le (Get-Date)) {
        throw 'Expected a valid self-signed Windows code-signing certificate.'
    }
    if ($certificate.Subject -match '[\r\n]') { throw 'Certificate subject must be a single line.' }
    $publicPath = Join-Path $env:RUNNER_TEMP 'rove-windows-signing.cer'
    Export-Certificate -Cert $certificate -FilePath $publicPath | Out-Null
    Write-Host 'Importing the public certificate into the runner machine root store.'
    # CurrentUser\Root opens a native trust dialog even with PowerShell confirmation disabled.
    Import-Certificate -FilePath $publicPath -CertStoreLocation Cert:\LocalMachine\Root -Confirm:$false | Out-Null
    Import-Certificate -FilePath $publicPath -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
    $env:WIN_CSC_LINK = $pfxPath
    $env:ROVE_WINDOWS_SIGNING_THUMBPRINT = $certificate.Thumbprint
    $env:ROVE_WINDOWS_SIGNING_PUBLISHER_NAME = $certificate.Subject
    $env:ROVE_WINDOWS_SIGNING_CERTIFICATE = $publicPath
    if ($env:GITHUB_ENV) {
        @(
            "WIN_CSC_LINK=$pfxPath"
            "ROVE_WINDOWS_SIGNING_THUMBPRINT=$($certificate.Thumbprint)"
            "ROVE_WINDOWS_SIGNING_PUBLISHER_NAME=$($certificate.Subject)"
            "ROVE_WINDOWS_SIGNING_CERTIFICATE=$publicPath"
        ) | Add-Content -LiteralPath $env:GITHUB_ENV -Encoding utf8
    }
    $fingerprint = (Get-FileHash -LiteralPath $publicPath -Algorithm SHA256).Hash
    Write-Host "Imported Windows signing certificate $($certificate.Thumbprint). SHA256 $fingerprint."
    if ($env:GITHUB_STEP_SUMMARY) {
        @(
            '### Self-signed Windows build'
            ''
            'This certificate is not publicly trusted. SmartScreen warnings can remain.'
            'Trust the public certificate only after checking its SHA256 fingerprint.'
            "SHA256: ``$fingerprint``"
        ) | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
    }
    return
}

if (!$Path -or !$env:ROVE_WINDOWS_SIGNING_THUMBPRINT) {
    throw 'Import the Windows signing identity before signing or verifying artifacts.'
}
$item = Get-Item -LiteralPath $Path
$files = if ($item.PSIsContainer) {
    @(Get-ChildItem -LiteralPath $Path -Recurse -File |
        Where-Object { $_.Extension -in @('.exe', '.dll', '.node') })
} else { @($item) }
if ($files.Count -eq 0) { throw "No Windows binaries found in $Path." }

if ($Action -eq 'Sign') {
    if (!$env:WIN_CSC_LINK -or !$env:WIN_CSC_KEY_PASSWORD) { throw 'Windows signing credentials are missing.' }
    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    $signTool = Get-ChildItem -LiteralPath $sdk -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object {
            foreach ($candidate in (@($arch, 'x64') | Select-Object -Unique)) {
                $binary = Join-Path $_.FullName "$candidate\signtool.exe"
                if (Test-Path -LiteralPath $binary) { $binary }
            }
        } | Select-Object -First 1
    if (!$signTool) { throw 'Windows SDK signtool.exe was not found.' }
    foreach ($file in $files) {
        $arguments = @('sign', '/fd', 'SHA256', '/f', $env:WIN_CSC_LINK, '/p', $env:WIN_CSC_KEY_PASSWORD)
        if (!$NoTimestamp) { $arguments += @('/tr', 'http://timestamp.digicert.com', '/td', 'SHA256') }
        & $signTool @arguments $file.FullName
        if ($LASTEXITCODE -ne 0) { throw "signtool failed for $($file.Name)." }
    }
}

foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $env:ROVE_WINDOWS_SIGNING_THUMBPRINT) {
        throw "Invalid Windows signature for $($file.Name): $($signature.Status)."
    }
    Write-Host "Verified Windows signature for $($file.Name)."
}
if ($item.PSIsContainer) {
    Copy-Item -LiteralPath $env:ROVE_WINDOWS_SIGNING_CERTIFICATE -Destination (Join-Path $Path 'rove-windows-signing.cer') -Force
}
