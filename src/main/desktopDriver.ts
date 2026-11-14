// Persistent Win32 OS desktop automation driver (DPI-aware C# SendInput + EnumWindows host over PowerShell).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { DesktopMouseAction, DesktopWindowInfo } from '../shared/types.ts'

export interface VirtualKeySpec {
  vk: number
  extended: boolean
  name: string
}

const NAMED_VKS: Record<string, { vk: number; extended?: boolean }> = {
  ctrl: { vk: 0x11 },
  control: { vk: 0x11 },
  lctrl: { vk: 0x11 },
  rctrl: { vk: 0xa3, extended: true },
  alt: { vk: 0x12 },
  menu: { vk: 0x12 },
  option: { vk: 0x12 },
  shift: { vk: 0x10 },
  win: { vk: 0x5b, extended: true },
  lwin: { vk: 0x5b, extended: true },
  rwin: { vk: 0x5c, extended: true },
  meta: { vk: 0x5b, extended: true },
  super: { vk: 0x5b, extended: true },
  cmd: { vk: 0x5b, extended: true },
  command: { vk: 0x5b, extended: true },
  enter: { vk: 0x0d },
  return: { vk: 0x0d },
  tab: { vk: 0x09 },
  esc: { vk: 0x1b },
  escape: { vk: 0x1b },
  space: { vk: 0x20 },
  spacebar: { vk: 0x20 },
  backspace: { vk: 0x08 },
  bs: { vk: 0x08 },
  delete: { vk: 0x2e, extended: true },
  del: { vk: 0x2e, extended: true },
  insert: { vk: 0x2d, extended: true },
  ins: { vk: 0x2d, extended: true },
  home: { vk: 0x24, extended: true },
  end: { vk: 0x23, extended: true },
  pageup: { vk: 0x21, extended: true },
  pgup: { vk: 0x21, extended: true },
  prior: { vk: 0x21, extended: true },
  pagedown: { vk: 0x22, extended: true },
  pgdn: { vk: 0x22, extended: true },
  next: { vk: 0x22, extended: true },
  up: { vk: 0x26, extended: true },
  arrowup: { vk: 0x26, extended: true },
  down: { vk: 0x28, extended: true },
  arrowdown: { vk: 0x28, extended: true },
  left: { vk: 0x25, extended: true },
  arrowleft: { vk: 0x25, extended: true },
  right: { vk: 0x27, extended: true },
  arrowright: { vk: 0x27, extended: true },
  capslock: { vk: 0x14 },
  numlock: { vk: 0x90, extended: true },
  scrolllock: { vk: 0x91 },
  printscreen: { vk: 0x2c, extended: true },
  prtsc: { vk: 0x2c, extended: true },
  snapshot: { vk: 0x2c, extended: true },
  pause: { vk: 0x13 },
  '-': { vk: 0xbd },
  minus: { vk: 0xbd },
  '=': { vk: 0xbb },
  equal: { vk: 0xbb },
  plus: { vk: 0xbb },
  '[': { vk: 0xdb },
  ']': { vk: 0xdd },
  '\\': { vk: 0xdc },
  ';': { vk: 0xba },
  "'": { vk: 0xde },
  ',': { vk: 0xbc },
  '.': { vk: 0xbe },
  '/': { vk: 0xbf },
  '`': { vk: 0xc0 },
  backquote: { vk: 0xc0 },
}

/** Maps a human-friendly key token to its Win32 Virtual-Key code and extended-key flag. */
export function resolveVirtualKey(raw: string): VirtualKeySpec | null {
  const token = raw.trim()
  if (!token) return null
  const lower = token.toLowerCase()
  if (lower === ' ') return { vk: 0x20, extended: false, name: 'space' }
  const named = NAMED_VKS[lower]
  if (named) return { vk: named.vk, extended: Boolean(named.extended), name: lower }
  const fMatch = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
  if (fMatch) {
    return { vk: 0x6f + Number(fMatch[1]), extended: false, name: lower }
  }
  if (/^[a-z]$/.test(lower)) {
    return { vk: lower.toUpperCase().charCodeAt(0), extended: false, name: lower }
  }
  if (/^[0-9]$/.test(lower)) {
    return { vk: lower.charCodeAt(0), extended: false, name: lower }
  }
  return null
}

