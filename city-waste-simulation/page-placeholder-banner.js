/**
 * Shows a high-visibility banner when a page is UI-only or partially wired.
 * Set on <body>: data-besse-placeholder="prototype" | "partial"
 */
(function () {
  function run() {
    const mode = document.body && document.body.getAttribute('data-besse-placeholder');
    if (!mode) return;

    const html =
      mode === 'partial'
        ? '<strong class="font-extrabold">部分流程為占位</strong> — 「发往 Broker」等请求尚未与服务器完整同步，预算、CO₂ 可能不会随按钮立即变化；库存总览与状态条仍以 <span class="font-mono text-xs bg-white/70 px-1 rounded border border-amber-200/90">/state</span> 为准。'
        : '<strong class="font-extrabold">界面原型 · 未接通玩法</strong> — 版式预览页：摘要中的数字多为静态示例，「送出」等操作<strong>不会</strong>改变局内状态。进行游戏请从 Hub 选单进入已接线页面（如 Broker 的 <span class="font-mono text-xs bg-white/70 px-1 rounded border border-amber-200/90">Inventory</span>、<span class="font-mono text-xs bg-white/70 px-1 rounded border border-amber-200/90">Transportation</span>；MRF 的 <span class="font-mono text-xs bg-white/70 px-1 rounded border border-amber-200/90">Inventory</span>）。';

    const wrap = document.createElement('div');
    wrap.className = 'besse-placeholder-banner mx-auto max-w-7xl px-6 pt-3 pb-0';
    wrap.setAttribute('role', 'status');
    wrap.innerHTML =
      '<div class="rounded-xl border border-amber-400/90 bg-amber-50 px-4 py-3 text-sm text-amber-950 leading-relaxed shadow-sm">' +
      html +
      '</div>';

    const first = document.body.firstElementChild;
    if (first) document.body.insertBefore(wrap, first);
    else document.body.appendChild(wrap);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
