[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Uninstall', 'Start', 'Stop', 'Status')]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [string]$UserSid,
    [string]$PackageRoot,
    [string]$NodePath,
    [switch]$KeepStopped
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$trustedSids = @(
    'S-1-5-18', 'S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)
$administratorSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$targetSid = [Security.Principal.SecurityIdentifier]::new($UserSid)
if ($targetSid.Value -ne $UserSid -or $UserSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') {
    throw 'A canonical Windows user SID is required.'
}
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try {
    $sidHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($UserSid)))).Replace('-', '').ToLowerInvariant().Substring(0, 12)
} finally { $hashAlgorithm.Dispose() }
$serviceName = 'AntiQuota-' + $sidHash
$programFilesPath = [Environment]::GetFolderPath('ProgramFiles')
if (-not [IO.Path]::IsPathRooted($programFilesPath)) { throw 'The system Program Files directory is unavailable.' }
$basePath = [IO.Path]::GetFullPath((Join-Path $programFilesPath 'Anti Quota'))
$installPath = Join-Path $basePath $sidHash
$configPath = Join-Path $installPath 'install.json'
$hostPath = Join-Path $installPath 'AntiQuotaService.exe'
$scPath = Join-Path $env:SystemRoot 'System32\sc.exe'

function Assert-NoReparseAncestors([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Service installation paths cannot contain reparse points.'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor.TrimEnd('\'))
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Get-SafeTree([string]$Path) {
    Assert-NoReparseAncestors $Path
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push([IO.Path]::GetFullPath($Path))
    while ($pending.Count -gt 0) {
        $entry = Get-Item -LiteralPath $pending.Pop() -Force
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Service files cannot contain symlinks, junctions, or other reparse points.'
        }
        $entry
        if ($entry.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $entry.FullName -Force) {
                $pending.Push($child.FullName)
            }
        }
    }
}

function Assert-Protected([string]$Path) {
    Assert-NoReparseAncestors $Path
    $acl = Get-Acl -LiteralPath $Path
    if ($trustedSids -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) {
        throw 'The service installation has an untrusted owner; reinstall it into a protected directory.'
    }
    $writeRights = [int64][Security.AccessControl.FileSystemRights]::Write -bor [int64][Security.AccessControl.FileSystemRights]::Delete -bor [int64][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [int64][Security.AccessControl.FileSystemRights]::ChangePermissions -bor [int64][Security.AccessControl.FileSystemRights]::TakeOwnership -bor 0x10000000 -bor 0x40000000
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
            ([int64]$rule.FileSystemRights -band $writeRights) -ne 0 -and $trustedSids -notcontains $rule.IdentityReference.Value) {
            throw 'The service installation permits an untrusted principal to modify its files.'
        }
    }
}

function Set-ProtectedDirectory([string]$Path, [Security.Principal.SecurityIdentifier]$ReadSid) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($administratorSid)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($administratorSid, $systemSid)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($ReadSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Protect-Tree([string]$Path) {
    Set-ProtectedDirectory $Path $targetSid
    foreach ($item in Get-SafeTree $Path) {
        if ($item.FullName -eq $Path) { continue }
        $acl = Get-Acl -LiteralPath $item.FullName
        $acl.SetOwner($administratorSid)
        $acl.SetAccessRuleProtection($false, $false)
        foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
            $acl.RemoveAccessRuleSpecific($rule)
        }
        Set-Acl -LiteralPath $item.FullName -AclObject $acl
    }
}

