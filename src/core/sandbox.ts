// OS-level command sandboxing for Atrium.
// - Windows: native Win32 Restricted Token + Low Integrity (MIC S-1-16-4096) + Job Object (KILL_ON_JOB_CLOSE).
// - macOS: native Seatbelt `/usr/bin/sandbox-exec` SBPL profile.
// - Linux: Bubblewrap (`bwrap`) root-read-only namespace when installed.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SandboxCapabilities, SandboxMode } from '../shared/types.ts'

const execFileAsync = promisify(execFile)

const OUTPUT_LIMIT = 100_000
const STREAM_INTERVAL_MS = 180
const WIN_SANDBOX_VERSION = 'v2'

export interface SandboxedCommandResult {
  output: string
  isError: boolean
  exitCode: number | null
}

const lowLabeledDirs = new Set<string>()
let cachedWinExe: string | null = null
let winCompilePromise: Promise<string | null> | null = null
let cachedBwrapPath: string | null | undefined

export function winCscPath(): string | null {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

function findBwrapSync(): string | null {
  if (cachedBwrapPath !== undefined) return cachedBwrapPath
  if (process.platform !== 'linux') {
    cachedBwrapPath = null
    return null
  }
  try {
    const out = execFileSync('which', ['bwrap'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    cachedBwrapPath = out || null
  } catch {
    cachedBwrapPath = null
  }
  return cachedBwrapPath
}

export function detectSandboxCapabilities(): SandboxCapabilities {
  if (process.platform === 'win32') {
    const csc = winCscPath()
    return {
      platform: 'win32',
      supported: true,
      backend: 'Windows Restricted Token + Low Integrity (MIC) + Job Object',
      details: csc
        ? 'Kernel-enforced Low Mandatory Integrity Control blocks writes outside allowed paths via native Win32 runner.'
        : 'Uses PowerShell Win32 P/Invoke Restricted Token & Low Integrity isolation (KILL_ON_JOB_CLOSE).',
    }
  }
  if (process.platform === 'darwin') {
    const hasSeatbelt = existsSync('/usr/bin/sandbox-exec')
    return {
      platform: 'darwin',
      supported: hasSeatbelt,
      backend: 'macOS Seatbelt (sandbox-exec)',
      details: hasSeatbelt
        ? 'Uses /usr/bin/sandbox-exec SBPL profile to confine writes to the workspace and optionally block network access.'
        : '/usr/bin/sandbox-exec was not found on this macOS system.',
    }
  }
  if (process.platform === 'linux') {
    const bwrap = findBwrapSync()
    return {
      platform: 'linux',
      supported: Boolean(bwrap),
      backend: 'Linux Bubblewrap (bwrap)',
      details: bwrap
        ? `Using ${bwrap} with read-only root bind and optional unshared network.`
        : 'Install bubblewrap (`bwrap`) to enable OS namespace filesystem and network sandboxing.',
    }
  }
  return {
    platform: process.platform,
    supported: false,
    backend: 'Unsupported',
    details: `OS sandboxing is not implemented for platform "${process.platform}".`,
  }
}

const WIN_SANDBOX_CS = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class AtriumWinSandbox {
  [StructLayout(LayoutKind.Sequential)]
  struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public bool bInheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public uint dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  const uint TOKEN_ALL_ACCESS = 0x000F01FF;
  const uint DISABLE_MAX_PRIVILEGE = 0x1;
  const uint LUA_TOKEN = 0x4;
  const int TokenIntegrityLevel = 25;
  const uint SE_GROUP_INTEGRITY = 0x20;
  const uint HANDLE_FLAG_INHERIT = 0x1;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint INFINITE = 0xFFFFFFFF;

  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr h, uint flags, uint dc, IntPtr ds, uint pc, IntPtr dp, uint rc, IntPtr rs, out IntPtr nt);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string sid, out IntPtr psid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetLengthSid(IntPtr psid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr tok, int cls, ref TOKEN_MANDATORY_LABEL info, uint len);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr hToken, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES sa, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr hThread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr hHandle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr hProcess, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr hObject);

  static Thread PumpPipe(IntPtr readHandle, Stream target) {
    var thread = new Thread(() => {
      try {
        using (var fs = new FileStream(new SafeFileHandle(readHandle, ownsHandle: true), FileAccess.Read)) {
          byte[] buf = new byte[4096];
          int n;
          while ((n = fs.Read(buf, 0, buf.Length)) > 0) {
            target.Write(buf, 0, n);
            target.Flush();
          }
        }
      } catch { }
    });
    thread.IsBackground = true;
    thread.Start();
    return thread;
  }

  static int Main(string[] args) {
    string cmdB64 = Environment.GetEnvironmentVariable("ATRIUM_SB_CMD_B64");
    string cwd = Environment.GetEnvironmentVariable("ATRIUM_SB_CWD") ?? Environment.CurrentDirectory;
    if (string.IsNullOrEmpty(cmdB64)) {
      Console.Error.WriteLine("Missing ATRIUM_SB_CMD_B64");
      return 125;
    }
    string command = Encoding.UTF8.GetString(Convert.FromBase64String(cmdB64));

    IntPtr curTok;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out curTok)) {
      Console.Error.WriteLine("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
      return 125;
    }
    IntPtr rTok;
    if (!CreateRestrictedToken(curTok, DISABLE_MAX_PRIVILEGE | LUA_TOKEN, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out rTok)) {
      Console.Error.WriteLine("CreateRestrictedToken failed: " + Marshal.GetLastWin32Error());
      return 125;
    }
    IntPtr lowSid;
    if (!ConvertStringSidToSid("S-1-16-4096", out lowSid)) {
      Console.Error.WriteLine("ConvertStringSidToSid failed: " + Marshal.GetLastWin32Error());
      return 125;
    }
    TOKEN_MANDATORY_LABEL tml = new TOKEN_MANDATORY_LABEL();
    tml.Label.Sid = lowSid;
    tml.Label.Attributes = SE_GROUP_INTEGRITY;
    uint tmlLen = (uint)Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + GetLengthSid(lowSid);
    if (!SetTokenInformation(rTok, TokenIntegrityLevel, ref tml, tmlLen)) {
      Console.Error.WriteLine("SetTokenInformation failed: " + Marshal.GetLastWin32Error());
      return 125;
    }

    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(sa);
    sa.bInheritHandle = true;

    IntPtr outR, outW, errR, errW;
    CreatePipe(out outR, out outW, ref sa, 0);
    CreatePipe(out errR, out errW, ref sa, 0);
    SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(errR, HANDLE_FLAG_INHERIT, 0);
    IntPtr nulIn = CreateFile("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);

    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    // Avoid inheriting the Medium-integrity interactive desktop so Low-integrity children init user32 cleanly.
    si.lpDesktop = "";
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = nulIn;
    si.hStdOutput = outW;
    si.hStdError = errW;

    string sysRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\\Windows";
    string cmdExe = Path.Combine(sysRoot, "System32", "cmd.exe");
    string cmdLine = "\\"" + cmdExe + "\\" /d /s /c \\"" + command + "\\"";

    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job != IntPtr.Zero) {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      SetInformationJobObject(job, 9, ref jeli, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    }

    PROCESS_INFORMATION pi;
    bool ok = CreateProcessAsUser(rTok, cmdExe, cmdLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_NO_WINDOW | CREATE_SUSPENDED, IntPtr.Zero, cwd, ref si, out pi);
    if (!ok) {
      ok = CreateProcessAsUser(rTok, cmdExe, cmdLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, cwd, ref si, out pi);
    }
    int lastErr = Marshal.GetLastWin32Error();

    CloseHandle(outW);
    CloseHandle(errW);
    if (nulIn != IntPtr.Zero && nulIn != new IntPtr(-1)) CloseHandle(nulIn);

    if (!ok) {
      CloseHandle(outR);
      CloseHandle(errR);
      Console.Error.WriteLine("CreateProcessAsUser failed: " + lastErr);
      return 125;
    }

    if (job != IntPtr.Zero) AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);

    Thread tOut = PumpPipe(outR, Console.OpenStandardOutput());
    Thread tErr = PumpPipe(errR, Console.OpenStandardError());

    WaitForSingleObject(pi.hProcess, INFINITE);
    tOut.Join(2000);
    tErr.Join(2000);

    uint code = 0;
    GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if (job != IntPtr.Zero) CloseHandle(job);
    return (int)code;
  }
}
`

async function ensureWinSandboxExe(dataDir?: string): Promise<string | null> {
  if (cachedWinExe && existsSync(cachedWinExe)) return cachedWinExe
  if (winCompilePromise) return winCompilePromise
  winCompilePromise = (async () => {
    const csc = winCscPath()
    if (!csc) return null
    const baseDir =
      dataDir && resolve(dataDir).toLowerCase() !== resolve('.').toLowerCase()
        ? join(dataDir, 'sandbox')
        : join(tmpdir(), 'atrium-sandbox-bin')
    mkdirSync(baseDir, { recursive: true })
    const csPath = join(baseDir, `atrium-win-sandbox-${WIN_SANDBOX_VERSION}.cs`)
    const exePath = join(baseDir, `atrium-win-sandbox-${WIN_SANDBOX_VERSION}.exe`)
    if (!existsSync(exePath)) {
      writeFileSync(csPath, WIN_SANDBOX_CS, 'utf8')
      try {
        const platFlag = process.arch === 'x64' ? '/platform:x64' : '/platform:anycpu'
        await execFileAsync(csc, ['/nologo', '/optimize+', platFlag, '/target:exe', `/out:${exePath}`, csPath], {
          windowsHide: true,
        })
      } catch {
        return null
      }
    }
    cachedWinExe = existsSync(exePath) ? exePath : null
    return cachedWinExe
  })().finally(() => {
    winCompilePromise = null
  })
  return winCompilePromise
}

async function ensureLowIntegrityLabel(dirPath: string): Promise<void> {
  const normalized = resolve(dirPath).toLowerCase()
  if (lowLabeledDirs.has(normalized)) return
  mkdirSync(dirPath, { recursive: true })
  try {
    await execFileAsync('icacls', [resolve(dirPath), '/setintegritylevel', '(OI)(CI)L'], { windowsHide: true })
    lowLabeledDirs.add(normalized)
  } catch {
    /* keep uncached if icacls cannot tag */
  }
}

function sandboxTempDir(workspace: string): string {
  const hash = createHash('sha1').update(resolve(workspace).toLowerCase()).digest('hex').slice(0, 12)
  return join(tmpdir(), `atrium-sb-${hash}`)
}

function escapeSeatbeltString(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildSeatbeltProfile(workspace: string, mode: SandboxMode, allowNetwork: boolean): string {
  const rules = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow signal (target same-sandbox))',
    '(allow mach-lookup)',
    '(allow sysctl-read)',
    '(allow ipc-posix-shm)',
    '(allow file-read*)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))',
  ]
  if (mode === 'workspace_write') {
    rules.push(`(allow file-write* (subpath "${escapeSeatbeltString(resolve(workspace))}"))`)
    rules.push(`(allow file-write* (subpath "${escapeSeatbeltString(tmpdir())}"))`)
    rules.push('(allow file-write* (subpath "/private/tmp") (subpath "/var/folders"))')
  }
  if (allowNetwork) {
    rules.push('(allow network*)')
  }
  return rules.join('\n')
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      /* fallback */
    }
  }
  child.kill()
}

export async function runSandboxedCommand(opts: {
  workspace: string
  command: string
  mode: Exclude<SandboxMode, 'off'>
  allowNetwork?: boolean
  dataDir?: string
  timeoutSeconds?: number
  signal: AbortSignal
  onOutput?: (outputSoFar: string) => void
}): Promise<SandboxedCommandResult> {
  const timeout = Math.min(600, Math.max(5, opts.timeoutSeconds ?? 120)) * 1000
  const allowNetwork = opts.allowNetwork !== false
  const ws = resolve(opts.workspace)

  let spawnCmd: string
  let spawnArgs: string[]
  let spawnEnv: NodeJS.ProcessEnv = { ...process.env, ATRIUM_SANDBOX: '1', ATRIUM_SANDBOX_MODE: opts.mode }
  let spawnShell = false

  if (process.platform === 'win32') {
    const exe = await ensureWinSandboxExe(opts.dataDir)
    if (!exe) {
      return {
        output: 'Windows OS sandbox compiler (csc.exe) was unavailable to initialize restricted execution.',
        isError: true,
        exitCode: null,
      }
    }
    const sbTemp = sandboxTempDir(ws)
    await ensureLowIntegrityLabel(sbTemp)
    if (opts.mode === 'workspace_write') {
      await ensureLowIntegrityLabel(ws)
    }
    spawnCmd = exe
    spawnArgs = []
    spawnEnv = {
      ...spawnEnv,
      TEMP: sbTemp,
      TMP: sbTemp,
      ATRIUM_SB_CMD_B64: Buffer.from(opts.command, 'utf8').toString('base64'),
      ATRIUM_SB_CWD: ws,
    }
  } else if (process.platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec')) {
      return { output: 'macOS sandbox-exec is unavailable on this machine.', isError: true, exitCode: null }
    }
    const profile = buildSeatbeltProfile(ws, opts.mode, allowNetwork)
    spawnCmd = '/usr/bin/sandbox-exec'
    spawnArgs = ['-p', profile, '/bin/sh', '-c', opts.command]
  } else if (process.platform === 'linux') {
    const bwrap = findBwrapSync()
    if (!bwrap) {
      return {
        output: 'Linux bubblewrap (`bwrap`) is not installed. Disable OS sandbox or install `bubblewrap`.',
        isError: true,
        exitCode: null,
      }
    }
    spawnCmd = bwrap
    spawnArgs = ['--ro-bind', '/', '/']
    if (opts.mode === 'workspace_write') {
      spawnArgs.push('--bind', ws, ws)
    }
    spawnArgs.push('--tmpfs', '/tmp', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--chdir', ws)
    if (!allowNetwork) spawnArgs.push('--unshare-net')
    spawnArgs.push('/bin/sh', '-c', opts.command)
  } else {
    spawnCmd = opts.command
    spawnArgs = []
    spawnShell = true
  }

  return new Promise((resolvePromise) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: ws,
      shell: spawnShell,
      windowsHide: true,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let truncated = false
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const pushLive = () => {
      flushTimer = null
      if (!opts.onOutput) return
      opts.onOutput(truncated ? `${output}\n… output truncated` : output)
    }
    const collect = (chunk: Buffer) => {
      if (!truncated) {
        output += chunk.toString('utf8')
        if (output.length > OUTPUT_LIMIT) {
          output = output.slice(0, OUTPUT_LIMIT)
          truncated = true
        }
      }
      if (opts.onOutput && !flushTimer) {
        flushTimer = setTimeout(pushLive, STREAM_INTERVAL_MS)
      }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeout)
    const onAbort = () => killProcessTree(child)
    opts.signal.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      opts.signal.removeEventListener('abort', onAbort)
    }

    child.on('error', (err) => {
      cleanup()
      resolvePromise({ output: `Sandboxed command failed to start: ${err.message}`, isError: true, exitCode: null })
    })

    child.on('close', (code) => {
      cleanup()
      const tail = truncated ? '\n… output truncated' : ''
      if (opts.signal.aborted) {
        resolvePromise({ output: `${output}${tail}\nStopped by the user.`, isError: true, exitCode: code })
      } else if (timedOut) {
        resolvePromise({
          output: `${output}${tail}\nTimed out after ${timeout / 1000}s and was stopped.`,
          isError: true,
          exitCode: code,
        })
      } else {
        resolvePromise({
          output: `${output}${tail}\nExit code: ${code ?? 'unknown'} [sandbox: ${opts.mode}]`,
          isError: code !== 0,
          exitCode: code,
        })
      }
    })
  })
}
