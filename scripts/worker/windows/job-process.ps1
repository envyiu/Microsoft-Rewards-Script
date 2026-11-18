param([switch]$Worker)
$ErrorActionPreference = 'Stop'

# Each watchdog generation owns a Windows Job Object. Closing it kills all
# descendants, including browsers, before a crashed worker can be restarted.
if (-not ('MSRW.JobProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace MSRW {
    public static class JobProcess {
        [StructLayout(LayoutKind.Sequential)] struct Basic {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] struct Io {
            public ulong ReadOperations, WriteOperations, OtherOperations;
            public ulong ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] struct Extended {
            public Basic Basic;
            public Io Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref Extended info, uint size);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        public static int Run(string executable, string arguments, string cwd) {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            try {
                var limits = new Extended();
                limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
                var info = new ProcessStartInfo(executable, arguments);
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WorkingDirectory = cwd;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                using (var process = Process.Start(info)) {
                    process.OutputDataReceived += (sender, data) => { if (data.Data != null) Console.Out.WriteLine(data.Data); };
                    process.ErrorDataReceived += (sender, data) => { if (data.Data != null) Console.Error.WriteLine(data.Data); };
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    if (!AssignProcessToJobObject(job, process.Handle)) {
                        int error = Marshal.GetLastWin32Error();
                        process.Kill();
                        throw new Win32Exception(error);
                    }
                    while (!process.WaitForExit(1000)) { }
                    int code = process.ExitCode;
                    // Close descendant pipe writers before waiting for async
                    // log readers; otherwise an orphan can keep them open.
                    CloseHandle(job);
                    job = IntPtr.Zero;
                    process.WaitForExit();
                    return code;
                }
            } finally { if (job != IntPtr.Zero) CloseHandle(job); }
        }
    }
}
'@
}

if ($Worker) {
    $base = if ($env:MSRW_WORKER_HOME) { $env:MSRW_WORKER_HOME } else { $PSScriptRoot }
    $node = "$base\runtime\node-v24.22.2-win-x64\node.exe"
    $release = if ($env:MSRW_RELEASE_DIR) { $env:MSRW_RELEASE_DIR } else { "$base\worker" }
    $entry = '"' + "$release\scripts\worker\server.js" + '"'
    $code = [MSRW.JobProcess]::Run($node, $entry, $release)
    exit $code
}
