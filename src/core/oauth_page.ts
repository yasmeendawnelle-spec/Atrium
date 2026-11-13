// Shared Atrium Studio-styled HTML page returned on local OAuth loopback callbacks.

function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Render a polished OAuth completion or error page matching Atrium Studio's aesthetic. */
export function renderAtriumOAuthPage(opts: {
  ok: boolean
  title: string
  heading: string
  message: string
  providerLabel?: string
}): string {
  const pillText = opts.ok ? '授权验证完成' : '授权未完成'
  const pillIcon = opts.ok
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
  const eyebrow = opts.providerLabel ? `Atrium Studio · ${escapeHtml(opts.providerLabel)}` : 'Atrium Studio'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Atrium · ${escapeHtml(opts.title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg-shell: #f1eee7;
      --surface: #ffffff;
      --subtle: #f2efe8;
      --ink: #22211f;
      --ink-2: #4a4843;
      --muted: #78756e;
      --line: rgba(34, 33, 31, 0.085);
      --accent: #c46342;
      --accent-hover: #b35536;
      --ok: #2e7a52;
      --ok-tint: rgba(46, 122, 82, 0.11);
      --danger: #ba3e35;
      --danger-tint: rgba(186, 62, 53, 0.11);
      --shadow: 0 24px 64px -16px rgba(28, 25, 20, 0.15), 0 2px 10px rgba(28, 25, 20, 0.04);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg-shell: #151513;
        --surface: #1e1e1b;
        --subtle: #272623;
        --ink: #edece6;
        --ink-2: #c7c5bc;
        --muted: #949188;
        --line: rgba(255, 255, 255, 0.085);
        --accent: #ce6e4e;
        --accent-hover: #da7b5b;
        --ok: #6ec295;
        --ok-tint: rgba(110, 194, 149, 0.14);
        --danger: #f08a82;
        --danger-tint: rgba(240, 138, 130, 0.14);
        --shadow: 0 28px 72px -16px rgba(0, 0, 0, 0.56), 0 2px 10px rgba(0, 0, 0, 0.25);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background:
        radial-gradient(880px 480px at 50% -8%, rgba(196, 99, 66, 0.13), transparent 62%),
        radial-gradient(640px 420px at 85% 108%, rgba(196, 99, 66, 0.07), transparent 60%),
        var(--bg-shell);
      color: var(--ink);
      font-family: 'Albert Sans', 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei UI', system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .sheet {
      width: 100%;
      max-width: 448px;
      padding: 36px 34px 30px;
      border-radius: 22px;
      background: var(--surface);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      text-align: center;
      animation: rise .38s cubic-bezier(0.2, 0.7, 0.2, 1) both;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(10px) scale(0.985); }
      to { opacity: 1; transform: none; }
    }
    @keyframes floatCore {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-1px); }
    }
    .brand-badge {
      width: 52px;
      height: 52px;
      margin: 0 auto 16px;
      border-radius: 15px;
      background: var(--subtle);
      border: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);
    }
    .oculus-core {
      animation: floatCore 3.2s ease-in-out infinite;
    }
    .eyebrow {
      margin: 0 0 12px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 14px;
      background: ${opts.ok ? 'var(--ok-tint)' : 'var(--danger-tint)'};
      color: ${opts.ok ? 'var(--ok)' : 'var(--danger)'};
    }
    h1 {
      margin: 0 0 10px;
      font-size: 22px;
      font-weight: 650;
      letter-spacing: -0.015em;
      color: var(--ink);
    }
    .desc {
      margin: 0 0 22px;
      font-size: 14px;
      line-height: 1.65;
      color: var(--ink-2);
    }
    .detail-box {
      margin: 0 0 22px;
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--subtle);
      border: 1px solid var(--line);
      font-size: 12.5px;
      color: var(--muted);
      line-height: 1.55;
    }
    .actions {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .btn {
      width: 100%;
      appearance: none;
      border: none;
      cursor: pointer;
      padding: 11px 18px;
      border-radius: 11px;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      background: var(--accent);
      color: #ffffff;
      transition: background 0.16s ease, transform 0.12s ease;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn:active { transform: scale(0.985); }
    .kbd-hint {
      font-size: 12px;
      color: var(--muted);
    }
    kbd {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 5px;
      background: var(--subtle);
      border: 1px solid var(--line);
      color: var(--ink-2);
    }
  </style>
</head>
<body>
  <main class="sheet">
    <div class="brand-badge">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="at-ga" x1="7" y1="2" x2="20" y2="11" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#F7B796"/><stop offset="100%" stop-color="#DE7B58"/>
          </linearGradient>
          <linearGradient id="at-gb" x1="20" y1="9" x2="9" y2="21" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#DF7A55"/><stop offset="100%" stop-color="#B55132"/>
          </linearGradient>
          <linearGradient id="at-gc" x1="9" y1="20" x2="6" y2="5" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#C05837"/><stop offset="100%" stop-color="#89341B"/>
          </linearGradient>
        </defs>
        <g>
          <path d="M 6.63 5.1 L 10.61 2.8 Q 12 2 13.39 2.8 L 19.45 6.3 Q 20.66 7 20.66 8.4 L 20.66 9.2 L 17.2 11.2 L 17.2 9 L 12 6 L 10.09 7.1 Z" fill="url(#at-ga)"/>
          <path d="M 6.63 5.1 L 10.61 2.8 Q 12 2 13.39 2.8 L 19.45 6.3 Q 20.66 7 20.66 8.4 L 20.66 9.2 L 17.2 11.2 L 17.2 9 L 12 6 L 10.09 7.1 Z" fill="url(#at-gb)" transform="rotate(120 12 12)"/>
          <path d="M 6.63 5.1 L 10.61 2.8 Q 12 2 13.39 2.8 L 19.45 6.3 Q 20.66 7 20.66 8.4 L 20.66 9.2 L 17.2 11.2 L 17.2 9 L 12 6 L 10.09 7.1 Z" fill="url(#at-gc)" transform="rotate(240 12 12)"/>
        </g>
        <g class="oculus-core">
          <path d="M 12 7.2 L 8.15 13.5 L 12 11.95 Z" fill="#FAD0BA"/>
          <path d="M 12 7.2 L 15.85 13.5 L 12 11.95 Z" fill="#D46B48"/>
          <path d="M 8.15 13.5 L 12 11.95 L 15.85 13.5 L 12 16.3 Z" fill="#923A20"/>
        </g>
      </svg>
    </div>
    <p class="eyebrow">${eyebrow}</p>
    <div class="status-pill">${pillIcon}<span>${pillText}</span></div>
    <h1>${escapeHtml(opts.heading)}</h1>
    <p class="desc">${escapeHtml(opts.message)}</p>
    <div class="detail-box" id="tip">
      ${
        opts.ok
          ? '登录状态已安全同步至 Atrium 桌面客户端，现在可以切回 Atrium 开始对话与工作啦。'
          : '未能完成本次授权，请关闭此页面后回到 Atrium 重新点击登录。'
      }
    </div>
    <div class="actions">
      <button type="button" class="btn" id="close-btn">关闭此页面</button>
      <span class="kbd-hint">若浏览器拦截脚本关闭窗口，可按 <kbd>Ctrl</kbd> + <kbd>W</kbd> 或直接关闭标签页</span>
    </div>
  </main>
  <script>
    (function () {
      var ok = ${opts.ok ? 'true' : 'false'};
      var btn = document.getElementById('close-btn');
      var tip = document.getElementById('tip');
      function tryClose() {
        try { window.open('', '_self'); } catch (e) {}
        try { window.close(); } catch (e) {}
      }
      if (ok) {
        setTimeout(tryClose, 350);
      }
      btn.addEventListener('click', function () {
        tryClose();
        setTimeout(function () {
          tip.textContent = 'Atrium 桌面窗口已自动回到前台；若浏览器安全策略阻止脚本自动关闭本标签页，直接手动关闭此页即可。';
        }, 180);
      });
    })();
  </script>
</body>
</html>`
}
