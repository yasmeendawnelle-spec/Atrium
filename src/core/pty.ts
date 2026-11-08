// Cross-platform PTY spawning helpers with zero native C++ addon dependencies.
// - Windows: compiles & caches a tiny Win32 ConPTY host executable via built-in .NET Framework csc.exe.
// - macOS / Linux: uses python3's stdlib `pty` + `termios.TIOCSWINSZ` controller.
// Both backends speak a minimal line-framed stdin protocol (`I <b64>`, `R <cols> <rows>`, `K`)
// while streaming raw ANSI/VT100 bytes directly on stdout.
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { winCscPath } from './sandbox.ts'

const execFileAsync = promisify(execFile)

const WIN_CONPTY_VERSION = 'v2'

export const PTY_CLOSE_FRAME = 'K\n'

export interface PtySpawnResult {
  proc: ChildProcess
  shellLabel: string
  ptyFramed: boolean
  cols: number
  rows: number
}

export function clampPtySize(cols?: number, rows?: number): { cols: number; rows: number } {
  const c = typeof cols === 'number' && Number.isFinite(cols) ? Math.floor(cols) : 100
  const r = typeof rows === 'number' && Number.isFinite(rows) ? Math.floor(rows) : 30
  return {
    cols: Math.max(20, Math.min(400, c)),
    rows: Math.max(5, Math.min(200, r)),
  }
}

export function encodePtyInputFrame(data: string): string {
  return `I ${Buffer.from(data, 'utf8').toString('base64')}\n`
}

export function encodePtyResizeFrame(cols: number, rows: number): string {
  const safe = clampPtySize(cols, rows)
  return `R ${safe.cols} ${safe.rows}\n`
}

const WIN_CONPTY_CS = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

class AtriumWinConPty {
  [StructLayout(LayoutKind.Sequential)]
  struct COORD {
    public short X;
    public short Y;
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
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
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