function Copy-SafeTree([string]$Source, [string]$Destination, [switch]$SkipNestedModules) {
    $sourceFull = [IO.Path]::GetFullPath($Source).TrimEnd('\')
    foreach ($item in Get-SafeTree $sourceFull) {
        $suffix = $item.FullName.Substring($sourceFull.Length).TrimStart('\')
        if ($SkipNestedModules -and $suffix -match '^node_modules(?:\\|$)') { continue }
        $target = if ($suffix) { Join-Path $Destination $suffix } else { $Destination }
        if ($item.PSIsContainer) { [void][IO.Directory]::CreateDirectory($target) }
        else {
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            [IO.File]::Copy($item.FullName, $target, $false)
        }
    }
}

function Remove-InstallationTree([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($full) -ne $basePath -or
        ([IO.Path]::GetFileName($full) -ne $sidHash -and [IO.Path]::GetFileName($full) -notmatch ('^\.(stage|backup)-' + $sidHash + '-[a-f0-9]{32}$'))) {
        throw 'Refusing to remove a path outside the exact service installation.'
    }
    if (-not (Test-Path -LiteralPath $full)) { return }
    $entries = @(Get-SafeTree $full)
    foreach ($entry in $entries | Sort-Object { $_.FullName.Length } -Descending) {
        Remove-Item -LiteralPath $entry.FullName -Force
    }
}

function Invoke-ServiceControl([string[]]$Arguments) {
    $output = & $scPath @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw ('Windows service control failed: ' + $output.Trim()) }
}

function Get-ManagedService {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service) {
        $registration = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $serviceName + "'")
        if (-not $registration -or $registration.PathName.Trim() -ne ('"' + $hostPath + '"') -or $registration.StartName -ne 'LocalSystem') {
            throw 'The existing service registration does not match the protected Anti Quota installation.'
        }
    }
    return $service
}

function Stop-ManagedService {
    $service = Get-ManagedService
    $hostProcess = $null
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($service -and $service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
            $registration = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $serviceName + "'")
            if (-not $registration -or $registration.ProcessId -le 0) { throw 'The service host PID is unavailable; installation was not changed.' }
            $hostProcess = [Diagnostics.Process]::GetProcessById([int]$registration.ProcessId)
            # Acquire a stable process handle before requesting stop. SCM's
            # Stopped status alone does not prove that the executable exited.
            [void]$hostProcess.Handle
            $confirmation = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $serviceName + "'")
            if (-not $confirmation -or $confirmation.ProcessId -ne $registration.ProcessId) { throw 'The service instance changed while preparing to stop.' }
            if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::StopPending) { $service.Stop() }
            $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(350))
            $service.Refresh()
            if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) { throw 'The service did not finish draining; its files were not changed.' }
            $remaining = [Math]::Max(0, 350000 - [int]$elapsed.ElapsedMilliseconds)
            if (-not $hostProcess.WaitForExit($remaining)) { throw 'The stopped service host has not exited; its files were not changed.' }
        }
    } finally {
        if ($hostProcess) { $hostProcess.Dispose() }
        if ($service) { $service.Dispose() }
        $elapsed.Stop()
    }
}

function Start-ManagedService {
    $service = Get-ManagedService
    if (-not $service) { throw 'The Windows service is not installed.' }
    try {
        if ($service.Status -eq [ServiceProcess.ServiceControllerStatus]::Running) {
            $service.ExecuteCommand(128)
        } else {
            if ($service.Status -eq [ServiceProcess.ServiceControllerStatus]::StopPending) {
                $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(350))
            }
            $service.Start()
            $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
        }
    } finally { $service.Dispose() }
}

function Read-InstallationConfig {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $null }
    Assert-Protected $installPath
    Assert-Protected $configPath
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.schemaVersion -ne 1 -or $config.serviceName -ne $serviceName -or $config.userSid -ne $UserSid -or $config.version -notmatch '^\d+\.\d+\.\d+$' -or $config.enabled -isnot [bool]) {
        throw 'The existing service configuration is invalid.'
    }
    return $config
}

Assert-NoReparseAncestors $installPath
Assert-Protected $programFilesPath
if ($Action -eq 'Install' -or $Action -eq 'Uninstall') {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Installing or uninstalling the Windows service requires administrator approval.'
    }
}
if (Test-Path -LiteralPath $basePath) { Assert-Protected $basePath }
$existingConfig = Read-InstallationConfig
$existingService = Get-ManagedService
if ($existingService -and -not $existingConfig) { throw 'The registered service has no valid installation configuration.' }

