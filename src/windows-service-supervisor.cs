using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
internal static class WindowsServiceSupervisor
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint StartfUseShowWindow = 0x00000001;
    private const short SwHide = 0;
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint Infinite = 0xffffffff;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitFailed = 0xffffffff;
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Cb;
        public string Reserved;
        public string Desktop;
        public string Title;
        public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute;
        public int Flags;
        public short ShowWindow, Reserved2;
        public IntPtr Reserved2Pointer, StandardInput, StandardOutput, StandardError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, uint informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static int Failure(string message, int error = 0)
    {
        if (error == 0) error = Marshal.GetLastWin32Error();
        Console.Error.WriteLine("Codex Router supervisor: " + message + " (Win32 " + error + ")");
        return 1;
    }

    private static bool IsOrdinaryFile(string path)
    {
        try
        {
            if (path == null || path.IndexOf('%') >= 0 || !Path.IsPathRooted(path) || !File.Exists(path)) return false;
            string current = Path.GetFullPath(path);
            while (!string.IsNullOrEmpty(current))
            {
                FileAttributes attributes = File.GetAttributes(current);
                if ((attributes & FileAttributes.ReparsePoint) != 0) return false;
                string parent = Path.GetDirectoryName(current);
                if (string.IsNullOrEmpty(parent) || string.Equals(parent, current, StringComparison.OrdinalIgnoreCase)) break;
                current = parent;
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string OwnPath()
    {
        try
        {
            string path = Process.GetCurrentProcess().MainModule.FileName;
            return IsOrdinaryFile(path) ? Path.GetFullPath(path) : null;
        }
        catch
        {
            return null;
        }
    }

    private static string SystemCommandPath()
    {
        // Environment.SystemDirectory asks the OS for the actual system
        // directory; an inherited SystemRoot value is operator-controlled and
        // could redirect the child to an ordinary-looking impostor.
        return Path.Combine(Environment.SystemDirectory, "cmd.exe");
    }

    private static bool SetKillOnClose(IntPtr job)
    {
        ExtendedLimitInformation limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            return SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string CommandLineFor(string wrapper)
    {
        // cmd.exe /C needs the outer quote pair so a wrapper path containing
        // spaces remains one command, and the inner pair so /C treats it as the
        // batch file rather than as its first argument.
        return "cmd.exe /D /C \"\"" + wrapper + "\"\"";
    }

    private static int Run()
    {
        string ownPath = OwnPath();
        if (ownPath == null) return Failure("the supervisor path is not an ordinary owned file");
        if (Environment.GetCommandLineArgs().Length != 1)
            return Failure("external arguments are not accepted");

        string directory = Path.GetDirectoryName(ownPath);
        string wrapper = Path.Combine(directory, "start-codex-router.cmd");
        string command = SystemCommandPath();
        if (!IsOrdinaryFile(wrapper) || !IsOrdinaryFile(command))
            return Failure("the fixed CMD or system command path is not an ordinary file");
        if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(wrapper)), directory, StringComparison.OrdinalIgnoreCase))
            return Failure("the CMD wrapper is not beside the supervisor");

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return Failure("CreateJobObject failed");
        ProcessInformation process = new ProcessInformation();
        bool processCreated = false;
        try
        {
            if (!SetKillOnClose(job)) return Failure("SetInformationJobObject failed");

            StartupInfo startup = new StartupInfo();
            startup.Cb = Marshal.SizeOf(typeof(StartupInfo));
            startup.Flags = (int)StartfUseShowWindow;
            startup.ShowWindow = SwHide;
            StringBuilder commandLine = new StringBuilder(CommandLineFor(wrapper));
            uint creationFlags = CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment;
            if (!CreateProcess(
                    command,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    creationFlags,
                    IntPtr.Zero,
                    directory,
                    ref startup,
                    out process))
                return Failure("CreateProcess for the CMD wrapper failed");
            processCreated = true;

            if (!AssignProcessToJobObject(job, process.Process))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.Process, 1);
                return Failure("AssignProcessToJobObject failed", error);
            }
            if (ResumeThread(process.Thread) == 0xffffffff)
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.Process, 1);
                return Failure("ResumeThread failed", error);
            }
            CloseHandle(process.Thread);
            process.Thread = IntPtr.Zero;

            uint wait = WaitForSingleObject(process.Process, Infinite);
            if (wait == WaitFailed) return Failure("WaitForSingleObject failed");
            if (wait != WaitObject0) return Failure("the CMD wrapper ended with an unknown wait result", (int)wait);
            uint exitCode;
            if (!GetExitCodeProcess(process.Process, out exitCode)) return Failure("GetExitCodeProcess failed");
            return (int)exitCode;
        }
        finally
        {
            if (processCreated && process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (processCreated && process.Process != IntPtr.Zero) CloseHandle(process.Process);
            // Closing the sole private handle terminates any still-associated
            // descendants if the supervisor is leaving through an error path.
            CloseHandle(job);
        }
    }

    private static int Main()
    {
        try
        {
            return Run();
        }
        catch (Exception error)
        {
            return Failure(error.GetType().Name + " while starting the owned service");
        }
    }
}
