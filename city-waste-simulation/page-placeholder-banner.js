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
        ? '<strong class="font-extrabold">Some flows are placeholders</strong> — Requests like "Send to Broker" are not fully synchronized with the server yet, so budget/CO₂ may not change immediately when you click. Inventory summaries and status bars are still based on <span class="font-mono text-xs bg-white/70 px-1 rounded border border-amber-200/90">/state</span>.'
        : '<strong class="font-extrabold">UI prototype · Gameplay not wired</strong> — Layout preview page: most numbers in the summary are static examples, and actions like "Send" <strong>will not</strong> change the in-game state. To play, use the Hub menu to open wired pages (e.g. Broker <span class="font-mono text-xs bg-white/70 px-1 rounded border border-amber-200/90">Inventory</span> / <span class="font-mono text-xs bg-white/70 px-1 rounded border border-amber-200/90">Transportation</span>, and MRF <span class="font-mono text-xs bg-white/70 px-1 rounded border border-amber-200/90">Inventory</span>).';

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
