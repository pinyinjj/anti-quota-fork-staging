[CmdletBinding()]
param([string]$PackageRoot)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $PackageRoot) { $PackageRoot = Split-Path -Parent $PSScriptRoot }
$packagePath = [IO.Path]::GetFullPath($PackageRoot)
$sourcePath = Join-Path $packagePath 'native\windows\AntiQuotaService.cs'
$outputPath = Join-Path $packagePath 'native\windows\AntiQuotaService.exe'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw 'The Windows service host source was not found.'
}
$compilerPath = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) {
    $compilerPath = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) {
    throw 'The .NET Framework 4 compiler is required to build the Windows service host.'
}

# Framework's C# 5 compiler has no deterministic-build option. Disable debug
# symbols, build once per release, and checksum the resulting release artifact.
$compilerArguments = @(
    '/nologo', '/noconfig', '/target:exe', '/platform:anycpu', '/optimize+',
    '/debug-', '/warn:4', '/warnaserror+', '/utf8output', '/codepage:65001',
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Xml.dll',
    '/reference:System.ServiceProcess.dll',
    '/reference:System.Runtime.Serialization.dll',
    ('/out:' + $outputPath), $sourcePath
)
& $compilerPath @compilerArguments
if ($LASTEXITCODE -ne 0) { throw 'The Windows service host did not compile.' }
if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw 'The service host output is missing.' }
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
$outputStream = [IO.File]::OpenRead($outputPath)
try { $outputHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash($outputStream))).Replace('-', '').ToLowerInvariant() }
finally { $outputStream.Dispose(); $hashAlgorithm.Dispose() }
Write-Output ('Built native/windows/AntiQuotaService.exe SHA256=' + $outputHash)
