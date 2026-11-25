// Cross-platform OS desktop automation driver:
// - Windows: persistent DPI-aware C# SendInput + EnumWindows worker over PowerShell
// - macOS: CoreGraphics / ApplicationServices via `osascript -l JavaScript` (JXA)
// - Linux: X11 / XWayland automation via `xdotool` (and optional `wmctrl` for window states)
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { DesktopMouseAction, DesktopWindowInfo } from '../shared/types.ts'

const execFileAsync = promisify(execFile)

export interface VirtualKeySpec {
  vk: number
  extended: boolean
  name: string
}

export interface MacKeySpec {
  keyCode?: number
  modifier?: 'cmd' | 'ctrl' | 'alt' | 'shift'
  name: string
}

const MAC_LETTER_KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32,
  i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
}

const MAC_DIGIT_KEYCODES: Record<string, number> = {
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21,
  '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
}

const MAC_FUNCTION_KEYCODES: readonly number[] = [
  122, 120, 99, 118, 96, 97, 98, 100, 101, 109,
  103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
]

const MAC_NAMED_KEYS: Record<string, { keyCode?: number; modifier?: 'cmd' | 'ctrl' | 'alt' | 'shift' }> = {
  cmd: { keyCode: 55, modifier: 'cmd' },
  command: { keyCode: 55, modifier: 'cmd' },
  meta: { keyCode: 55, modifier: 'cmd' },
  super: { keyCode: 55, modifier: 'cmd' },
  win: { keyCode: 55, modifier: 'cmd' },
  lwin: { keyCode: 55, modifier: 'cmd' },
  rwin: { keyCode: 54, modifier: 'cmd' },
  ctrl: { keyCode: 59, modifier: 'ctrl' },
  control: { keyCode: 59, modifier: 'ctrl' },
  lctrl: { keyCode: 59, modifier: 'ctrl' },
  rctrl: { keyCode: 62, modifier: 'ctrl' },
  alt: { keyCode: 58, modifier: 'alt' },
  option: { keyCode: 58, modifier: 'alt' },
  menu: { keyCode: 58, modifier: 'alt' },
  shift: { keyCode: 56, modifier: 'shift' },
  enter: { keyCode: 36 },
  return: { keyCode: 36 },
  tab: { keyCode: 48 },
  space: { keyCode: 49 },
  spacebar: { keyCode: 49 },
  esc: { keyCode: 53 },
  escape: { keyCode: 53 },
  backspace: { keyCode: 51 },
  bs: { keyCode: 51 },
  delete: { keyCode: 117 },
  del: { keyCode: 117 },
  insert: { keyCode: 114 },
  ins: { keyCode: 114 },
  home: { keyCode: 115 },
  end: { keyCode: 119 },
  pageup: { keyCode: 116 },
  pgup: { keyCode: 116 },
  prior: { keyCode: 116 },
  pagedown: { keyCode: 121 },
  pgdn: { keyCode: 121 },
  next: { keyCode: 121 },
  up: { keyCode: 126 },
  arrowup: { keyCode: 126 },
  down: { keyCode: 125 },
  arrowdown: { keyCode: 125 },
  left: { keyCode: 123 },
  arrowleft: { keyCode: 123 },
  right: { keyCode: 124 },
  arrowright: { keyCode: 124 },
  capslock: { keyCode: 57 },
  '-': { keyCode: 27 },
  minus: { keyCode: 27 },
  '=': { keyCode: 24 },
  equal: { keyCode: 24 },
  plus: { keyCode: 24 },
  '[': { keyCode: 33 },
  ']': { keyCode: 30 },
  '\\': { keyCode: 42 },
  ';': { keyCode: 41 },
  "'": { keyCode: 39 },
  ',': { keyCode: 43 },
  '.': { keyCode: 47 },
  '/': { keyCode: 44 },
  '`': { keyCode: 50 },
  backquote: { keyCode: 50 },
}

