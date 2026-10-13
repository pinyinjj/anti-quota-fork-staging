param(
    [ValidateSet('Write', 'Fingerprint')]
    [string]$Mode = 'Write',
    [string]$TargetName = 'gemini:antigravity',
    [string]$UserName = 'antigravity'
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AntiQuotaWindowsCredential
{
    private const uint CRED_TYPE_GENERIC = 1;
    private const uint CRED_PERSIST_LOCAL_MACHINE = 2;
    private const int ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string targetName, uint type, uint flags, out IntPtr credentialPointer);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", SetLastError = false)]
    private static extern void CredFree(IntPtr credentialPointer);

    public static string Read(string targetName)
    {
        IntPtr credentialPointer;
        if (!CredRead(targetName, CRED_TYPE_GENERIC, 0, out credentialPointer))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_NOT_FOUND)
            {
                return null;
            }
            throw new Win32Exception(error);
        }

        try
        {
            var credential = (CREDENTIAL)Marshal.PtrToStructure(credentialPointer, typeof(CREDENTIAL));
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0)
            {
                return String.Empty;
            }

            byte[] bytes = new byte[credential.CredentialBlobSize];
            try
            {
                Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
                return Encoding.UTF8.GetString(bytes);
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
            }
        }
        finally
        {
            CredFree(credentialPointer);
        }
    }

    public static void Write(string targetName, string userName, string secret)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(secret);
        if (bytes.Length == 0 || bytes.Length > 2560)
        {
            throw new ArgumentOutOfRangeException("secret", "Credential payload must be between 1 and 2560 bytes.");
        }

        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new CREDENTIAL
            {
                Flags = 0,
                Type = CRED_TYPE_GENERIC,
                TargetName = targetName,
                Comment = "Managed by Anti Quota for Antigravity CLI",
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob,
                Persist = CRED_PERSIST_LOCAL_MACHINE,
                AttributeCount = 0,
                Attributes = IntPtr.Zero,
                TargetAlias = null,
                UserName = userName,
            };

            if (!CredWrite(ref credential, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(blob);
            Array.Clear(bytes, 0, bytes.Length);
        }
    }
}
'@

Add-Type -TypeDefinition $source

if ($Mode -eq 'Fingerprint') {
    $secret = [AntiQuotaWindowsCredential]::Read($TargetName)
    if ($null -eq $secret) {
        Write-Output 'NOT_FOUND'
        exit 0
    }

    try {
        try {
            $payload = $secret | ConvertFrom-Json
            $refreshToken = [string]$payload.token.refresh_token
        }
        catch {
            throw 'Credential payload is not valid OAuth JSON.'
        }

        if ([string]::IsNullOrWhiteSpace($refreshToken)) {
            throw 'Credential payload does not contain a refresh token.'
        }

        $bytes = [Text.Encoding]::UTF8.GetBytes($refreshToken)
        $payloadBytes = [Text.Encoding]::UTF8.GetBytes($secret)
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $hash = $sha256.ComputeHash($bytes)
            $fingerprint = ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
            $payloadHash = $sha256.ComputeHash($payloadBytes)
            $payloadFingerprint = ([BitConverter]::ToString($payloadHash)).Replace('-', '').ToLowerInvariant()
        }
        finally {
            if ($null -ne $hash) { [Array]::Clear($hash, 0, $hash.Length) }
            if ($null -ne $payloadHash) { [Array]::Clear($payloadHash, 0, $payloadHash.Length) }
            [Array]::Clear($bytes, 0, $bytes.Length)
            [Array]::Clear($payloadBytes, 0, $payloadBytes.Length)
            $sha256.Dispose()
        }

        Write-Output "FOUND:$fingerprint`:$payloadFingerprint"
    }
    finally {
        $secret = $null
        $refreshToken = $null
    }
    exit 0
}

$secret = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($secret)) {
    throw 'Credential payload is empty.'
}

try {
    [AntiQuotaWindowsCredential]::Write($TargetName, $UserName, $secret)
}
finally {
    $secret = $null
}
Write-Output 'OK'
