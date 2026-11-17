// Offline React/JSX/TSX + Recharts + utility CSS sandbox host builder.
// Runs entirely offline inside an isolated <iframe sandbox="allow-scripts"> with connect-src 'none'.

export const ARTIFACT_META_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: https: blob:; font-src data:; connect-src 'none';"

const TAILWIND_OFFLINE_CSS = `
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --bg:#ffffff;--surface:#faf8f5;--surface-2:#f3efe9;--ink:#1d1b18;--muted:#6d665c;--border:#e4ddd2;--accent:#c46342;--accent-soft:rgba(196,99,66,0.12);
  }
  [data-theme="dark"]{
    --bg:#181614;--surface:#201d1a;--surface-2:#282420;--ink:#eee8e0;--muted:#a0978c;--border:#342e28;--accent:#de7e5c;--accent-soft:rgba(222,126,92,0.16);
  }
  html,body{margin:0;padding:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei UI',sans-serif;line-height:1.5;font-size:14px}
  #root{padding:18px;max-width:100%}
  .artifact-err-box{border:1px solid #ef4444;background:rgba(239,68,68,0.08);color:#dc2626;border-radius:10px;padding:12px 14px;font-size:13px}
  [data-theme="dark"] .artifact-err-box{color:#fca5a5}
  .artifact-err-box pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:12px}
  button{cursor:pointer;font:inherit}
  input,select,textarea{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 10px}
  table{width:100%;border-collapse:collapse}
  th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}
  .card-header{margin-bottom:10px}.card-title{margin:0;font-size:15px;font-weight:600}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--ink)}
  .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500;background:var(--surface-2);color:var(--ink)}
  /* Layout & Spacing */
  .block{display:block}.inline{display:inline}.inline-block{display:inline-block}.hidden{display:none}
  .flex{display:flex}.inline-flex{display:inline-flex}.grid{display:grid}
  .flex-col{flex-direction:column}.flex-row{flex-direction:row}.flex-wrap{flex-wrap:wrap}.flex-1{flex:1 1 0%}.shrink-0{flex-shrink:0}
  .items-start{align-items:flex-start}.items-center{align-items:center}.items-end{align-items:flex-end}.items-baseline{align-items:baseline}
  .justify-start{justify-content:flex-start}.justify-center{justify-content:center}.justify-end{justify-content:flex-end}.justify-between{justify-content:space-between}
  .grid-cols-1{grid-template-columns:repeat(1,minmax(0,1fr))}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}
  @media(min-width:640px){.sm\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.sm\\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}}
  @media(min-width:768px){.md\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.md\\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.md\\:grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}}
  @media(min-width:1024px){.lg\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.lg\\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.lg\\:grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}}
  .col-span-2{grid-column:span 2 / span 2}.col-span-3{grid-column:span 3 / span 3}
  .gap-1{gap:4px}.gap-1\\.5{gap:6px}.gap-2{gap:8px}.gap-3{gap:12px}.gap-4{gap:16px}.gap-5{gap:20px}.gap-6{gap:24px}.gap-8{gap:32px}
  .space-y-1>*+*{margin-top:4px}.space-y-2>*+*{margin-top:8px}.space-y-3>*+*{margin-top:12px}.space-y-4>*+*{margin-top:16px}.space-y-6>*+*{margin-top:24px}
  .space-x-2>*+*{margin-left:8px}.space-x-3>*+*{margin-left:12px}
  .p-1{padding:4px}.p-2{padding:8px}.p-3{padding:12px}.p-4{padding:16px}.p-5{padding:20px}.p-6{padding:24px}.p-8{padding:32px}
  .px-2{padding-left:8px;padding-right:8px}.px-3{padding-left:12px;padding-right:12px}.px-4{padding-left:16px;padding-right:16px}.px-5{padding-left:20px;padding-right:20px}.px-6{padding-left:24px;padding-right:24px}
  .py-1{padding-top:4px;padding-bottom:4px}.py-1\\.5{padding-top:6px;padding-bottom:6px}.py-2{padding-top:8px;padding-bottom:8px}.py-3{padding-top:12px;padding-bottom:12px}.py-4{padding-top:16px;padding-bottom:16px}
  .m-0{margin:0}.mx-auto{margin-left:auto;margin-right:auto}.mb-1{margin-bottom:4px}.mb-2{margin-bottom:8px}.mb-3{margin-bottom:12px}.mb-4{margin-bottom:16px}.mb-6{margin-bottom:24px}.mt-1{margin-top:4px}.mt-2{margin-top:8px}.mt-3{margin-top:12px}.mt-4{margin-top:16px}.mt-6{margin-top:24px}
  .w-full{width:100%}.h-full{height:100%}.min-h-screen{min-height:100vh}.max-w-4xl{max-width:56rem}.max-w-5xl{max-width:64rem}.max-w-6xl{max-width:72rem}
  .h-2{height:8px}.h-3{height:12px}.h-4{height:16px}.h-6{height:24px}.h-8{height:32px}.h-10{height:40px}.h-64{height:256px}.h-72{height:288px}.h-80{height:320px}.h-96{height:384px}
  .w-2{width:8px}.w-3{width:12px}.w-4{width:16px}.w-6{width:24px}.w-8{width:32px}.w-10{width:40px}
  /* Typography */
  .text-xs{font-size:12px;line-height:1.35}.text-sm{font-size:13px;line-height:1.45}.text-base{font-size:14px}.text-lg{font-size:16px;line-height:1.4}.text-xl{font-size:18px;line-height:1.35}.text-2xl{font-size:22px;line-height:1.25}.text-3xl{font-size:28px;line-height:1.2}
  .font-normal{font-weight:400}.font-medium{font-weight:500}.font-semibold{font-weight:600}.font-bold{font-weight:700}.font-mono{font-family:ui-monospace,Consolas,monospace}
  .text-left{text-align:left}.text-center{text-align:center}.text-right{text-align:right}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* Borders & Surfaces */
  .border{border:1px solid var(--border)}.border-t{border-top:1px solid var(--border)}.border-b{border-bottom:1px solid var(--border)}.border-l-4{border-left:4px solid var(--accent)}
  .rounded{border-radius:4px}.rounded-md{border-radius:6px}.rounded-lg{border-radius:8px}.rounded-xl{border-radius:12px}.rounded-2xl{border-radius:16px}.rounded-full{border-radius:9999px}
  .shadow-sm{box-shadow:0 1px 2px rgba(0,0,0,0.06)}.shadow{box-shadow:0 2px 8px rgba(0,0,0,0.08)}.shadow-md{box-shadow:0 4px 14px rgba(0,0,0,0.1)}
  .overflow-hidden{overflow:hidden}.overflow-x-auto{overflow-x:auto}.transition{transition:all .15s ease}.cursor-pointer{cursor:pointer}
  /* Palette Utilities */
  .bg-white,.bg-background,.bg-card{background:var(--surface)}
  .bg-slate-50,.bg-gray-50,.bg-zinc-50,.bg-neutral-50,.bg-stone-50{background:var(--surface)}
  .bg-slate-100,.bg-gray-100,.bg-zinc-100,.bg-neutral-100{background:var(--surface-2)}
  .bg-slate-800,.bg-slate-900,.bg-gray-900,.bg-zinc-900{background:#18181b;color:#f4f4f5}
  .bg-blue-50{background:rgba(59,130,246,0.1)}.bg-blue-500,.bg-blue-600{background:#2563eb;color:#fff}
  .bg-indigo-50{background:rgba(99,102,241,0.1)}.bg-indigo-600{background:#4f46e5;color:#fff}
  .bg-emerald-50,.bg-green-50{background:rgba(16,185,129,0.12)}.bg-emerald-500,.bg-emerald-600,.bg-green-600{background:#059669;color:#fff}
  .bg-amber-50,.bg-yellow-50{background:rgba(245,158,11,0.12)}.bg-amber-500{background:#d97706;color:#fff}
  .bg-rose-50,.bg-red-50{background:rgba(239,68,68,0.12)}.bg-rose-500,.bg-red-500,.bg-red-600{background:#dc2626;color:#fff}
  .bg-orange-50{background:rgba(234,88,12,0.12)}.bg-orange-600{background:#ea580c;color:#fff}
  .bg-violet-50,.bg-purple-50{background:rgba(139,92,246,0.12)}.bg-violet-600,.bg-purple-600{background:#7c3aed;color:#fff}
  .text-white{color:#fff}
  .text-slate-900,.text-gray-900,.text-zinc-900{color:var(--ink)}
  .text-slate-700,.text-slate-800,.text-gray-700,.text-gray-800{color:var(--ink)}
  .text-slate-500,.text-slate-600,.text-gray-500,.text-gray-600,.text-muted-foreground{color:var(--muted)}
  .text-slate-400,.text-gray-400{color:var(--muted)}
  .text-blue-600,.text-blue-500{color:#3b82f6}.text-indigo-600{color:#6366f1}
  .text-emerald-600,.text-green-600,.text-green-500{color:#10b981}
  .text-amber-600,.text-yellow-600{color:#d97706}
  .text-rose-600,.text-red-600,.text-red-500{color:#ef4444}
  .text-orange-600{color:#ea580c}.text-purple-600,.text-violet-600{color:#8b5cf6}
  .border-slate-200,.border-gray-200,.border-zinc-200{border-color:var(--border)}
  .border-blue-200{border-color:rgba(59,130,246,0.35)}.border-emerald-200{border-color:rgba(16,185,129,0.35)}
  .border-amber-200{border-color:rgba(245,158,11,0.35)}.border-rose-200,.border-red-200{border-color:rgba(239,68,68,0.35)}
`