/** Maps a human-friendly key token to its macOS ANSI virtual keycode and/or modifier flag. */
export function resolveMacKeySpec(raw: string): MacKeySpec | null {
  const token = raw.trim()
  if (!token) return null
  const lower = token.toLowerCase()
  if (lower === ' ') return { keyCode: 49, name: 'space' }
  const named = MAC_NAMED_KEYS[lower]
  if (named) return { ...named, name: lower }
  const fMatch = /^f([1-9]|1[0-9]|20)$/.exec(lower)
  if (fMatch) {
    const code = MAC_FUNCTION_KEYCODES[Number(fMatch[1]) - 1]
    if (code !== undefined) return { keyCode: code, name: lower }
  }
  const letterCode = MAC_LETTER_KEYCODES[lower]
  if (letterCode !== undefined) return { keyCode: letterCode, name: lower }
  const digitCode = MAC_DIGIT_KEYCODES[lower]
  if (digitCode !== undefined) return { keyCode: digitCode, name: lower }
  return null
}

/** Resolves a key name or hotkey chord (e.g. `["cmd", "shift", "p"]`) for macOS. */
export function resolveMacKeyChord(keys: string[]): MacKeySpec[] {
  const out: MacKeySpec[] = []
  for (const raw of keys) {
    const parts = raw.includes('+') && raw.length > 1 ? raw.split('+') : [raw]
    for (const part of parts) {
      const spec = resolveMacKeySpec(part)
      if (!spec) throw new Error(`Unsupported macOS key "${part}".`)
      out.push(spec)
    }
  }
  if (out.length === 0) throw new Error('At least one key is required.')
  return out
}

const LINUX_KEYSYMS: Record<string, string> = {
  ctrl: 'Control_L',
  control: 'Control_L',
  lctrl: 'Control_L',
  rctrl: 'Control_R',
  alt: 'Alt_L',
  option: 'Alt_L',
  menu: 'Menu',
  shift: 'Shift_L',
  cmd: 'Super_L',
  command: 'Super_L',
  meta: 'Super_L',
  super: 'Super_L',
  win: 'Super_L',
  lwin: 'Super_L',
  rwin: 'Super_R',
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  space: 'space',
  spacebar: 'space',
  backspace: 'BackSpace',
  bs: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pgup: 'Prior',
  prior: 'Prior',
  pagedown: 'Next',
  pgdn: 'Next',
  next: 'Next',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  capslock: 'Caps_Lock',
  numlock: 'Num_Lock',
  scrolllock: 'Scroll_Lock',
  printscreen: 'Print',
  prtsc: 'Print',
  snapshot: 'Print',
  pause: 'Pause',
  '-': 'minus',
  minus: 'minus',
  '=': 'equal',
  equal: 'equal',
  plus: 'plus',
  '[': 'bracketleft',
  ']': 'bracketright',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'apostrophe',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  '`': 'grave',
  backquote: 'grave',
}

/** Maps a human-friendly key token to its X11 `xdotool` keysym string. */
export function resolveLinuxKeySym(raw: string): string | null {
  const token = raw.trim()
  if (!token) return null
  const lower = token.toLowerCase()
  if (lower === ' ') return 'space'
  const named = LINUX_KEYSYMS[lower]
  if (named) return named
  const fMatch = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
  if (fMatch) return `F${fMatch[1]}`
  if (/^[a-z0-9]$/.test(lower)) return lower
  return null
}