  const int STD_INPUT_HANDLE = -10;
  const int STD_OUTPUT_HANDLE = -11;
  const int STD_ERROR_HANDLE = -12;
  const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint INFINITE = 0xFFFFFFFF;

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetStdHandle(int nStdHandle, IntPtr hHandle);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, uint nSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern void ClosePseudoConsole(IntPtr hPC);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(
    IntPtr lpAttributeList,
    uint dwFlags,
    IntPtr Attribute,
    IntPtr lpValue,
    IntPtr cbSize,
    IntPtr lpPreviousValue,
    IntPtr lpReturnSize
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(
    string lpApplicationName,
    StringBuilder lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFOEX lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation
  );

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint cbLen);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr hThread);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr hObject);

  static short ParseShort(string raw, short fallback, short min, short max) {
    short v;
    if (!short.TryParse(raw, out v)) v = fallback;
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }

  static int Main(string[] args) {
    // Capture Node pipe streams before clearing PEB standard handles so the ConPTY
    // child never inherits the helper's pipe FDs instead of the PseudoConsole CONIN$/CONOUT$.
    Stream stdinStream = Console.OpenStandardInput();
    Stream stdoutStream = Console.OpenStandardOutput();
    StreamWriter stderrWriter = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true };
    SetStdHandle(STD_INPUT_HANDLE, IntPtr.Zero);
    SetStdHandle(STD_OUTPUT_HANDLE, IntPtr.Zero);
    SetStdHandle(STD_ERROR_HANDLE, IntPtr.Zero);

    string cmdB64 = Environment.GetEnvironmentVariable("ATRIUM_PTY_CMD_B64");
    string cwd = Environment.GetEnvironmentVariable("ATRIUM_PTY_CWD") ?? Environment.CurrentDirectory;
    short cols = ParseShort(Environment.GetEnvironmentVariable("ATRIUM_PTY_COLS") ?? "100", 100, 20, 400);
    short rows = ParseShort(Environment.GetEnvironmentVariable("ATRIUM_PTY_ROWS") ?? "30", 30, 5, 200);
    string command = !string.IsNullOrEmpty(cmdB64)
      ? Encoding.UTF8.GetString(Convert.FromBase64String(cmdB64))
      : "powershell.exe -NoLogo";

    IntPtr inRead, inWrite, outRead, outWrite;
    if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) {
      stderrWriter.WriteLine("CreatePipe(in) failed: " + Marshal.GetLastWin32Error());
      return 125;
    }
    if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) {
      CloseHandle(inRead);
      CloseHandle(inWrite);
      stderrWriter.WriteLine("CreatePipe(out) failed: " + Marshal.GetLastWin32Error());
      return 125;
    }

    IntPtr hPC;
    COORD size = new COORD { X = cols, Y = rows };
    int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out hPC);
    // CreatePseudoConsole duplicates these endpoints internally; close ours so EOF works.
    CloseHandle(inRead);
    CloseHandle(outWrite);

    if (hr != 0 || hPC == IntPtr.Zero) {
      CloseHandle(inWrite);
      CloseHandle(outRead);
      stderrWriter.WriteLine("CreatePseudoConsole failed: 0x" + hr.ToString("X8"));
      return 125;
    }

    IntPtr attrSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
    IntPtr attrList = Marshal.AllocHGlobal(attrSize);
    bool attrInit = InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize);
    if (!attrInit || !UpdateProcThreadAttribute(
      attrList,
      0,
      (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
      hPC,
      (IntPtr)IntPtr.Size,
      IntPtr.Zero,
      IntPtr.Zero
    )) {
      if (attrInit) DeleteProcThreadAttributeList(attrList);
      Marshal.FreeHGlobal(attrList);
      ClosePseudoConsole(hPC);
      CloseHandle(inWrite);
      CloseHandle(outRead);
      stderrWriter.WriteLine("ProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
      return 125;
    }

    STARTUPINFOEX siEx = new STARTUPINFOEX();
    siEx.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    siEx.lpAttributeList = attrList;

    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job != IntPtr.Zero) {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      SetInformationJobObject(job, 9, ref jeli, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    }

    PROCESS_INFORMATION pi;
    StringBuilder cmdBuf = new StringBuilder(command);
    uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
    bool ok = CreateProcessW(null, cmdBuf, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, cwd, ref siEx, out pi);
    if (!ok) {
      cmdBuf = new StringBuilder(command);
      ok = CreateProcessW(null, cmdBuf, IntPtr.Zero, IntPtr.Zero, false, flags | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, cwd, ref siEx, out pi);
    }
    int createErr = Marshal.GetLastWin32Error();

    DeleteProcThreadAttributeList(attrList);
    Marshal.FreeHGlobal(attrList);

    if (!ok) {
      ClosePseudoConsole(hPC);
      CloseHandle(inWrite);
      CloseHandle(outRead);
      if (job != IntPtr.Zero) CloseHandle(job);
      stderrWriter.WriteLine("CreateProcessW failed: " + createErr);
      return 125;
    }

    if (job != IntPtr.Zero) AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);

    Thread pumpOut = new Thread(() => {
      try {
        using (var fs = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read)) {
          byte[] buf = new byte[4096];
          int n;
          while ((n = fs.Read(buf, 0, buf.Length)) > 0) {
            stdoutStream.Write(buf, 0, n);
            stdoutStream.Flush();
          }
        }
      } catch { }
    });
    pumpOut.IsBackground = true;
    pumpOut.Start();

    object pcLock = new object();
    bool pcClosed = false;
    FileStream inWriter = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write);

    Thread controlThread = new Thread(() => {
      try {
        using (var reader = new StreamReader(stdinStream, new UTF8Encoding(false))) {
          string line;
          while ((line = reader.ReadLine()) != null) {
            if (line.StartsWith("I ")) {
              byte[] bytes = Convert.FromBase64String(line.Substring(2));
              if (bytes.Length > 0) {
                inWriter.Write(bytes, 0, bytes.Length);
                inWriter.Flush();
              }
            } else if (line.StartsWith("R ")) {
              string[] parts = line.Substring(2).Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
              if (parts.Length >= 2) {
                short c = ParseShort(parts[0], 100, 20, 400);
                short r = ParseShort(parts[1], 30, 5, 200);
                lock (pcLock) {
                  if (!pcClosed) ResizePseudoConsole(hPC, new COORD { X = c, Y = r });
                }
              }
            } else if (line == "K") {
              try { TerminateProcess(pi.hProcess, 0); } catch { }
              break;
            }
          }
        }
      } catch { }
      try { inWriter.Close(); } catch { }
      try { TerminateProcess(pi.hProcess, 0); } catch { }
    });
    controlThread.IsBackground = true;
    controlThread.Start();

    WaitForSingleObject(pi.hProcess, INFINITE);

    lock (pcLock) {
      if (!pcClosed) {
        pcClosed = true;
        ClosePseudoConsole(hPC);
      }
    }
    try { inWriter.Close(); } catch { }
    pumpOut.Join(1500);

    uint exitCode = 0;
    GetExitCodeProcess(pi.hProcess, out exitCode);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if (job != IntPtr.Zero) CloseHandle(job);
    return (int)exitCode;
  }
}
`

const POSIX_PTY_PY = `
import base64, errno, fcntl, os, pty, select, signal, struct, subprocess, sys, termios

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