/** Resolves a key name or hotkey array (e.g. `["ctrl", "shift", "s"]`). */
export function resolveKeyChord(keys: string[]): VirtualKeySpec[] {
  const out: VirtualKeySpec[] = []
  for (const raw of keys) {
    const parts = raw.includes('+') && raw.length > 1 ? raw.split('+') : [raw]
    for (const part of parts) {
      const spec = resolveVirtualKey(part)
      if (!spec) throw new Error(`Unsupported key "${part}".`)
      out.push(spec)
    }
  }
  if (out.length === 0) throw new Error('At least one key is required.')
  return out
}

const PS_WORKER_SCRIPT = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cs = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class AtriumWinInfo {
  public string hwnd;
  public string title;
  public string processName;
  public int pid;
  public int x;
  public int y;
  public int width;
  public int height;
  public bool minimized;
  public bool maximized;
  public bool foreground;
}

public static class AtriumDesktopHost {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL; public ushort wParamH;
  }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type;
    public InputUnion u;
  }

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_HWHEEL = 0x01000;
  const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
  const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

  static bool dpiInitialized = false;

  public static void Init() {
    if (dpiInitialized) return;
    dpiInitialized = true;
    try {
      if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
    } catch {
      try { SetProcessDPIAware(); } catch { }
    }
  }

  static void DispatchInput(INPUT[] inp) {
    uint sent = SendInput((uint)inp.Length, inp, Marshal.SizeOf(typeof(INPUT)));
    if (sent == 0) {
      int err = Marshal.GetLastWin32Error();
      throw new InvalidOperationException("Windows blocked desktop input (SendInput Win32 error " + err + "). Elevated admin or locked-screen windows cannot be driven without matching privilege.");
    }
  }

  static void SendMouseMove(int x, int y) {
    SetCursorPos(x, y);
    int vLeft = GetSystemMetrics(76);
    int vTop = GetSystemMetrics(77);
    int vW = Math.Max(1, GetSystemMetrics(78) - 1);
    int vH = Math.Max(1, GetSystemMetrics(79) - 1);
    int ax = (int)Math.Round((x - vLeft) * 65535.0 / vW);
    int ay = (int)Math.Round((y - vTop) * 65535.0 / vH);
    INPUT[] inp = new INPUT[1];
    inp[0].type = INPUT_MOUSE;
    inp[0].u.mi.dx = ax;
    inp[0].u.mi.dy = ay;
    inp[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    DispatchInput(inp);
  }

  static void SendMouseFlags(uint flags, int data) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = INPUT_MOUSE;
    inp[0].u.mi.mouseData = unchecked((uint)data);
    inp[0].u.mi.dwFlags = flags;
    DispatchInput(inp);
  }

  static uint DownFlag(string button) {
    if (button == "right") return MOUSEEVENTF_RIGHTDOWN;
    if (button == "middle") return MOUSEEVENTF_MIDDLEDOWN;
    return MOUSEEVENTF_LEFTDOWN;
  }

  static uint UpFlag(string button) {
    if (button == "right") return MOUSEEVENTF_RIGHTUP;
    if (button == "middle") return MOUSEEVENTF_MIDDLEUP;
    return MOUSEEVENTF_LEFTUP;
  }

  public static int[] Cursor() {
    Init();
    POINT p;
    GetCursorPos(out p);
    return new int[] { p.X, p.Y };
  }

  public static void Mouse(string action, int x, int y, int endX, int endY, int deltaX, int deltaY, string button) {
    Init();
    string btn = string.IsNullOrEmpty(button) ? "left" : button;
    if (action == "move") {
      SendMouseMove(x, y);
      return;
    }
    POINT prevPt;
    bool hasPrev = GetCursorPos(out prevPt);
    if (action == "click") {
      SendMouseMove(x, y);
      Thread.Sleep(15);
      SendMouseFlags(MOUSEEVENTF_LEFTDOWN, 0);
      Thread.Sleep(15);
      SendMouseFlags(MOUSEEVENTF_LEFTUP, 0);
      if (hasPrev) { Thread.Sleep(15); SetCursorPos(prevPt.X, prevPt.Y); }
      return;
    }
    if (action == "double_click") {
      SendMouseMove(x, y);
      Thread.Sleep(15);
      SendMouseFlags(MOUSEEVENTF_LEFTDOWN, 0);
      SendMouseFlags(MOUSEEVENTF_LEFTUP, 0);
      Thread.Sleep(45);
      SendMouseFlags(MOUSEEVENTF_LEFTDOWN, 0);
      SendMouseFlags(MOUSEEVENTF_LEFTUP, 0);
      if (hasPrev) { Thread.Sleep(15); SetCursorPos(prevPt.X, prevPt.Y); }
      return;
    }
    if (action == "right_click") {
      SendMouseMove(x, y);
      Thread.Sleep(15);
      SendMouseFlags(MOUSEEVENTF_RIGHTDOWN, 0);
      Thread.Sleep(15);
      SendMouseFlags(MOUSEEVENTF_RIGHTUP, 0);
      if (hasPrev) { Thread.Sleep(15); SetCursorPos(prevPt.X, prevPt.Y); }
      return;
    }
    if (action == "middle_click") {
      SendMouseMove(x, y);
      Thread.Sleep(15);
      SendMouseFlags(MOUSEEVENTF_MIDDLEDOWN, 0);
      Thread.Sleep(15);
      SendMouseFlags(MOUSEEVENTF_MIDDLEUP, 0);
      if (hasPrev) { Thread.Sleep(15); SetCursorPos(prevPt.X, prevPt.Y); }
      return;
    }
    if (action == "down") {
      SendMouseMove(x, y);
      Thread.Sleep(10);
      SendMouseFlags(DownFlag(btn), 0);
      return;
    }
    if (action == "up") {
      SendMouseMove(x, y);
      Thread.Sleep(10);
      SendMouseFlags(UpFlag(btn), 0);
      return;
    }
    if (action == "drag") {
      SendMouseMove(x, y);
      Thread.Sleep(20);
      SendMouseFlags(DownFlag(btn), 0);
      int steps = 10;
      for (int i = 1; i <= steps; i++) {
        int ix = x + (int)Math.Round((endX - x) * (double)i / steps);
        int iy = y + (int)Math.Round((endY - y) * (double)i / steps);
        SendMouseMove(ix, iy);
        Thread.Sleep(14);
      }
      SendMouseFlags(UpFlag(btn), 0);
      return;
    }
    if (action == "scroll") {
      SendMouseMove(x, y);
      Thread.Sleep(15);
      if (deltaY != 0) SendMouseFlags(MOUSEEVENTF_WHEEL, -deltaY);
      if (deltaX != 0) SendMouseFlags(MOUSEEVENTF_HWHEEL, deltaX);
      if (hasPrev) { Thread.Sleep(15); SetCursorPos(prevPt.X, prevPt.Y); }
      return;
    }
  }

  static void SendVk(ushort vk, bool ext, bool up) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = INPUT_KEYBOARD;
    inp[0].u.ki.wVk = vk;
    uint flags = 0;
    if (ext) flags |= KEYEVENTF_EXTENDEDKEY;
    if (up) flags |= KEYEVENTF_KEYUP;
    inp[0].u.ki.dwFlags = flags;
    DispatchInput(inp);
  }

  public static void TypeText(string text) {
    Init();
    if (string.IsNullOrEmpty(text)) return;
    List<INPUT> batch = new List<INPUT>();
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      if (c == '\\r') {
        if (i + 1 < text.Length && text[i + 1] == '\\n') i++;
        FlushBatch(batch);
        SendVk(0x0D, false, false);
        SendVk(0x0D, false, true);
        continue;
      }
      if (c == '\\n') {
        FlushBatch(batch);
        SendVk(0x0D, false, false);
        SendVk(0x0D, false, true);
        continue;
      }
      if (c == '\\t') {
        FlushBatch(batch);
        SendVk(0x09, false, false);
        SendVk(0x09, false, true);
        continue;
      }
      INPUT down = new INPUT();
      down.type = INPUT_KEYBOARD;
      down.u.ki.wScan = (ushort)c;
      down.u.ki.dwFlags = KEYEVENTF_UNICODE;
      batch.Add(down);

      INPUT up = new INPUT();
      up.type = INPUT_KEYBOARD;
      up.u.ki.wScan = (ushort)c;
      up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      batch.Add(up);

      if (batch.Count >= 32) {
        FlushBatch(batch);
        Thread.Sleep(2);
      }
    }
    FlushBatch(batch);
  }

  static void FlushBatch(List<INPUT> batch) {
    if (batch.Count == 0) return;
    DispatchInput(batch.ToArray());
    batch.Clear();
  }

  public static void KeyChord(int[] vks, bool[] exts) {
    Init();
    if (vks == null || vks.Length == 0) return;
    for (int i = 0; i < vks.Length; i++) {
      bool ext = (exts != null && i < exts.Length) ? exts[i] : false;
      SendVk((ushort)vks[i], ext, false);
    }
    Thread.Sleep(20);
    for (int i = vks.Length - 1; i >= 0; i--) {
      bool ext = (exts != null && i < exts.Length) ? exts[i] : false;
      SendVk((ushort)vks[i], ext, true);
    }
  }

  public static AtriumWinInfo[] ListWindows() {
    Init();
    List<AtriumWinInfo> list = new List<AtriumWinInfo>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd)) return true;
      int exStyle = GetWindowLong(hWnd, -20);
      if ((exStyle & 0x00000080) != 0) return true;
      int cloaked = 0;
      if (DwmGetWindowAttribute(hWnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      int len = GetWindowTextLength(hWnd);
      if (len <= 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString().Trim();
      if (string.IsNullOrEmpty(title)) return true;
      RECT r;
      if (DwmGetWindowAttribute(hWnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) {
        if (!GetWindowRect(hWnd, out r)) return true;
      }
      int w = r.Right - r.Left;
      int h = r.Bottom - r.Top;
      if (w < 40 || h < 30) return true;
      int pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      string procName = "";
      try { procName = Process.GetProcessById(pid).ProcessName; } catch { }
      AtriumWinInfo info = new AtriumWinInfo();
      info.hwnd = hWnd.ToInt64().ToString();
      info.title = title;
      info.processName = procName;
      info.pid = pid;
      info.x = r.Left;
      info.y = r.Top;
      info.width = w;
      info.height = h;
      info.minimized = IsIconic(hWnd);
      info.maximized = IsZoomed(hWnd);
      info.foreground = (hWnd == fg);
      list.Add(info);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  public static bool FocusWindow(long rawHwnd) {
    Init();
    IntPtr hWnd = new IntPtr(rawHwnd);
    if (!IsWindow(hWnd)) return false;
    if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
    IntPtr fg = GetForegroundWindow();
    uint curTid = GetCurrentThreadId();
    int fgPid = 0;
    uint fgTid = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;
    bool attached = false;
    if (fgTid != 0 && fgTid != curTid) {
      attached = AttachThreadInput(fgTid, curTid, true);
    }
    try {
      BringWindowToTop(hWnd);
      return SetForegroundWindow(hWnd);
    } finally {
      if (attached) AttachThreadInput(fgTid, curTid, false);
    }
  }

  public static bool SetWindowState(long rawHwnd, string state) {
    Init();
    IntPtr hWnd = new IntPtr(rawHwnd);
    if (!IsWindow(hWnd)) return false;
    int cmd = state == "minimize" ? 6 : (state == "maximize" ? 3 : 9);
    return ShowWindow(hWnd, cmd);
  }
}
"@

Add-Type -TypeDefinition $cs -Language CSharp
[AtriumDesktopHost]::Init()
Write-Output '{"ready":true}'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  try {
    $req = $line | ConvertFrom-Json
    $op = [string]$req.op
    $res = $null
    if ($op -eq 'cursor') {
      $c = [AtriumDesktopHost]::Cursor()
      $res = @{ ok = $true; x = [int]$c[0]; y = [int]$c[1] }
    } elseif ($op -eq 'windows') {
      $w = [AtriumDesktopHost]::ListWindows()
      $res = @{ ok = $true; windows = @($w) }
    } elseif ($op -eq 'mouse') {
      [AtriumDesktopHost]::Mouse([string]$req.action, [int]$req.x, [int]$req.y, [int]$req.endX, [int]$req.endY, [int]$req.deltaX, [int]$req.deltaY, [string]$req.button)
      $res = @{ ok = $true }
    } elseif ($op -eq 'type') {
      [AtriumDesktopHost]::TypeText([string]$req.text)
      $res = @{ ok = $true }
    } elseif ($op -eq 'chord') {
      $vks = [int[]]@($req.vks)
      $exts = [bool[]]@($req.exts)
      [AtriumDesktopHost]::KeyChord($vks, $exts)
      $res = @{ ok = $true }
    } elseif ($op -eq 'focus') {
      $ok = [AtriumDesktopHost]::FocusWindow([long]$req.hwnd)
      $res = @{ ok = $ok }
    } elseif ($op -eq 'windowState') {
      $ok = [AtriumDesktopHost]::SetWindowState([long]$req.hwnd, [string]$req.state)
      $res = @{ ok = $ok }
    } else {
      $res = @{ ok = $false; error = "Unknown op: $op" }
    }
    Write-Output ($res | ConvertTo-Json -Depth 5 -Compress)
  } catch {
    $errMsg = $_.Exception.Message
    Write-Output (@{ ok = $false; error = $errMsg } | ConvertTo-Json -Compress)
  }
}
`

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class WinDesktopWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()
  private pending: PendingRequest | null = null
  private disposed = false
  private readonly scriptDir: string

  constructor(scriptDir?: string) {
    this.scriptDir = scriptDir || tmpdir()
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const res = await this.request({ op: 'cursor' })
    return { x: Number(res.x ?? 0), y: Number(res.y ?? 0) }
  }

  async listWindows(): Promise<DesktopWindowInfo[]> {
    const res = await this.request({ op: 'windows' })
    const raw = Array.isArray(res.windows) ? res.windows : []
    return raw.map((w: Record<string, unknown>) => ({
      hwnd: String(w.hwnd ?? ''),
      title: String(w.title ?? ''),
      processName: String(w.processName ?? ''),
      pid: Number(w.pid ?? 0),
      x: Number(w.x ?? 0),
      y: Number(w.y ?? 0),
      width: Number(w.width ?? 0),
      height: Number(w.height ?? 0),
      minimized: Boolean(w.minimized),
      maximized: Boolean(w.maximized),
      foreground: Boolean(w.foreground),
    }))
  }

  async mouse(opts: {
    action: DesktopMouseAction
    x: number
    y: number
    endX?: number
    endY?: number
    deltaX?: number
    deltaY?: number
    button?: 'left' | 'right' | 'middle'
  }): Promise<void> {
    await this.request({
      op: 'mouse',
      action: opts.action,
      x: Math.round(opts.x),
      y: Math.round(opts.y),
      endX: Math.round(opts.endX ?? opts.x),
      endY: Math.round(opts.endY ?? opts.y),
      deltaX: Math.round(opts.deltaX ?? 0),
      deltaY: Math.round(opts.deltaY ?? 0),
      button: opts.button ?? 'left',
    })
  }

  async typeText(text: string): Promise<void> {
    await this.request({ op: 'type', text })
  }

  async keyChord(specs: VirtualKeySpec[]): Promise<void> {
    await this.request({
      op: 'chord',
      vks: specs.map((s) => s.vk),
      exts: specs.map((s) => s.extended),
    })
  }

  async focusWindow(hwnd: string): Promise<boolean> {
    const res = await this.request({ op: 'focus', hwnd: Number(hwnd) || 0 })
    return Boolean(res.ok)
  }

  async setWindowState(hwnd: string, state: 'minimize' | 'maximize' | 'restore'): Promise<boolean> {
    const res = await this.request({ op: 'windowState', hwnd: Number(hwnd) || 0, state })
    return Boolean(res.ok)
  }

  dispose(): void {
    this.disposed = true
    this.failPending('Desktop worker disposed.')
    if (this.proc) {
      try {
        this.proc.kill()
      } catch {
        /* ignore */
      }
      this.proc = null
    }
    this.starting = null
  }

  private failPending(reason: string): void {
    const cur = this.pending
    if (!cur) return
    this.pending = null
    clearTimeout(cur.timer)
    cur.reject(new Error(reason))
  }

  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (process.platform !== 'win32') {
      throw new Error(`OS desktop input automation currently requires Windows (detected ${process.platform}).`)
    }
    if (this.disposed) throw new Error('Desktop worker has been disposed.')
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return this.proc
    if (this.starting) {
      await this.starting
      if (!this.proc) throw new Error('Failed to start Windows desktop worker.')
      return this.proc
    }

    this.starting = new Promise<void>((resolve, reject) => {
      mkdirSync(this.scriptDir, { recursive: true })
      const scriptPath = join(this.scriptDir, 'atrium-desktop-worker.ps1')
      const content = `\uFEFF${PS_WORKER_SCRIPT}`
      let current = ''
      try {
        current = readFileSync(scriptPath, 'utf8')
      } catch {
        current = ''
      }
      if (current !== content) {
        writeFileSync(scriptPath, content, 'utf8')
      }
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      this.proc = child
      let ready = false
      let stderrTail = ''
      const bootTimer = setTimeout(() => {
        if (!ready) {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          reject(new Error(`Windows desktop helper timed out while initializing.${stderrTail ? ` Details: ${stderrTail}` : ''}`))
        }
      }, 15_000)

      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600)
      })

      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        if (!ready) {
          try {
            const initMsg = JSON.parse(trimmed) as { ready?: boolean }
            if (initMsg.ready) {
              ready = true
              clearTimeout(bootTimer)
              resolve()
              return
            }
          } catch {
            return
          }
        }
        const cur = this.pending
        if (!cur) return
        this.pending = null
        clearTimeout(cur.timer)
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>
          if (parsed.ok === false && typeof parsed.error === 'string' && parsed.error) {
            cur.reject(new Error(parsed.error))
          } else {
            cur.resolve(parsed)
          }
        } catch (err) {
          cur.reject(new Error(`Invalid response from desktop helper: ${err instanceof Error ? err.message : trimmed}`))
        }
      })

      child.on('exit', (code) => {
        clearTimeout(bootTimer)
        if (this.proc === child) this.proc = null
        if (!ready) {
          reject(new Error(`Windows desktop helper exited during startup (code ${code ?? 'null'}). ${stderrTail}`))
        }
        this.failPending(`Windows desktop helper exited (code ${code ?? 'null'}).`)
      })
    }).finally(() => {
      this.starting = null
    })

    await this.starting
    if (!this.proc) throw new Error('Windows desktop helper failed to stay active.')
    return this.proc
  }

  private request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = this.queue.then(async () => {
      const child = await this.ensureStarted()
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending?.reject === reject) {
            this.pending = null
          }
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          reject(new Error(`Desktop operation "${String(payload.op)}" timed out.`))
        }, 12_000)
        this.pending = { resolve, reject, timer }
        child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8')
      })
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