export function buildReactArtifactHtml(source: string, runtimeBundle: string, dark: boolean): string {
  const safeRuntime = runtimeBundle.replace(/<\/(script)/gi, '<\\/$1')
  const safeSourceJson = JSON.stringify(source).replace(/<\/(script)/gi, '<\\/$1')
  return `<!doctype html>
<html data-theme="${dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_META_CSP}" />
<style>${TAILWIND_OFFLINE_CSS}</style>
</head>
<body>
<div id="root"></div>
<script>${safeRuntime}</script>
<script>
(function(){
  var mount = document.getElementById('root');
  try {
    var rt = window.__ATRIUM_REACT_RUNTIME__;
    if (!rt || typeof rt.renderArtifact !== 'function') {
      throw new Error('Atrium React sandbox runtime failed to initialize.');
    }
    rt.renderArtifact(${safeSourceJson}, mount);
  } catch (err) {
    var box = document.createElement('div');
    box.className = 'artifact-err-box';
    var strong = document.createElement('strong');
    strong.textContent = 'Component compile / runtime error';
    var pre = document.createElement('pre');
    pre.textContent = err && (err.stack || err.message) ? String(err.stack || err.message) : String(err);
    box.appendChild(strong);
    box.appendChild(pre);
    mount.innerHTML = '';
    mount.appendChild(box);
  }
})();
</script>
</body>
</html>`
}