/** Resolves a key name or hotkey array (e.g. `["ctrl", "shift", "s"]`) to an xdotool combo string. */
export function resolveLinuxKeyCombo(keys: string[]): string {
  const out: string[] = []
  for (const raw of keys) {
    const parts = raw.includes('+') && raw.length > 1 ? raw.split('+') : [raw]
    for (const part of parts) {
      const sym = resolveLinuxKeySym(part)
      if (!sym) throw new Error(`Unsupported Linux keysym "${part}".`)
      out.push(sym)
    }
  }
  if (out.length === 0) throw new Error('At least one key is required.')
  return out.join('+')
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

const MAC_JXA_DRIVER_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
ObjC.import('AppKit');
ObjC.import('Foundation');

function modMask(mods) {
  var mask = 0;
  for (var i = 0; i < mods.length; i++) {
    if (mods[i] === 'cmd') mask |= $.kCGEventFlagMaskCommand;
    else if (mods[i] === 'ctrl') mask |= $.kCGEventFlagMaskControl;
    else if (mods[i] === 'alt') mask |= $.kCGEventFlagMaskAlternate;
    else if (mods[i] === 'shift') mask |= $.kCGEventFlagMaskShift;
  }
  return mask;
}

function sendMouse(type, x, y, btn) {
  var pt = $.CGPointMake(x, y);
  var ev = $.CGEventCreateMouseEvent(null, type, pt, btn);
  if (ev) {
    $.CGEventPost($.kCGHIDEventTap, ev);
  }
}

function run() {
  var raw = $.NSProcessInfo.processInfo.environment.objectForKey('ATRIUM_MAC_OP');
  var req = JSON.parse(ObjC.unwrap(raw));
  var op = req.op;

  if (op === 'cursor') {
    var ev = $.CGEventCreate(null);
    var pt = $.CGEventGetLocation(ev);
    return JSON.stringify({ ok: true, x: Math.round(pt.x), y: Math.round(pt.y) });
  }

  if (op === 'windows') {
    var frontApp = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    var frontPid = frontApp ? Number(frontApp.processIdentifier) : -1;
    var listRef = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
    var items = ObjC.deepUnwrap(listRef) || [];
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var w = items[i];
      if (!w || Number(w.kCGWindowLayer || 0) !== 0) continue;
      var b = w.kCGWindowBounds || {};
      var width = Math.round(Number(b.Width || 0));
      var height = Math.round(Number(b.Height || 0));
      if (width < 40 || height < 40) continue;
      var owner = String(w.kCGWindowOwnerName || '');
      var title = String(w.kCGWindowName || owner || '');
      if (!title) continue;
      var pid = Number(w.kCGWindowOwnerPID || 0);
      out.push({
        hwnd: String(w.kCGWindowNumber || pid || 0),
        title: title,
        processName: owner,
        pid: pid,
        x: Math.round(Number(b.X || 0)),
        y: Math.round(Number(b.Y || 0)),
        width: width,
        height: height,
        minimized: false,
        maximized: false,
        foreground: pid === frontPid
      });
    }
    return JSON.stringify({ ok: true, windows: out });
  }

  if (!$.AXIsProcessTrusted()) {
    return JSON.stringify({
      ok: false,
      error: 'macOS Accessibility permission is required for OS desktop control. Enable Atrium in System Settings -> Privacy & Security -> Accessibility.'
    });
  }

  if (op === 'mouse') {
    var act = String(req.action || 'move');
    var x = Number(req.x || 0);
    var y = Number(req.y || 0);
    var button = String(req.button || 'left');
    var cgBtn = button === 'right' ? $.kCGMouseButtonRight : button === 'middle' ? $.kCGMouseButtonCenter : $.kCGMouseButtonLeft;
    var downType = button === 'right' ? $.kCGEventRightMouseDown : button === 'middle' ? $.kCGEventOtherMouseDown : $.kCGEventLeftMouseDown;
    var upType = button === 'right' ? $.kCGEventRightMouseUp : button === 'middle' ? $.kCGEventOtherMouseUp : $.kCGEventLeftMouseUp;

    sendMouse($.kCGEventMouseMoved, x, y, $.kCGMouseButtonLeft);
    delay(0.012);
    if (act === 'move') {
      return JSON.stringify({ ok: true });
    }
    if (act === 'click' || act === 'right_click' || act === 'middle_click') {
      var b = act === 'right_click' ? $.kCGMouseButtonRight : act === 'middle_click' ? $.kCGMouseButtonCenter : cgBtn;
      var dt = act === 'right_click' ? $.kCGEventRightMouseDown : act === 'middle_click' ? $.kCGEventOtherMouseDown : downType;
      var ut = act === 'right_click' ? $.kCGEventRightMouseUp : act === 'middle_click' ? $.kCGEventOtherMouseUp : upType;
      sendMouse(dt, x, y, b);
      delay(0.015);
      sendMouse(ut, x, y, b);
      return JSON.stringify({ ok: true });
    }
    if (act === 'double_click') {
      var pt = $.CGPointMake(x, y);
      for (var c = 1; c <= 2; c++) {
        var dEv = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
        $.CGEventSetIntegerValueField(dEv, $.kCGMouseEventClickState, c);
        $.CGEventPost($.kCGHIDEventTap, dEv);
        var uEv = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
        $.CGEventSetIntegerValueField(uEv, $.kCGMouseEventClickState, c);
        $.CGEventPost($.kCGHIDEventTap, uEv);
        delay(0.018);
      }
      return JSON.stringify({ ok: true });
    }
    if (act === 'down') {
      sendMouse(downType, x, y, cgBtn);
      return JSON.stringify({ ok: true });
    }
    if (act === 'up') {
      sendMouse(upType, x, y, cgBtn);
      return JSON.stringify({ ok: true });
    }
    if (act === 'drag') {
      var ex = Number(req.endX || x);
      var ey = Number(req.endY || y);
      sendMouse($.kCGEventLeftMouseDown, x, y, $.kCGMouseButtonLeft);
      delay(0.025);
      var steps = 10;
      for (var s = 1; s <= steps; s++) {
        var cx = x + ((ex - x) * s) / steps;
        var cy = y + ((ey - y) * s) / steps;
        sendMouse($.kCGEventLeftMouseDragged, cx, cy, $.kCGMouseButtonLeft);
        delay(0.01);
      }
      sendMouse($.kCGEventLeftMouseUp, ex, ey, $.kCGMouseButtonLeft);
      return JSON.stringify({ ok: true });
    }
    if (act === 'scroll') {
      var dy = Math.round(Number(req.deltaY || 0) / 12);
      var dx = Math.round(Number(req.deltaX || 0) / 12);
      var sEv = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, -dy, -dx);
      $.CGEventPost($.kCGHIDEventTap, sEv);
      return JSON.stringify({ ok: true });
    }
    return JSON.stringify({ ok: false, error: 'Unsupported macOS mouse action: ' + act });
  }

  if (op === 'type') {
    var text = String(req.text || '');
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      var buf = Ref('uint16');
      buf[0] = code;
      var kDown = $.CGEventCreateKeyboardEvent(null, 0, true);
      $.CGEventKeyboardSetUnicodeString(kDown, 1, buf);
      $.CGEventPost($.kCGHIDEventTap, kDown);
      var kUp = $.CGEventCreateKeyboardEvent(null, 0, false);
      $.CGEventKeyboardSetUnicodeString(kUp, 1, buf);
      $.CGEventPost($.kCGHIDEventTap, kUp);
      delay(0.004);
    }
    return JSON.stringify({ ok: true });
  }

  if (op === 'chord') {
    var specs = req.specs || [];
    var mods = [];
    var keys = [];
    for (var i = 0; i < specs.length; i++) {
      if (specs[i].modifier) mods.push(specs[i].modifier);
      else if (typeof specs[i].keyCode === 'number') keys.push(specs[i].keyCode);
    }
    var flags = modMask(mods);
    if (keys.length === 0 && mods.length > 0 && typeof specs[0].keyCode === 'number') {
      keys.push(specs[0].keyCode);
    }
    for (var i = 0; i < keys.length; i++) {
      var kd = $.CGEventCreateKeyboardEvent(null, keys[i], true);
      if (flags) $.CGEventSetFlags(kd, flags);
      $.CGEventPost($.kCGHIDEventTap, kd);
      delay(0.01);
    }
    for (var i = keys.length - 1; i >= 0; i--) {
      var ku = $.CGEventCreateKeyboardEvent(null, keys[i], false);
      if (flags) $.CGEventSetFlags(ku, flags);
      $.CGEventPost($.kCGHIDEventTap, ku);
      delay(0.01);
    }
    return JSON.stringify({ ok: true });
  }

  if (op === 'focus' || op === 'windowState') {
    var targetId = String(req.hwnd || '');
    var listRef2 = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
    var items2 = ObjC.deepUnwrap(listRef2) || [];
    var targetPid = 0;
    var ownerName = '';
    for (var i = 0; i < items2.length; i++) {
      var w2 = items2[i];
      if (String(w2.kCGWindowNumber || '') === targetId) {
        targetPid = Number(w2.kCGWindowOwnerPID || 0);
        ownerName = String(w2.kCGWindowOwnerName || '');
        break;
      }
    }
    if (!targetPid && Number(targetId) > 0) targetPid = Number(targetId);
    if (!targetPid) return JSON.stringify({ ok: false });
    var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(targetPid);
    if (running) running.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
    if (op === 'windowState' && ownerName) {
      var se = Application('System Events');
      var proc = se.processes.byName(ownerName);
      if (proc && proc.windows.length > 0) {
        var win = proc.windows[0];
        if (req.state === 'minimize') win.attributes.byName('AXMinimized').value = true;
        else if (req.state === 'restore') win.attributes.byName('AXMinimized').value = false;
        else if (req.state === 'maximize') {
          try { win.attributes.byName('AXFullScreen').value = true; } catch (e) {}
        }
      }
    }
    return JSON.stringify({ ok: true });
  }

  return JSON.stringify({ ok: false, error: 'Unknown op: ' + op });
}
run();
`

async function runMacDesktopOp(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', MAC_JXA_DRIVER_SCRIPT], {
    env: { ...process.env, ATRIUM_MAC_OP: JSON.stringify(payload) },
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const line = stdout.trim().split(/\r?\n/).pop()?.trim() || '{}'
  const parsed = JSON.parse(line) as Record<string, unknown>
  if (parsed.ok === false && typeof parsed.error === 'string' && parsed.error) {
    throw new Error(parsed.error)
  }
  return parsed
}

async function execXdotool(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('xdotool', args, { timeout: 12_000, maxBuffer: 2 * 1024 * 1024 })
    return stdout
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('Linux desktop automation requires "xdotool" on X11/XWayland (e.g. "sudo apt install xdotool").')
    }
    throw err
  }
}

export class DesktopWorker {
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
    if (process.platform === 'darwin') {
      const res = await runMacDesktopOp({ op: 'cursor' })
      return { x: Number(res.x ?? 0), y: Number(res.y ?? 0) }
    }
    if (process.platform === 'linux') {
      const out = await execXdotool(['getmouselocation', '--shell'])
      const xMatch = /^X=(-?\d+)/m.exec(out)
      const yMatch = /^Y=(-?\d+)/m.exec(out)
      return { x: Number(xMatch?.[1] ?? 0), y: Number(yMatch?.[1] ?? 0) }
    }
    const res = await this.request({ op: 'cursor' })
    return { x: Number(res.x ?? 0), y: Number(res.y ?? 0) }
  }

  async listWindows(): Promise<DesktopWindowInfo[]> {
    if (process.platform === 'darwin') {
      const res = await runMacDesktopOp({ op: 'windows' })
      return this.mapWindowRows(res.windows)
    }
    if (process.platform === 'linux') {
      return this.listLinuxWindows()
    }
    const res = await this.request({ op: 'windows' })
    return this.mapWindowRows(res.windows)
  }

  private mapWindowRows(rawInput: unknown): DesktopWindowInfo[] {
    const raw = Array.isArray(rawInput) ? rawInput : []
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

  private async listLinuxWindows(): Promise<DesktopWindowInfo[]> {
    let activeId = ''
    try {
      activeId = (await execXdotool(['getactivewindow'])).trim()
    } catch {
      activeId = ''
    }
    let idsRaw = ''
    try {
      idsRaw = await execXdotool(['search', '--onlyvisible', '--name', '.'])
    } catch {
      return []
    }
    const ids = idsRaw.trim().split(/\s+/).filter(Boolean).slice(0, 40)
    const out: DesktopWindowInfo[] = []
    for (const id of ids) {
      try {
        const [geom, name, pidStr] = await Promise.all([
          execXdotool(['getwindowgeometry', '--shell', id]),
          execXdotool(['getwindowname', id]).catch(() => ''),
          execXdotool(['getwindowpid', id]).catch(() => '0'),
        ])
        const title = name.trim()
        if (!title) continue
        const x = Number(/^X=(-?\d+)/m.exec(geom)?.[1] ?? 0)
        const y = Number(/^Y=(-?\d+)/m.exec(geom)?.[1] ?? 0)
        const width = Number(/^WIDTH=(\d+)/m.exec(geom)?.[1] ?? 0)
        const height = Number(/^HEIGHT=(\d+)/m.exec(geom)?.[1] ?? 0)
        if (width < 40 || height < 40) continue
        out.push({
          hwnd: id,
          title,
          processName: '',
          pid: Number(pidStr.trim()) || 0,
          x,
          y,
          width,
          height,
          minimized: false,
          maximized: false,
          foreground: id === activeId,
        })
      } catch {
        /* window closed while enumerating */
      }
    }
    return out
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
    if (process.platform === 'darwin') {
      await runMacDesktopOp({
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
      return
    }
    if (process.platform === 'linux') {
      await this.runLinuxMouse(opts)
      return
    }
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

  private async runLinuxMouse(opts: {
    action: DesktopMouseAction
    x: number
    y: number
    endX?: number
    endY?: number
    deltaX?: number
    deltaY?: number
    button?: 'left' | 'right' | 'middle'
  }): Promise<void> {
    const x = String(Math.round(opts.x))
    const y = String(Math.round(opts.y))
    const btnNum = opts.button === 'right' ? '3' : opts.button === 'middle' ? '2' : '1'
    await execXdotool(['mousemove', '--sync', x, y])
    switch (opts.action) {
      case 'move':
        return
      case 'click':
        await execXdotool(['click', btnNum])
        return
      case 'double_click':
        await execXdotool(['click', '--repeat', '2', '--delay', '40', '1'])
        return
      case 'right_click':
        await execXdotool(['click', '3'])
        return
      case 'middle_click':
        await execXdotool(['click', '2'])
        return
      case 'down':
        await execXdotool(['mousedown', btnNum])
        return
      case 'up':
        await execXdotool(['mouseup', btnNum])
        return
      case 'drag': {
        const ex = String(Math.round(opts.endX ?? opts.x))
        const ey = String(Math.round(opts.endY ?? opts.y))
        await execXdotool(['mousedown', '1', 'mousemove', '--sync', ex, ey, 'mouseup', '1'])
        return
      }
      case 'scroll': {
        const dy = Math.round(opts.deltaY ?? 0)
        const dx = Math.round(opts.deltaX ?? 0)
        if (dy !== 0) {
          const clicks = Math.max(1, Math.min(12, Math.round(Math.abs(dy) / 100)))
          await execXdotool(['click', '--repeat', String(clicks), dy > 0 ? '5' : '4'])
        }
        if (dx !== 0) {
          const clicks = Math.max(1, Math.min(12, Math.round(Math.abs(dx) / 100)))
          await execXdotool(['click', '--repeat', String(clicks), dx > 0 ? '7' : '6'])
        }
        return
      }
    }
  }

  async typeText(text: string): Promise<void> {
    if (process.platform === 'darwin') {
      await runMacDesktopOp({ op: 'type', text })
      return
    }
    if (process.platform === 'linux') {
      await execXdotool(['type', '--clearmodifiers', '--delay', '4', '--', text])
      return
    }
    await this.request({ op: 'type', text })
  }

  async keyChord(specs: VirtualKeySpec[]): Promise<void> {
    await this.request({
      op: 'chord',
      vks: specs.map((s) => s.vk),
      exts: specs.map((s) => s.extended),
    })
  }

  async keyChordTokens(keys: string[]): Promise<void> {
    if (process.platform === 'darwin') {
      const specs = resolveMacKeyChord(keys)
      await runMacDesktopOp({ op: 'chord', specs })
      return
    }
    if (process.platform === 'linux') {
      const combo = resolveLinuxKeyCombo(keys)
      await execXdotool(['key', '--clearmodifiers', combo])
      return
    }
    const specs = resolveKeyChord(keys)
    await this.keyChord(specs)
  }

  async focusWindow(hwnd: string): Promise<boolean> {
    if (process.platform === 'darwin') {
      const res = await runMacDesktopOp({ op: 'focus', hwnd })
      return Boolean(res.ok)
    }
    if (process.platform === 'linux') {
      await execXdotool(['windowactivate', '--sync', hwnd])
      return true
    }
    const res = await this.request({ op: 'focus', hwnd: Number(hwnd) || 0 })
    return Boolean(res.ok)
  }

  async setWindowState(hwnd: string, state: 'minimize' | 'maximize' | 'restore'): Promise<boolean> {
    if (process.platform === 'darwin') {
      const res = await runMacDesktopOp({ op: 'windowState', hwnd, state })
      return Boolean(res.ok)
    }
    if (process.platform === 'linux') {
      if (state === 'minimize') {
        await execXdotool(['windowminimize', hwnd])
        return true
      }
      const action = state === 'maximize' ? 'add,maximized_vert,maximized_horz' : 'remove,maximized_vert,maximized_horz'
      try {
        await execFileAsync('wmctrl', ['-i', '-r', hwnd, '-b', action], { timeout: 6000 })
      } catch {
        /* wmctrl is optional; still ensure window activation on restore */
      }
      if (state === 'restore') {
        await execXdotool(['windowactivate', '--sync', hwnd])
      }
      return true
    }
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
      throw new Error(`Windows PowerShell desktop worker was invoked on unsupported platform (${process.platform}).`)
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

export { DesktopWorker as WinDesktopWorker }