switch ($Action) {
    'Status' {
        [ordered]@{
            installed = [bool]$existingService
            serviceName = $serviceName
            userSid = $UserSid
            version = if ($existingConfig) { $existingConfig.version } else { $null }
            installRoot = $installPath
            status = if ($existingService) { $existingService.Status.ToString() } else { 'NotInstalled' }
            enabled = if ($existingConfig) { $existingConfig.enabled } else { $false }
        } | ConvertTo-Json -Compress
    }
    'Start' { Start-ManagedService }
    'Stop' { Stop-ManagedService }
    'Uninstall' {
        Stop-ManagedService
        if ($existingService) {
            $existingService.Dispose()
            $existingService = $null
            Invoke-ServiceControl @('delete', $serviceName)
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
                if ([DateTime]::UtcNow -ge $deadline) { throw 'The service is still pending deletion; installation files were retained.' }
                Start-Sleep -Milliseconds 200
            }
        }
        Remove-InstallationTree $installPath
        Write-Output 'Windows service uninstalled. User accounts were retained.'
    }
    'Install' {
        if (-not $PackageRoot -or -not $NodePath) { throw 'PackageRoot and NodePath are required for installation.' }
        $sourcePackage = [IO.Path]::GetFullPath($PackageRoot).TrimEnd('\')
        $sourceNode = [IO.Path]::GetFullPath($NodePath)
        Assert-NoReparseAncestors $sourcePackage
        Assert-NoReparseAncestors $sourceNode
        if ($sourcePackage -eq $installPath -or $sourcePackage.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Install from the CLI package, not from the running service snapshot.'
        }
        $manifestPath = Join-Path $sourcePackage 'package.json'
        $sourceManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($sourceManifest.name -ne 'anti-quota' -or $sourceManifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'The CLI package manifest is invalid.' }
        if ($existingConfig -and [version]$sourceManifest.version -lt [version]$existingConfig.version) { throw 'A newer Windows service is installed; downgrade was refused.' }
        $sourceHost = Join-Path $sourcePackage 'native\windows\AntiQuotaService.exe'
        foreach ($required in @($sourceHost, $sourceNode, (Join-Path $sourcePackage 'out\cli\cli.js'))) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'A required service runtime file is missing.' }
            Assert-NoReparseAncestors $required
        }
        $nodeVersion = (Get-Item -LiteralPath $sourceNode).VersionInfo.ProductVersion
        if ($nodeVersion -notmatch '^(\d+)\.(\d+)\.(\d+)' -or [version]($Matches[1] + '.' + $Matches[2] + '.' + $Matches[3]) -lt [version]'18.17.0') {
            throw 'Node.js 18.17 or later is required.'
        }
        if (-not (Test-Path -LiteralPath $basePath)) {
            [void][IO.Directory]::CreateDirectory($basePath)
            Set-ProtectedDirectory $basePath ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'))
        }
        Assert-Protected $basePath
        $stagePath = Join-Path $basePath ('.stage-' + $sidHash + '-' + [Guid]::NewGuid().ToString('N'))
        $backupPath = Join-Path $basePath ('.backup-' + $sidHash + '-' + [Guid]::NewGuid().ToString('N'))
        $wasRunning = $existingService -and $existingService.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped
        $movedOld = $false
        $movedNew = $false
        $createdService = $false
        $installed = $false
        try {
            [void][IO.Directory]::CreateDirectory($stagePath)
            Set-ProtectedDirectory $stagePath $targetSid
            [IO.File]::Copy($sourceHost, (Join-Path $stagePath 'AntiQuotaService.exe'), $false)
            [IO.File]::Copy($sourceNode, (Join-Path $stagePath 'node.exe'), $false)
            $snapshotPath = Join-Path $stagePath 'package'
            [void][IO.Directory]::CreateDirectory($snapshotPath)
            foreach ($directory in @('out', 'scripts')) {
                Copy-SafeTree (Join-Path $sourcePackage $directory) (Join-Path $snapshotPath $directory)
            }
            foreach ($filename in @('package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt')) {
                $source = Join-Path $sourcePackage $filename
                Assert-NoReparseAncestors $source
                [IO.File]::Copy($source, (Join-Path $snapshotPath $filename), $false)
            }
            $snapshotNative = Join-Path $snapshotPath 'native\windows'
            [void][IO.Directory]::CreateDirectory($snapshotNative)
            [IO.File]::Copy($sourceHost, (Join-Path $snapshotNative 'AntiQuotaService.exe'), $false)
            [IO.File]::Copy($PSCommandPath, (Join-Path $snapshotNative 'Install-Service.ps1'), $false)

            # Copy only the production dependency closure, retaining npm's layout.
            $pendingModules = [Collections.Generic.Queue[object]]::new()
            foreach ($dependency in $sourceManifest.dependencies.PSObject.Properties) {
                $pendingModules.Enqueue(@{ name = $dependency.Name; from = $sourcePackage })
            }
            $copiedModules = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            while ($pendingModules.Count -gt 0) {
                $request = $pendingModules.Dequeue()
                if ($request.name -notmatch '^(?:@[a-z0-9._-]+/)?[a-z0-9._-]+$') { throw 'Invalid runtime dependency name.' }
                $searchPath = $request.from
                $modulePath = $null
                while ($searchPath.Length -ge $sourcePackage.Length) {
                    $candidate = Join-Path (Join-Path $searchPath 'node_modules') $request.name
                    if (Test-Path -LiteralPath (Join-Path $candidate 'package.json') -PathType Leaf) { $modulePath = $candidate; break }
                    if ($searchPath -eq $sourcePackage) { break }
                    $searchPath = [IO.Path]::GetDirectoryName($searchPath)
                }
                if (-not $modulePath) { throw ('A runtime dependency is missing: ' + $request.name) }
                if (-not $copiedModules.Add($modulePath)) { continue }
                $relativeModule = $modulePath.Substring($sourcePackage.Length).TrimStart('\')
                Copy-SafeTree $modulePath (Join-Path $snapshotPath $relativeModule) -SkipNestedModules
                $moduleManifest = Get-Content -LiteralPath (Join-Path $modulePath 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                $dependenciesProperty = $moduleManifest.PSObject.Properties['dependencies']
                if ($dependenciesProperty) {
                    foreach ($dependency in $dependenciesProperty.Value.PSObject.Properties) {
                        $pendingModules.Enqueue(@{ name = $dependency.Name; from = $modulePath })
                    }
                }
            }
            [void][IO.Directory]::CreateDirectory((Join-Path $stagePath 'control'))
            $config = [ordered]@{ schemaVersion = 1; serviceName = $serviceName; userSid = $UserSid; version = $sourceManifest.version; enabled = $true }
            $stageConfig = Join-Path $stagePath 'install.json'
            $temporaryConfig = $stageConfig + '.new'
            [IO.File]::WriteAllText($temporaryConfig, ($config | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
            [IO.File]::Move($temporaryConfig, $stageConfig)
            Protect-Tree $stagePath
            foreach ($item in Get-SafeTree $stagePath) { Assert-Protected $item.FullName }
            Stop-ManagedService
            if (Test-Path -LiteralPath $installPath) {
                foreach ($item in Get-SafeTree $installPath) { Assert-Protected $item.FullName }
                [IO.Directory]::Move($installPath, $backupPath)
                $movedOld = $true
            }
            [IO.Directory]::Move($stagePath, $installPath)
            $movedNew = $true
            if (-not $existingService) {
                $createdController = New-Service -Name $serviceName -BinaryPathName ('"' + $hostPath + '"') -DisplayName ('Anti Quota (' + $sidHash + ')') -Description 'Starts the Anti Quota account agent in its registered user session.' -StartupType Automatic
                $createdController.Dispose()
                $createdService = $true
            } else { Set-Service -Name $serviceName -StartupType Automatic }
            # User can manage availability, but cannot replace the SYSTEM host.
            $serviceSddl = 'D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPLOCRRC;;;' + $UserSid + ')'
            Invoke-ServiceControl @('sdset', $serviceName, $serviceSddl)
            Invoke-ServiceControl @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/restart/60000')
            if (-not $KeepStopped) { Start-ManagedService }
            $installed = $true
            if ($movedOld) { Remove-InstallationTree $backupPath }
            Write-Output ('Windows service installed: ' + $serviceName + ' version ' + $sourceManifest.version)
        } catch {
            $installError = $_
            if (-not $installed -and ($movedNew -or $movedOld)) {
                try {
                    if ($movedNew) { Stop-ManagedService }
                    if ($createdService) { Invoke-ServiceControl @('delete', $serviceName) }
                    if ($movedNew) { Remove-InstallationTree $installPath }
                    if ($movedOld) { [IO.Directory]::Move($backupPath, $installPath); $movedOld = $false }
                    if ($existingService -and $wasRunning) { Start-ManagedService }
                } catch { throw ('Service installation failed and rollback needs administrator attention: ' + $installError.Exception.Message + ' / ' + $_.Exception.Message) }
            }
            throw $installError
        } finally {
            if (Test-Path -LiteralPath $stagePath) { Remove-InstallationTree $stagePath }
        }
    }
}
