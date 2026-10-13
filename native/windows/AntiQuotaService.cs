// Build with the .NET Framework 4.x C# compiler and references to
// System.ServiceProcess.dll and System.Runtime.Serialization.dll.
// This LocalSystem process supervises a fixed program under the signed-in
// user's token. It never loads JavaScript or opens the user's credentials.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace AntiQuota.Windows
{
    [DataContract]
    internal sealed class Installation
    {
        [DataMember(IsRequired = true)] public int schemaVersion { get; set; }
        [DataMember(IsRequired = true)] public string serviceName { get; set; }
        [DataMember(IsRequired = true)] public string userSid { get; set; }
        [DataMember(IsRequired = true)] public bool enabled { get; set; }
        [DataMember] public string version { get; set; }
    }

    internal sealed class UserAgent : IDisposable
    {
        internal IntPtr Handle;
        internal uint SessionId;
        internal string StopFile;
        internal bool SessionStop;
        internal DateTime StartedUtc;

        public void Dispose()
        {
            if (Handle != IntPtr.Zero)
            {
                Native.CloseHandle(Handle);
                Handle = IntPtr.Zero;
            }
        }
    }

    internal sealed class AntiQuotaService : ServiceBase
    {
        private const int ResumeCommand = 128;
        private const uint HostMarkerExitCode = 64;
        private const int StopTimeoutMilliseconds = 330000;
        private readonly object sync = new object();
        private readonly string root;
        private readonly string nodePath;
        private readonly string cliPath;
        private readonly string controlPath;
        private readonly Installation installation;
        private readonly HashSet<uint> loggedOffSessions = new HashSet<uint>();
        private Timer timer;
        private UserAgent agent;
        private bool stopping;
        private bool manuallyPaused;
        private DateTime nextStartUtc = DateTime.MinValue;
        private DateTime nextErrorLogUtc = DateTime.MinValue;
        private int retrySeconds = 2;

        internal AntiQuotaService(string directory, Installation config)
        {
            root = directory;
            installation = config;
            nodePath = Path.Combine(root, "node.exe");
            cliPath = Path.Combine(root, "package", "out", "cli", "cli.js");
            controlPath = Path.Combine(root, "control");
            ServiceName = config.serviceName;
            CanStop = true;
            CanShutdown = true;
            CanHandleSessionChangeEvent = true;
            AutoLog = true;
        }

        private static int Main(string[] arguments)
        {
            // No command-line dispatch, install action, or caller-selected file.
            if (arguments.Length != 0) return 2;
            try
            {
                string directory = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory)
                    .TrimEnd(Path.DirectorySeparatorChar);
                ValidateInstallationDirectory(directory);
                Installation config = ReadInstallation(directory);
                ValidateFixedFiles(directory);
                ServiceBase.Run(new AntiQuotaService(directory, config));
                return 0;
            }
            catch
            {
                // A path, JSON text, or account identifier must never be logged.
                return 1;
            }
        }

        protected override void OnStart(string[] arguments)
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity.User == null || !identity.User.IsWellKnown(WellKnownSidType.LocalSystemSid))
                    throw new InvalidOperationException("The supervisor must run as LocalSystem.");
            }
            Native.EnablePrivilege("SeTcbPrivilege");
            Native.EnablePrivilege("SeAssignPrimaryTokenPrivilege");
            Native.EnablePrivilege("SeIncreaseQuotaPrivilege");
            Native.AllowUserToWaitForHost(installation.userSid);
            lock (sync)
            {
                stopping = false;
                manuallyPaused = false;
                nextStartUtc = DateTime.MinValue;
                timer = new Timer(Tick, null, 0, 2000);
            }
        }

        protected override void OnCustomCommand(int command)
        {
            if (command != ResumeCommand) return;
            lock (sync)
            {
                if (stopping) throw new InvalidOperationException("The supervisor is draining.");
                Installation current = ReadCurrentInstallation();
                if (!current.enabled) throw new InvalidOperationException("The installation is disabled.");
                manuallyPaused = false;
                nextStartUtc = DateTime.MinValue;
                retrySeconds = 2;
            }
        }

        protected override void OnSessionChange(SessionChangeDescription change)
        {
            lock (sync)
            {
                if (change.Reason == SessionChangeReason.SessionLogon)
                    loggedOffSessions.Remove((uint)change.SessionId);
                if (change.Reason == SessionChangeReason.SessionLogoff)
                    loggedOffSessions.Add((uint)change.SessionId);
                if (change.Reason == SessionChangeReason.SessionLogoff && agent != null
                    && agent.SessionId == (uint)change.SessionId)
                {
                    // Only this in-memory reason can permit a subsequent login
                    // to restart an agent that exited after the host marker.
                    agent.SessionStop = true;
                    RequestAgentStop(agent);
                }
                // Login/unlock wakes enumeration but cannot undo a CLI stop.
                if (!manuallyPaused) nextStartUtc = DateTime.MinValue;
            }
            base.OnSessionChange(change);
        }

        protected override void OnStop()
        {
            DrainAndStop(true);
        }

        protected override void OnShutdown()
        {
            // Windows may impose a shorter shutdown deadline. We never force
            // terminate the agent; its credential commit is allowed to drain.
            DrainAndStop(false);
        }

        private void DrainAndStop(bool canReportStopPending)
        {
            lock (sync)
            {
                // Set before notification so a concurrent timer cannot relaunch.
                stopping = true;
                if (agent != null) RequestAgentStop(agent);
            }
            Stopwatch elapsed = Stopwatch.StartNew();
            while (true)
            {
                lock (sync)
                {
                    ReapAgent();
                    if (agent == null)
                    {
                        if (timer != null) { timer.Dispose(); timer = null; }
                        return;
                    }
                }
                if (elapsed.ElapsedMilliseconds >= StopTimeoutMilliseconds)
                {
                    WriteEvent("User agent did not finish draining; supervisor stop failed without terminating it.",
                        EventLogEntryType.Error);
                    // Keep stopping latched even if SCM restores RUNNING after
                    // this exception. A retry may finish once the agent exits.
                    throw new System.TimeoutException("User agent is still draining; no process was terminated.");
                }
                if (canReportStopPending) RequestAdditionalTime(15000);
                Thread.Sleep(1000);
            }
        }

        private void Tick(object state)
        {
            if (!Monitor.TryEnter(sync)) return;
            try
            {
                ReapAgent();
                if (stopping) return;
                Installation current = ReadCurrentInstallation();
                if (!current.enabled)
                {
                    manuallyPaused = true;
                    if (agent != null) RequestAgentStop(agent);
                    return;
                }
                if (agent != null || manuallyPaused || DateTime.UtcNow < nextStartUtc) return;
                ValidateFixedFiles(root);
                StartInUserSession();
            }
            catch (Exception error)
            {
                nextStartUtc = DateTime.UtcNow.AddSeconds(retrySeconds);
                retrySeconds = Math.Min(30, retrySeconds * 2);
                if (DateTime.UtcNow >= nextErrorLogUtc)
                {
                    // Type and native error code are sufficient; exception
                    // messages can contain user paths or serialized config.
                    int code = error is System.ComponentModel.Win32Exception
                        ? ((System.ComponentModel.Win32Exception)error).NativeErrorCode : 0;
                    WriteEvent("User agent supervision failed (" + error.GetType().Name + ", code "
                        + code.ToString(System.Globalization.CultureInfo.InvariantCulture) + ").",
                        EventLogEntryType.Error);
                    nextErrorLogUtc = DateTime.UtcNow.AddSeconds(30);
                }
            }
            finally { Monitor.Exit(sync); }
        }

        private Installation ReadCurrentInstallation()
        {
            Installation current = ReadInstallation(root);
            if (!String.Equals(current.serviceName, installation.serviceName, StringComparison.Ordinal)
                || !String.Equals(current.userSid, installation.userSid, StringComparison.Ordinal))
                throw new InvalidDataException("An installed identity cannot change while running.");
            return current;
        }

        private void ReapAgent()
        {
            if (agent == null) return;
            uint wait = Native.WaitForSingleObject(agent.Handle, 0);
            if (wait == Native.WaitTimeout) return;
            if (wait != Native.WaitObject0) throw Native.Error();
            uint exitCode;
            if (!Native.GetExitCodeProcess(agent.Handle, out exitCode)) throw Native.Error();
            bool sessionDrain = agent.SessionStop && exitCode == HostMarkerExitCode;
            if (DateTime.UtcNow - agent.StartedUtc >= TimeSpan.FromSeconds(30)) retrySeconds = 2;
            string stopFile = agent.StopFile;
            agent.Dispose();
            agent = null;
            // The marker is removed only after the saved process handle proves
            // exit. A generation never reuses another generation's marker.
            try { if (File.Exists(stopFile)) File.Delete(stopFile); }
            catch { WriteEvent("An exited agent's lifecycle marker could not be removed.", EventLogEntryType.Warning); }
            if (stopping) return;
            if (exitCode == 0 || (exitCode == HostMarkerExitCode && !sessionDrain))
            {
                manuallyPaused = true;
                return;
            }
            nextStartUtc = DateTime.UtcNow.AddSeconds(sessionDrain ? 1 : retrySeconds);
            if (!sessionDrain)
            {
                retrySeconds = Math.Min(30, retrySeconds * 2);
                WriteEvent("User agent exited unexpectedly (code "
                    + exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture) + "); restart scheduled.",
                    EventLogEntryType.Warning);
            }
        }

        private static void RequestAgentStop(UserAgent child)
        {
            using (FileStream marker = new FileStream(child.StopFile, FileMode.OpenOrCreate,
                FileAccess.Write, FileShare.Read)) { marker.Flush(true); }
        }

        private void StartInUserSession()
        {
            IntPtr sessions;
            int count;
            if (!Native.WTSEnumerateSessions(IntPtr.Zero, 0, 1, out sessions, out count)) throw Native.Error();
            try
            {
                int itemSize = Marshal.SizeOf(typeof(Native.WtsSessionInfo));
                // Prefer the active interactive desktop. A disconnected logged-in
                // session can still host the per-user quota service.
                for (int pass = 0; pass < 2; pass++)
                {
                    for (int index = 0; index < count; index++)
                    {
                        IntPtr address = new IntPtr(sessions.ToInt64() + ((long)index * itemSize));
                        Native.WtsSessionInfo session = (Native.WtsSessionInfo)Marshal.PtrToStructure(
                            address, typeof(Native.WtsSessionInfo));
                        if (session.SessionId == 0) continue;
                        if (loggedOffSessions.Contains(session.SessionId)) continue;
                        if (pass == 0 && session.State != 0) continue;
                        if (pass == 1 && session.State != 1 && session.State != 4) continue;
                        IntPtr token;
                        if (!Native.WTSQueryUserToken(session.SessionId, out token)) continue;
                        try
                        {
                            using (WindowsIdentity identity = new WindowsIdentity(token))
                            {
                                if (identity.User == null || !String.Equals(identity.User.Value,
                                    installation.userSid, StringComparison.Ordinal)) continue;
                            }
                            LaunchAgent(token, session.SessionId);
                            return;
                        }
                        finally { Native.CloseHandle(token); }
                    }
                }
            }
            finally { Native.WTSFreeMemory(sessions); }
        }

        private void LaunchAgent(IntPtr token, uint sessionId)
        {
            string stopFile = Path.Combine(controlPath, Guid.NewGuid().ToString("N") + ".stop");
            IntPtr inheritedEnvironment = IntPtr.Zero;
            IntPtr environment = IntPtr.Zero;
            Native.ProcessInformation process = new Native.ProcessInformation();
            try
            {
                if (!Native.CreateEnvironmentBlock(out inheritedEnvironment, token, false)) throw Native.Error();
                SortedDictionary<string, string> variables = ReadEnvironment(inheritedEnvironment);
                string profile = Native.GetProfileDirectory(token);
                // Never let a session/profile race write into the SYSTEM profile.
                if (String.IsNullOrWhiteSpace(profile) || !Directory.Exists(profile))
                    throw new InvalidOperationException("The user profile is unavailable.");
                variables["USERPROFILE"] = profile;
                // CreateEnvironmentBlock already reflects redirected AppData.
                // Supply standard fallbacks only when Windows omits a value.
                if (!variables.ContainsKey("APPDATA") || String.IsNullOrWhiteSpace(variables["APPDATA"]))
                    variables["APPDATA"] = Path.Combine(profile, "AppData", "Roaming");
                if (!variables.ContainsKey("LOCALAPPDATA") || String.IsNullOrWhiteSpace(variables["LOCALAPPDATA"]))
                    variables["LOCALAPPDATA"] = Path.Combine(profile, "AppData", "Local");
                variables.Remove("NODE_OPTIONS");
                variables.Remove("NODE_PATH");
                variables.Remove("ELECTRON_RUN_AS_NODE");
                variables.Remove("ANTI_QUOTA_UPDATE_RESTORE_CAPABILITY");
                variables["ANTI_QUOTA_SCM_MANAGED"] = "1";
                variables["ANTI_QUOTA_SCM_STOP_FILE"] = stopFile;
                variables["ANTI_QUOTA_SCM_HOST_PID"] = Native.GetCurrentProcessId()
                    .ToString(System.Globalization.CultureInfo.InvariantCulture);
                variables["ANTI_QUOTA_SCM_SERVICE_NAME"] = installation.serviceName;
                variables["ANTI_QUOTA_SCM_INSTALL_ROOT"] = root;
                environment = Marshal.StringToHGlobalUni(SerializeEnvironment(variables));
                Native.StartupInfo startup = new Native.StartupInfo();
                startup.cb = Marshal.SizeOf(typeof(Native.StartupInfo));
                startup.lpDesktop = "winsta0\\default";
                startup.dwFlags = 1; // STARTF_USESHOWWINDOW
                startup.wShowWindow = 0; // SW_HIDE
                StringBuilder command = new StringBuilder("\"" + nodePath + "\" \"" + cliPath
                    + "\" service managed-agent");
                if (!Native.CreateProcessAsUser(token, nodePath, command, IntPtr.Zero, IntPtr.Zero,
                    false, 0x00000400 | 0x08000000, environment, Path.Combine(root, "package"),
                    ref startup, out process)) throw Native.Error();
                agent = new UserAgent { Handle = process.hProcess, SessionId = sessionId,
                    StopFile = stopFile, StartedUtc = DateTime.UtcNow };
                process.hProcess = IntPtr.Zero;
            }
            finally
            {
                if (process.hThread != IntPtr.Zero) Native.CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) Native.CloseHandle(process.hProcess);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (inheritedEnvironment != IntPtr.Zero) Native.DestroyEnvironmentBlock(inheritedEnvironment);
            }
        }

        private static SortedDictionary<string, string> ReadEnvironment(IntPtr block)
        {
            SortedDictionary<string, string> result = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            long offset = 0;
            while (true)
            {
                string entry = Marshal.PtrToStringUni(new IntPtr(block.ToInt64() + offset));
                if (String.IsNullOrEmpty(entry)) break;
                int equals = entry.IndexOf('=', entry[0] == '=' ? 1 : 0);
                if (equals > 0) result[entry.Substring(0, equals)] = entry.Substring(equals + 1);
                offset += (entry.Length + 1L) * 2;
                if (offset > 2 * 1024 * 1024) throw new InvalidDataException("Environment block is oversized.");
            }
            return result;
        }

        private static string SerializeEnvironment(SortedDictionary<string, string> variables)
        {
            StringBuilder value = new StringBuilder();
            foreach (KeyValuePair<string, string> pair in variables)
                value.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            return value.Append('\0').ToString();
        }

        private static Installation ReadInstallation(string directory)
        {
            string file = Path.Combine(directory, "install.json");
            AssertNoReparsePoints(file);
            AssertProtected(file, false);
            Installation config;
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length == 0 || stream.Length > 16384) throw new InvalidDataException("Invalid installation config size.");
                config = (Installation)new DataContractJsonSerializer(typeof(Installation)).ReadObject(stream);
            }
            if (config == null || config.schemaVersion != 1 || String.IsNullOrWhiteSpace(config.userSid))
                throw new InvalidDataException("Invalid installation config.");
            SecurityIdentifier sid = new SecurityIdentifier(config.userSid);
            if (!sid.IsAccountSid() || !String.Equals(sid.Value, config.userSid, StringComparison.Ordinal))
                throw new InvalidDataException("A user account SID is required.");
            string suffix;
            using (SHA256 hash = SHA256.Create())
                suffix = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(config.userSid)))
                    .Replace("-", "").ToLowerInvariant().Substring(0, 12);
            if (!String.Equals(config.serviceName, "AntiQuota-" + suffix, StringComparison.Ordinal))
                throw new InvalidDataException("The service identity does not match its user.");
            return config;
        }

        private static void ValidateInstallationDirectory(string directory)
        {
            string protectedBoundary = null;
            string[] programFiles = { Environment.GetEnvironmentVariable("ProgramW6432"),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) };
            foreach (string candidate in programFiles)
            {
                if (String.IsNullOrWhiteSpace(candidate)) continue;
                string boundary = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar)
                    + Path.DirectorySeparatorChar;
                if (directory.StartsWith(boundary, StringComparison.OrdinalIgnoreCase))
                    protectedBoundary = boundary.TrimEnd(Path.DirectorySeparatorChar);
            }
            if (protectedBoundary == null)
                throw new InvalidDataException("The supervisor must be installed in Program Files.");
            AssertNoReparsePoints(directory);
            // A protected leaf is insufficient: writable DeleteChild rights on
            // its parent could replace the service executable before launch.
            string current = directory;
            while (true)
            {
                AssertProtected(current, true);
                if (String.Equals(current, protectedBoundary, StringComparison.OrdinalIgnoreCase)) break;
                current = Path.GetDirectoryName(current);
                if (String.IsNullOrEmpty(current)) throw new InvalidDataException("Invalid Program Files boundary.");
            }
        }

        private static void ValidateFixedFiles(string directory)
        {
            ValidateInstallationDirectory(directory);
            string[] directories = { directory, Path.Combine(directory, "control"),
                Path.Combine(directory, "package"), Path.Combine(directory, "package", "out"),
                Path.Combine(directory, "package", "out", "cli") };
            foreach (string item in directories)
            {
                AssertNoReparsePoints(item);
                AssertProtected(item, true);
            }
            string[] files = { Path.Combine(directory, "AntiQuotaService.exe"), Path.Combine(directory, "node.exe"),
                Path.Combine(directory, "package", "out", "cli", "cli.js") };
            foreach (string item in files)
            {
                AssertNoReparsePoints(item);
                AssertProtected(item, false);
            }
        }

        private static void AssertNoReparsePoints(string path)
        {
            string current = Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current))
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Installation paths may not contain reparse points.");
                current = Path.GetDirectoryName(current);
            }
        }

        private static bool IsTrustedOwner(string sid)
        {
            return sid == "S-1-5-18" || sid == "S-1-5-32-544"
                || sid == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
        }

        private static void AssertProtected(string path, bool directory)
        {
            FileSystemSecurity security = directory
                ? (FileSystemSecurity)Directory.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access)
                : File.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access);
            AssertProtectedSecurity(security);
        }

        private static void AssertProtectedSecurity(FileSystemSecurity security)
        {
            if (!IsTrustedOwner(security.GetOwner(typeof(SecurityIdentifier)).Value))
                throw new InvalidDataException("Installation owner is not trusted.");
            const FileSystemRights writable = FileSystemRights.WriteData | FileSystemRights.AppendData
                | FileSystemRights.WriteExtendedAttributes | FileSystemRights.DeleteSubdirectoriesAndFiles
                | FileSystemRights.WriteAttributes | FileSystemRights.Delete
                | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership
                | (FileSystemRights)0x10000000 | (FileSystemRights)0x40000000; // GENERIC_ALL / GENERIC_WRITE
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow
                    || (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                if ((rule.FileSystemRights & writable) != 0 && !IsTrustedOwner(rule.IdentityReference.Value))
                    throw new InvalidDataException("Installation grants untrusted write access.");
            }
        }

        private void WriteEvent(string message, EventLogEntryType type)
        {
            try { EventLog.WriteEntry(message, type); }
            catch { /* Event-log failure must not terminate a credential drain. */ }
        }
    }

    internal static class Native
    {
        internal const uint WaitObject0 = 0;
        internal const uint WaitTimeout = 258;

        // SCM grants the registered user start/stop rights, but a SYSTEM process
        // does not normally grant that user SYNCHRONIZE. Allow only waiting and
        // querying this supervisor, never terminate/write/duplicate-token rights.
        internal static void AllowUserToWaitForHost(string userSid)
        {
            const uint daclInformation = 4;
            uint required;
            GetKernelObjectSecurity(GetCurrentProcess(), daclInformation, null, 0, out required);
            if (required == 0) throw Error();
            byte[] descriptor = new byte[required];
            if (!GetKernelObjectSecurity(GetCurrentProcess(), daclInformation, descriptor,
                (uint)descriptor.Length, out required)) throw Error();
            RawSecurityDescriptor security = new RawSecurityDescriptor(descriptor, 0);
            if (security.DiscretionaryAcl == null)
                throw new InvalidOperationException("A process access-control list is required.");
            security.DiscretionaryAcl.InsertAce(security.DiscretionaryAcl.Count,
                new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x00101400,
                    new SecurityIdentifier(userSid), false, null));
            descriptor = new byte[security.BinaryLength];
            security.GetBinaryForm(descriptor, 0);
            if (!SetKernelObjectSecurity(GetCurrentProcess(), daclInformation, descriptor)) throw Error();
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetKernelObjectSecurity(IntPtr handle, uint information,
            byte[] descriptor, uint length, out uint required);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, byte[] descriptor);

        [StructLayout(LayoutKind.Sequential)]
        internal struct WtsSessionInfo { internal uint SessionId; internal IntPtr StationName; internal int State; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct StartupInfo
        {
            internal int cb;
            internal string lpReserved;
            internal string lpDesktop;
            internal string lpTitle;
            internal int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            internal short wShowWindow, cbReserved2;
            internal IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInformation { internal IntPtr hProcess, hThread; internal uint ProcessId, ThreadId; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Luid { internal uint LowPart; internal int HighPart; }
        [StructLayout(LayoutKind.Sequential)]
        private struct TokenPrivileges { internal uint Count; internal Luid Luid; internal uint Attributes; }

        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
        [DllImport("wtsapi32.dll")]
        internal static extern void WTSFreeMemory(IntPtr memory);
        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
        [DllImport("userenv.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool inherit);
        [DllImport("userenv.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DestroyEnvironmentBlock(IntPtr environment);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder directory, ref uint size);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreateProcessAsUser(IntPtr token, string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AdjustTokenPrivileges(IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool disableAll,
            ref TokenPrivileges privileges, uint length, IntPtr previous, IntPtr returnedLength);

        internal static System.ComponentModel.Win32Exception Error()
        {
            return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }

        internal static string GetProfileDirectory(IntPtr token)
        {
            uint length = 0;
            GetUserProfileDirectory(token, null, ref length);
            if (length < 2 || length > 32768) throw Error();
            StringBuilder result = new StringBuilder((int)length);
            if (!GetUserProfileDirectory(token, result, ref length)) throw Error();
            return result.ToString();
        }

        internal static void EnablePrivilege(string name)
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x20 | 0x8, out token)) throw Error();
            try
            {
                Luid luid;
                if (!LookupPrivilegeValue(null, name, out luid)) throw Error();
                TokenPrivileges privileges = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 };
                if (!AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero)) throw Error();
                int error = Marshal.GetLastWin32Error();
                if (error != 0) throw new System.ComponentModel.Win32Exception(error);
            }
            finally { CloseHandle(token); }
        }
    }
}