cols = clamp(int(sys.argv[1]), 20, 400)
rows = clamp(int(sys.argv[2]), 5, 200)
cmd = sys.argv[3:]
master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
env = dict(os.environ)
env['TERM'] = 'xterm-256color'
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, preexec_fn=os.setsid, close_fds=True, env=env)
os.close(slave)

def set_nonblock(fd):
    fl = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

set_nonblock(master)
stdin_fd = sys.stdin.fileno()
set_nonblock(stdin_fd)
in_buf = b''
stdin_open = True
master_open = True

while master_open:
    rlist = [master] + ([stdin_fd] if stdin_open else [])
    try:
        r, _, _ = select.select(rlist, [], [], 0.2)
    except InterruptedError:
        continue
    if master in r:
        try:
            data = os.read(master, 8192)
            if not data:
                master_open = False
            else:
                os.write(sys.stdout.fileno(), data)
        except OSError as e:
            if e.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                master_open = False
    if stdin_open and stdin_fd in r:
        try:
            chunk = os.read(stdin_fd, 8192)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                chunk = b''
            else:
                chunk = b''
                stdin_open = False
        if chunk == b'' and stdin_fd in r:
            stdin_open = False
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except Exception:
                pass
        elif chunk:
            in_buf += chunk
            while b'\\n' in in_buf:
                line, in_buf = in_buf.split(b'\\n', 1)
                s = line.decode('utf-8', 'ignore').strip()
                if s.startswith('I '):
                    try:
                        os.write(master, base64.b64decode(s[2:]))
                    except Exception:
                        pass
                elif s.startswith('R '):
                    parts = s[2:].split()
                    if len(parts) >= 2:
                        try:
                            c = clamp(int(parts[0]), 20, 400)
                            rw = clamp(int(parts[1]), 5, 200)
                            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rw, c, 0, 0))
                            os.killpg(proc.pid, signal.SIGWINCH)
                        except Exception:
                            pass
                elif s == 'K':
                    try:
                        os.killpg(proc.pid, signal.SIGTERM)
                    except Exception:
                        pass
    if proc.poll() is not None:
        while True:
            try:
                rem = os.read(master, 8192)
                if not rem:
                    break
                os.write(sys.stdout.fileno(), rem)
            except OSError:
                break
        master_open = False

