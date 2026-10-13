import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { assertNoUpdateInProgress } from './update';

export interface WindowsServiceInstallation {
    schemaVersion: 1;
    serviceName: string;
    userSid: string;
    version: string;
    enabled: boolean;
    installRoot: string;
}

export interface ManagedHostEnvironment {
    installation: WindowsServiceInstallation;
    stopFile: string;
    hostPid: number;
}

export function getScmRestoreFile(): string {
    return path.join(os.homedir(), '.anti-quota', 'scm-update-restore.json');
}

let currentSid: string | undefined;
let managedEnvironment: ManagedHostEnvironment | undefined;

function powershellPath(): string {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
        'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Use the process token, not USERNAME, to select the registered Windows user. */
export function getWindowsUserSid(): string {
    if (process.platform !== 'win32') throw new Error('Windows 服务仅支持 Windows');
    if (!currentSid) {
        const result = execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command',
            '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], {
            encoding: 'utf-8', windowsHide: true, timeout: 10_000,
        }).trim();
        if (!/^S-1-5-21-(?:\d+-){3}\d+$/.test(result)) {
            throw new Error('无法确认当前 Windows 用户 SID，已拒绝注册服务');
        }
        currentSid = result;
    }
    return currentSid;
}

export function windowsServiceIdentity(userSid: string, programFiles: string) {
    if (!/^S-1-5-21-(?:\d+-){3}\d+$/.test(userSid)) throw new Error('Windows 用户 SID 无效');
    const suffix = crypto.createHash('sha256').update(userSid, 'utf-8').digest('hex').slice(0, 12);
    return {
        serviceName: `AntiQuota-${suffix}`,
        installRoot: path.join(programFiles, 'Anti Quota', suffix),
    };
}

export function getWindowsServiceInstallation(): WindowsServiceInstallation | null {
    if (process.platform !== 'win32') return null;
    const userSid = getWindowsUserSid();
    const identity = windowsServiceIdentity(userSid, process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files');
    let config: any;
    try {
        config = JSON.parse(fs.readFileSync(path.join(identity.installRoot, 'install.json'), 'utf-8').replace(/^\uFEFF/, ''));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error('Windows 服务安装记录无法读取，请以管理员身份重新运行 anti service install');
    }
    if (!config || config.schemaVersion !== 1 || config.userSid !== userSid
        || config.serviceName !== identity.serviceName || typeof config.enabled !== 'boolean'
        || typeof config.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(config.version)) {
        throw new Error('Windows 服务安装记录无效，已拒绝启动');
    }
    return { ...config, ...identity };
}

export function assertManagedVersionCompatible(cliVersion: string): void {
    const installation = getWindowsServiceInstallation();
    if (installation && installation.version !== cliVersion) {
        throw new Error(`Windows 服务版本 ${installation.version} 与 CLI ${cliVersion} 不一致；`
            + '请运行 anti service install 更新受保护的服务安装');
    }
}

/** A managed agent may only use the protected supervisor's fixed runtime. */
export function getManagedHostEnvironment(): ManagedHostEnvironment | null {
    if (process.env.ANTI_QUOTA_SCM_MANAGED !== '1') return null;
    if (managedEnvironment) return managedEnvironment;
    const installation = getWindowsServiceInstallation();
    const root = process.env.ANTI_QUOTA_SCM_INSTALL_ROOT;
    const stopFile = process.env.ANTI_QUOTA_SCM_STOP_FILE;
    const hostPid = Number(process.env.ANTI_QUOTA_SCM_HOST_PID);
    const samePath = (left: string, right: string) =>
        path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
    if (!installation || !root || !stopFile
        || !samePath(root, installation.installRoot)
        || process.env.ANTI_QUOTA_SCM_SERVICE_NAME !== installation.serviceName
        || !Number.isSafeInteger(hostPid) || hostPid <= 0 || hostPid !== process.ppid
        || !samePath(process.execPath, path.join(root, 'node.exe'))
        || !process.argv[1] || !samePath(process.argv[1], path.join(root, 'package', 'out', 'cli', 'cli.js'))
        || !samePath(path.dirname(stopFile), path.join(root, 'control'))
        || !/^[a-f0-9]{32}\.stop$/.test(path.basename(stopFile))) {
        throw new Error('Windows 服务宿主身份或控制路径无效，已拒绝运行');
    }
    assertManagedVersionCompatible(require('../../package.json').version);
    // Bind the parent to SCM's actual protected LocalSystem registration, not
    // just caller-controlled environment variables or a coincidentally live PID.
    const command = `$s=Get-CimInstance Win32_Service -Filter "Name='${installation.serviceName}'";`
        + 'if(!$s){throw "Missing SCM parent"};'
        + '[pscustomobject]@{pid=$s.ProcessId;account=$s.StartName;command=$s.PathName;'
        + 'session=(Get-Process -Id $s.ProcessId -ErrorAction Stop).SessionId}|ConvertTo-Json -Compress';
    const parent = JSON.parse(execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf-8', windowsHide: true, timeout: 10_000,
    }));
    if (parent.pid !== hostPid || parent.account !== 'LocalSystem' || parent.session !== 0
        || parent.command?.trim().toLowerCase() !== `"${path.join(root, 'AntiQuotaService.exe')}"`.toLowerCase()) {
        throw new Error('父进程不是已注册的 Windows 服务宿主，已拒绝运行');
    }
    managedEnvironment = { installation, stopFile, hostPid };
    return managedEnvironment;
}

function serviceControl(action: string, serviceName: string, extra: string[] = []): string {
    return execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe'),
        [action, serviceName, ...extra], { encoding: 'utf-8', windowsHide: true, timeout: 15_000 });
}

export function getWindowsScmStatus(installation: WindowsServiceInstallation): string {
    const encodedName = Buffer.from(installation.serviceName, 'utf-8').toString('base64');
    return execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command',
        `$n=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedName}'));`
        + '(Get-Service -Name $n -ErrorAction Stop).Status.ToString()'], {
        encoding: 'utf-8', windowsHide: true, timeout: 10_000,
    }).trim();
}

/** The installer grants only start/stop/query/custom-control rights to this user. */
export function startWindowsUserAgent(restoreCapability?: string): void {
    const installation = getWindowsServiceInstallation();
    if (!installation) throw new Error('Windows 服务尚未安装，请运行 anti service install');
    if (!installation.enabled) throw new Error('Windows 服务已被停用，请运行 anti service install');
    if (restoreCapability) {
        const restoreFile = getScmRestoreFile();
        fs.mkdirSync(path.dirname(restoreFile), { recursive: true });
        fs.writeFileSync(restoreFile, JSON.stringify({
            capability: restoreCapability,
            serviceName: installation.serviceName,
            version: installation.version,
        }), { encoding: 'utf-8', mode: 0o600 });
    } else {
        // A failed startup may leave an expired one-shot capsule. Do not clear
        // a capsule belonging to another updater that currently owns the gate.
        assertNoUpdateInProgress();
        try { fs.unlinkSync(getScmRestoreFile()); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const status = getWindowsScmStatus(installation);
    if (status === 'Stopped') serviceControl('start', installation.serviceName);
    else if (status === 'Running') serviceControl('control', installation.serviceName, ['128']);
    else if (status !== 'StartPending') throw new Error(`Windows 服务正在${status}，请稍后重试`);
}

export function stopWindowsService(): void {
    const installation = getWindowsServiceInstallation();
    if (!installation || getWindowsScmStatus(installation) === 'Stopped') return;
    // Bind a SYNCHRONIZE handle before stop. SCM Stopped alone is not proof
    // that the old executable exited and is safe for an updater to replace.
    const name = Buffer.from(installation.serviceName, 'utf-8').toString('base64');
    const waitApi = Buffer.from('using System;using System.Runtime.InteropServices;public static class AQWait{'
        + '[DllImport("kernel32.dll",SetLastError=true)]public static extern IntPtr OpenProcess(uint a,bool i,uint p);'
        + '[DllImport("kernel32.dll")]public static extern uint WaitForSingleObject(IntPtr h,uint t);'
        + '[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);}', 'utf-8').toString('base64');
    execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command',
        `$n=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${name}'));`
        + '$ErrorActionPreference="Stop";'
        + `Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${waitApi}')));`
        + '$r=Get-CimInstance Win32_Service -Filter ("Name="+[char]39+$n+[char]39);'
        + 'if(!$r -or $r.ProcessId -le 0){throw "Cannot bind SCM process"};'
        + '$h=[AQWait]::OpenProcess(0x100000,$false,$r.ProcessId);'
        + 'if($h -eq [IntPtr]::Zero){throw "Cannot wait for SCM process"};'
        + '$s=Get-Service -Name $n -ErrorAction Stop;$w=[Diagnostics.Stopwatch]::StartNew();'
        + 'try {if($s.Status -ne [ServiceProcess.ServiceControllerStatus]::StopPending){$s.Stop()};'
        + '$s.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(335));'
        + '$left=[uint32][Math]::Max(0,340000-$w.ElapsedMilliseconds);'
        + 'if([AQWait]::WaitForSingleObject($h,$left) -ne 0){throw "SCM host has not exited"}}'
        + 'finally {[void][AQWait]::CloseHandle($h);$s.Dispose()}'], {
        encoding: 'utf-8', windowsHide: true, timeout: 350_000,
    });
}

/** Elevate only the fixed install/uninstall entrypoint; no user credentials are requested. */
export function runWindowsServiceInstaller(action: 'Install' | 'Uninstall', cliPath: string): void {
    const packageRoot = path.resolve(path.dirname(cliPath), '../..');
    const installer = path.join(packageRoot, 'native', 'windows', 'Install-Service.ps1');
    if (!fs.existsSync(installer)) throw new Error('安装包缺少 Windows 服务安装器，请重新安装完整发布包');
    const request = Buffer.from(JSON.stringify({
        installer, action, userSid: getWindowsUserSid(), packageRoot, nodePath: process.execPath,
    }), 'utf-8').toString('base64');
    const command = "$ErrorActionPreference='Stop';"
        + `$r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}'))|ConvertFrom-Json;`
        + 'try { & $r.installer -Action $r.action -UserSid $r.userSid -PackageRoot $r.packageRoot -NodePath $r.nodePath -KeepStopped; exit 0 }'
        + 'catch { Write-Error $_; exit 1 }';
    const elevatedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const outer = "$ErrorActionPreference='Stop';"
        + '$a=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());'
        + `if($a.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){${command}}`
        + 'else {$p=Start-Process -FilePath (Join-Path $PSHOME powershell.exe) -Verb RunAs -WindowStyle Hidden -Wait -PassThru '
        + `-ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${elevatedCommand}';exit $p.ExitCode}`;
    try {
        execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], {
            encoding: 'utf-8', windowsHide: true, timeout: 9 * 60_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch {
        throw new Error('Windows 服务安装/移除未完成；请接受管理员授权，或在管理员终端重新运行 anti service '
            + (action === 'Install' ? 'install' : 'uninstall'));
    }
    if (action === 'Install' && !getWindowsServiceInstallation()) {
        throw new Error('Windows 服务安装记录未确认，已拒绝报告安装成功');
    }
    if (action === 'Uninstall' && getWindowsServiceInstallation()) {
        throw new Error('Windows 服务安装记录仍然存在，移除未确认');
    }
}