os.close(master)
sys.exit(proc.wait())
`

let cachedConPtyExe: string | null = null
let conPtyCompilePromise: Promise<string | null> | null = null
let cachedPython3: boolean | null = null

function winHelperPaths(dataDir?: string): { csPath: string; exePath: string; baseDir: string } {
  const baseDir =
    dataDir && resolve(dataDir).toLowerCase() !== resolve('.').toLowerCase()
      ? join(dataDir, 'terminal')
      : join(tmpdir(), 'atrium-pty-bin')
  return {
    baseDir,
    csPath: join(baseDir, `atrium-win-conpty-${WIN_CONPTY_VERSION}.cs`),
    exePath: join(baseDir, `atrium-win-conpty-${WIN_CONPTY_VERSION}.exe`),
  }
}

/** Pre-compiles and caches the Windows ConPTY host executable asynchronously during startup. */
export async function prewarmPtyHelper(dataDir?: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  if (cachedConPtyExe && existsSync(cachedConPtyExe)) return cachedConPtyExe
  if (conPtyCompilePromise) return conPtyCompilePromise
  conPtyCompilePromise = (async () => {
    const csc = winCscPath()
    if (!csc) return null
    const { baseDir, csPath, exePath } = winHelperPaths(dataDir)
    mkdirSync(baseDir, { recursive: true })
    if (!existsSync(exePath)) {
      writeFileSync(csPath, WIN_CONPTY_CS, 'utf8')
      try {
        const platFlag = process.arch === 'x64' ? '/platform:x64' : '/platform:anycpu'
        await execFileAsync(csc, ['/nologo', '/optimize+', platFlag, '/target:exe', `/out:${exePath}`, csPath], {
          windowsHide: true,
        })
      } catch {
        return null
      }
    }
    cachedConPtyExe = existsSync(exePath) ? exePath : null
    return cachedConPtyExe
  })().finally(() => {
    conPtyCompilePromise = null
  })
  return conPtyCompilePromise
}

function ensureWinConPtyExeSync(dataDir?: string): string | null {
  if (cachedConPtyExe && existsSync(cachedConPtyExe)) return cachedConPtyExe
  const csc = winCscPath()
  if (!csc) return null
  const { baseDir, csPath, exePath } = winHelperPaths(dataDir)
  mkdirSync(baseDir, { recursive: true })
  if (!existsSync(exePath)) {
    writeFileSync(csPath, WIN_CONPTY_CS, 'utf8')
    try {
      const platFlag = process.arch === 'x64' ? '/platform:x64' : '/platform:anycpu'
      execFileSync(csc, ['/nologo', '/optimize+', platFlag, '/target:exe', `/out:${exePath}`, csPath], {
        windowsHide: true,
        timeout: 15_000,
      })
    } catch {
      return null
    }
  }
  cachedConPtyExe = existsSync(exePath) ? exePath : null
  return cachedConPtyExe
}

function hasPython3(): boolean {
  if (cachedPython3 !== null) return cachedPython3
  try {
    const res = spawnSync('python3', ['--version'], { stdio: 'ignore', windowsHide: true })
    cachedPython3 = res.status === 0
  } catch {
    cachedPython3 = false
  }
  return cachedPython3
}

function defaultPosixShell(): string {
  const envShell = process.env.SHELL?.trim()
  if (envShell && existsSync(envShell)) return envShell
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/** Spawns a real interactive PTY session (Windows ConPTY or Unix Python pty) if supported by the OS. */
export function spawnInteractivePty(opts: {
  cwd: string
  cols?: number
  rows?: number
  dataDir?: string
}): PtySpawnResult | null {
  const { cols, rows } = clampPtySize(opts.cols, opts.rows)
  if (process.platform === 'win32') {
    const exePath = ensureWinConPtyExeSync(opts.dataDir)
    if (!exePath) return null
    const sysRoot = process.env.SystemRoot || 'C:\\Windows'
    const psExe = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const exeQuoted = `"${existsSync(psExe) ? psExe : 'powershell.exe'}"`
    const utf8Init = '[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false)'
    const cmdLine = `${exeQuoted} -NoLogo -NoExit -Command "${utf8Init}"`
    const proc = spawn(exePath, [], {
      cwd: opts.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        ATRIUM_PTY_CMD_B64: Buffer.from(cmdLine, 'utf8').toString('base64'),
        ATRIUM_PTY_CWD: opts.cwd,
        ATRIUM_PTY_COLS: String(cols),
        ATRIUM_PTY_ROWS: String(rows),
      },
    })
    return { proc, shellLabel: 'powershell', ptyFramed: true, cols, rows }
  }
  if (!hasPython3()) return null
  const sh = defaultPosixShell()
  const proc = spawn('python3', ['-c', POSIX_PTY_PY, String(cols), String(rows), sh, '-l'], {
    cwd: opts.cwd,
    detached: true,
    windowsHide: true,
    env: { ...process.env, TERM: 'xterm-256color' },
  })
  return { proc, shellLabel: basename(sh), ptyFramed: true, cols, rows }
}
