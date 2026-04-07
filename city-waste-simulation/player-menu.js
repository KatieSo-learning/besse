// Shared dropdown menu for player badge across pages.
// Usage:
// 1) Add <link rel="stylesheet" href="player-menu.css">
// 2) Add <script src="player-menu.js"></script>
// 3) Mark a clickable element with: data-player-menu-trigger="MRF|Municipality|Broker"
//    Optionally set data-player-menu-title="..."
//
// The menu navigates with current ?role=... preserved.
(function () {
  const ROLE_META = {
    Municipality: { icon: '🏛️' },
    MRF: { icon: '♻️' },
    Broker: { icon: '🚚' }
  };

  const DEFAULT_MENUS = {
    Municipality: {
      title: 'Municipality',
      hub: 'game.html',
      items: [
        { label: 'City Project', href: 'municipality-projects.html' },
        { label: 'Commercial', href: 'municipality-commercial.html' },
        { label: 'Industrial', href: 'municipality-industrial.html' },
        { label: 'Inventory', href: 'municipality-inventory.html' },
        { label: 'Marketplace', href: 'municipality-marketplace.html' },
        { label: 'Residential', href: 'municipality-residential.html' },
      ],
    },
    MRF: {
      title: 'MRF',
      hub: 'game.html',
      items: [
        { label: 'Inventory', href: 'mrf-inventory.html' },
        { label: 'Sorting Centre', href: 'mrf-inventory.html?facility=sorting' },
        { label: 'Recycling Centre', href: 'mrf-inventory.html?facility=recycling' },
        { label: 'Waste Treatment Facilities', href: 'mrf-inventory.html?facility=waste-treatment' },
        { label: 'Marketplace', href: 'mrf-marketplace.html' },
      ],
    },
    Broker: {
      title: 'Broker',
      hub: 'game.html',
      items: [
        { label: 'Inventory', href: 'broker-inventory.html' },
        { label: 'Marketplace', href: 'broker-marketplace.html' },
        { label: 'Airport', href: 'broker-airport.html' },
        { label: 'Truck Park', href: 'broker-transportation.html' },
        { label: 'Port', href: 'broker-port.html' },
      ],
    },
  };

  function getQueryRole() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('role');
    } catch {
      return null;
    }
  }

  function normalizeRole(role) {
    const r = String(role || '').toLowerCase();
    if (r === 'municipality') return 'Municipality';
    if (r === 'mrf') return 'MRF';
    if (r === 'broker') return 'Broker';
    return 'Municipality';
  }

  function syncHeaderRoleBadge() {
    const btn = document.getElementById('playerBadgeBtn');
    if (!btn) return;
    const role = normalizeRole(getQueryRole() || btn.getAttribute('data-player-menu-trigger'));
    btn.setAttribute('data-player-menu-trigger', role);

    const label = btn.querySelector('.font-semibold');
    if (label) {
      const existing = String(label.textContent || '').trim();
      const name = existing.includes(',') ? existing.split(',')[0].trim() : '@Player';
      label.textContent = `${name}, ${role}`;
    }

    const iconEl = btn.querySelector('.ml-2');
    if (iconEl) iconEl.textContent = (ROLE_META[role] && ROLE_META[role].icon) || '🧳';
  }

  function navigatePreserveRole(href) {
    const role = getQueryRole();
    const url = new URL(href, window.location.origin);
    if (role) url.searchParams.set('role', role);
    const dest = url.toString();
    // When game.html embeds municipality-hub in an iframe, menu links must use the top window
    // or nested game.html / hub pages break.
    if (typeof window !== 'undefined' && window.self !== window.top) {
      window.top.location.href = dest;
      return;
    }
    window.location.href = dest;
  }

  function ensureMenuEl(triggerEl, menuDef) {
    let menuEl = document.getElementById('playerMenu');
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.id = 'playerMenu';
      menuEl.className = 'player-menu hidden';
      document.body.appendChild(menuEl);
    }

    const title = triggerEl.getAttribute('data-player-menu-title') || menuDef.title || 'Menu';
    const hubHref = menuDef.hub;
    const items = menuDef.items || [];

    const buttonsHtml = [
      hubHref
        ? `<button type="button" class="player-menu__item" data-href="${hubHref}">
            <span>Hub</span><span class="player-menu__arrow">&gt;</span>
          </button>
          <div class="player-menu__divider"></div>`
        : '',
      ...items.map(
        (it) => `<button type="button" class="player-menu__item" data-href="${it.href}">
          <span>${it.label}</span><span class="player-menu__arrow">&gt;</span>
        </button>`
      ),
    ].join('');

    menuEl.innerHTML = `<div class="player-menu__title">${title} Views</div>${buttonsHtml}`;

    menuEl.querySelectorAll('[data-href]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const href = btn.getAttribute('data-href');
        if (href) navigatePreserveRole(href);
      });
    });

    return menuEl;
  }

  function positionMenu(menuEl, triggerEl) {
    const r = triggerEl.getBoundingClientRect();
    const margin = 8;
    const approxH = Math.min(420, menuEl.scrollHeight || 260);
    const approxW = 230;

    let top = r.bottom + margin;
    let left = r.left;

    if (left + approxW > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - approxW - margin);
    }
    if (top + approxH > window.innerHeight - margin) {
      top = Math.max(margin, r.top - approxH - margin);
    }

    menuEl.style.top = `${Math.round(top)}px`;
    menuEl.style.left = `${Math.round(left)}px`;
  }

  function setupTrigger(triggerEl) {
    const key = triggerEl.getAttribute('data-player-menu-trigger');
    const menuDef = DEFAULT_MENUS[key] || DEFAULT_MENUS.Municipality;
    const menuEl = ensureMenuEl(triggerEl, menuDef);

    function close() {
      if (!menuEl.classList.contains('hidden')) menuEl.classList.add('hidden');
    }

    function toggle() {
      const willOpen = menuEl.classList.contains('hidden');
      if (willOpen) {
        positionMenu(menuEl, triggerEl);
        menuEl.classList.remove('hidden');
      } else {
        close();
      }
    }

    triggerEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    document.addEventListener('click', (e) => {
      if (menuEl.classList.contains('hidden')) return;
      const t = e.target;
      if (t === menuEl || menuEl.contains(t)) return;
      if (t === triggerEl || triggerEl.contains(t)) return;
      close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    window.addEventListener('resize', () => {
      if (!menuEl.classList.contains('hidden')) positionMenu(menuEl, triggerEl);
    });
    window.addEventListener('scroll', () => {
      if (!menuEl.classList.contains('hidden')) positionMenu(menuEl, triggerEl);
    }, true);
  }

  function initAll() {
    syncHeaderRoleBadge();
    const triggers = Array.from(document.querySelectorAll('[data-player-menu-trigger]'));
    triggers.forEach(setupTrigger);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  window.PlayerMenu = { initAll };
})();

/**
 * Game Over → modal with reason + Restart; calls server `restartGame` (same session, fresh state).
 * Pass your Socket.IO client after `io()`. Safe to call once per socket.
 */
(function () {
  function inferGameOverReason(shared) {
    if (!shared || !shared.eventLog || !shared.eventLog.length) return '';
    const hit = [...shared.eventLog]
      .reverse()
      .find((e) => e && e.message && /Game Over|Well done!/i.test(String(e.message)));
    if (!hit) return '';
    const m = String(hit.message).match(/(?:Game Over|Well done!):\s*(.+)$/i);
    return m ? m[1].trim() : '';
  }

  function ensureGameOverModal() {
    let overlay = document.getElementById('besseGameOverOverlay');
    if (overlay) {
      // Inline display wins over any Tailwind class conflicts (hidden vs flex, etc.).
      overlay.style.display = 'none';
      overlay.style.pointerEvents = 'none';
      return overlay;
    }

    // Ensure button styles aren't overridden by broad page-level theme rules
    // (some pages set `.rounded-xl` backgrounds to white with `!important`).
    if (!document.getElementById('besseGameOverStyle')) {
      const style = document.createElement('style');
      style.id = 'besseGameOverStyle';
      style.textContent = `
        #besseGameOverRestartBtn{
          background:#2f5a47 !important;
          color:#ffffff !important;
          -webkit-text-fill-color:#ffffff !important;
        }
        #besseGameOverRestartBtn:hover{
          background:#244635 !important;
        }
      `;
      document.head.appendChild(style);
    }

    overlay = document.createElement('div');
    overlay.id = 'besseGameOverOverlay';
    overlay.className =
      'fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50';
    overlay.style.display = 'none';
    overlay.style.pointerEvents = 'none';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'besseGameOverTitle');
    overlay.innerHTML = `
      <div class="max-w-md w-full rounded-2xl border-2 border-[#2f5a47] bg-white shadow-2xl p-6 text-center">
        <h2 id="besseGameOverTitle" class="text-2xl font-extrabold tracking-wide text-[#1a2f25] mb-2">Well done!</h2>
        <p id="besseGameOverReason" class="text-slate-700 mb-6 text-sm leading-relaxed min-h-[1.25rem]"></p>
        <button type="button" id="besseGameOverRestartBtn" class="w-full rounded-xl bg-[#2f5a47] text-white font-bold py-3 px-4 shadow hover:bg-[#244635] disabled:opacity-50 disabled:cursor-not-allowed border border-black/10">
          重新開始
        </button>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function showGameOverModal(reason) {
    ensureGameOverModal();
    const titleEl = document.getElementById('besseGameOverTitle');
    const reasonEl = document.getElementById('besseGameOverReason');
    const btn = document.getElementById('besseGameOverRestartBtn');
    const overlay = document.getElementById('besseGameOverOverlay');
    const isWin = /simulation complete|day\s*\d+/i.test(String(reason || ''));
    if (titleEl) titleEl.textContent = isWin ? 'Well done!' : 'Game Over';
    if (reasonEl) {
      reasonEl.textContent = reason
        ? String(reason)
        : 'The game has ended.';
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重新開始';
    }
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.style.pointerEvents = 'auto';
    }
    document.body.style.overflow = 'hidden';
  }

  function hideGameOverModal() {
    const overlay = document.getElementById('besseGameOverOverlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.style.pointerEvents = 'none';
    }
    document.body.style.overflow = '';
    const legacy = document.getElementById('restartGameBtn');
    if (legacy) legacy.classList.add('hidden');
  }

  window.besseAttachRestartUI = function (socket) {
    if (!socket || socket.__besseRestartAttached) return;

    // Do NOT attach restart / Game Over UI on the lobby / role selection page.
    // That page應該只負責配對角色，不能被 Game Over 視窗遮住或觸發 restart。
    try {
      const p = String(window.location.pathname || '').toLowerCase();
      const isLobby =
        p === '/' ||
        p.endsWith('/index.html') ||
        p.endsWith('index.html');
      if (isLobby) {
        return;
      }
    } catch {
      // ignore — fallback to normal behavior
    }

    socket.__besseRestartAttached = true;

    const legacyFloat = document.getElementById('besseRestartGameBtn');
    if (legacyFloat) legacyFloat.classList.add('hidden');

    ensureGameOverModal();
    const restartBtn = document.getElementById('besseGameOverRestartBtn');
    const legacyGameBtn = document.getElementById('restartGameBtn');
    if (legacyGameBtn) legacyGameBtn.classList.add('hidden');

    function doRestart() {
      const btn = document.getElementById('besseGameOverRestartBtn');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = '重啟中…';
      let role = null;
      try {
        role = new URLSearchParams(window.location.search).get('role');
      } catch {
        role = null;
      }
      socket.emit('restartGame', { role }, (res) => {
        if (!res || !res.ok) {
          btn.disabled = false;
          btn.textContent = '重新開始';
          alert('重啟失敗，請再試一次。');
        }
      });
    }

    if (restartBtn && !restartBtn.__besseRestartWired) {
      restartBtn.__besseRestartWired = true;
      restartBtn.addEventListener('click', doRestart);
    }

    socket.on('gameOver', (payload) => {
      // If this client already received "gameRestarted" recently, ignore delayed/old gameOver events.
      // This avoids "someone clicked Play Again -> other tabs suddenly jump back" due to event reordering.
      if (
        socket.__besseSuppressGameOverUntil &&
        Date.now() < socket.__besseSuppressGameOverUntil
      ) {
        return;
      }
      // On the "Select Role" page we must not block clicks with a modal.
      // Leave-button typically navigates to `/` (index.html).
      const pathname = (() => {
        try {
          return String(window.location.pathname || '').toLowerCase();
        } catch {
          return '';
        }
      })();
      const onRoleSelection =
        pathname === '/' || pathname.endsWith('/index.html') || pathname.endsWith('index.html');
      if (onRoleSelection) {
        // Keep page interactive.
        const overlay = document.getElementById('besseGameOverOverlay');
        if (overlay) {
          overlay.style.display = 'none';
          overlay.style.pointerEvents = 'none';
        }
        document.body.style.overflow = '';
        return;
      }
      const r = payload && payload.reason ? String(payload.reason) : '';
      const doRedirectToLeaderboard = () => {
        // Auto-navigate to leaderboard on game over.
        // This ensures leaderboard appears regardless of which game sub-page is open.
        if (socket.__besseLeaderboardRedirected) return;
        socket.__besseLeaderboardRedirected = true;
        try {
          const onLeaderboard =
            window &&
            window.location &&
            String(window.location.pathname).toLowerCase().endsWith('/leaderboard.html');
          if (onLeaderboard) return;

          const dest = new URL('leaderboard.html', window.location.origin);
          // Pass current role into leaderboard so it can route back on "Play Again".
          const role = (() => {
            try {
              return new URLSearchParams(window.location.search).get('role');
            } catch {
              return null;
            }
          })();
          if (role) dest.searchParams.set('role', role);
          setTimeout(() => {
            if (window.self !== window.top) {
              window.top.location.href = dest.toString();
            } else {
              window.location.href = dest.toString();
            }
          }, 250);
        } catch (_e) {
          // ignore navigation failures
        }
      };

      // Guard against delayed "gameOver" packets from the previous round.
      // Only proceed if the server still considers the game over.
      fetch('/state')
        .then((res) => (res && res.ok ? res.json() : null))
        .then((data) => {
          if (data && data.shared && data.shared.gameOver === false) return;
          showGameOverModal(r);
          doRedirectToLeaderboard();
        })
        .catch(() => {
          // If state fetch fails, fall back to existing behavior.
          showGameOverModal(r);
          doRedirectToLeaderboard();
        });
    });

    socket.on('gameRestarted', () => {
      // Suppress any delayed "gameOver" packets for a short window.
      // (All clients will get gameRestarted when the gate completes, but older queued events may arrive after.)
      socket.__besseSuppressGameOverUntil = Date.now() + 5000;
      hideGameOverModal();
      window.dispatchEvent(new CustomEvent('besseGameRestarted'));
    });

    fetch('/state')
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.shared && data.shared.gameOver) {
          const reason = inferGameOverReason(data.shared) || '';
          showGameOverModal(reason);
        }
      })
      .catch(() => {});
  };
})();

/**
 * In-game clock tied to shared.day / shared.maxDay (1…180).
 * Calendar: Day 1 = 1 Nov 2025, each +1 day advances the date by one.
 * Time: same formula as marketplace — base 10:00, +8 minutes per (day−1), modulo 24h.
 */
(function (global) {
  const START = new Date(2025, 10, 1);

  function clampDay(day, maxDay) {
    const d = Math.max(1, Math.floor(Number(day) || 1));
    const max = Math.max(1, Math.floor(Number(maxDay) || 180));
    return Math.min(d, max);
  }

  function gameDate(day, maxDay) {
    const d = clampDay(day, maxDay);
    const dt = new Date(START);
    dt.setDate(dt.getDate() + (d - 1));
    return dt;
  }

  function minutesFromDay(day, maxDay) {
    const d = clampDay(day, maxDay);
    return (600 + (d - 1) * 8) % 1440;
  }

  function formatTimeCompact(day, maxDay) {
    const m = minutesFromDay(day, maxDay);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const ap = h >= 12 ? 'pm' : 'am';
    return (h % 12 || 12) + ':' + String(mm).padStart(2, '0') + ' ' + ap;
  }

  function formatTimeHeader(day, maxDay) {
    const m = minutesFromDay(day, maxDay);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const ap = h >= 12 ? 'p.m.' : 'a.m.';
    return (h % 12 || 12) + ':' + String(mm).padStart(2, '0') + ' ' + ap;
  }

  function formatDateLong(day, maxDay) {
    const dt = gameDate(day, maxDay);
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  function formatDateShort(day, maxDay) {
    const dt = gameDate(day, maxDay);
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return String(dt.getDate()).padStart(2, '0') + ' ' + M[dt.getMonth()] + ' ' + dt.getFullYear();
  }

  function updateDom(shared) {
    if (!shared || shared.day == null) return;
    const day = typeof shared.day === 'number' ? shared.day : parseInt(shared.day, 10) || 1;
    const maxDay =
      shared.maxDay != null
        ? typeof shared.maxDay === 'number'
          ? shared.maxDay
          : parseInt(shared.maxDay, 10) || 180
        : 180;

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    set('clockText', formatTimeHeader(day, maxDay));
    set('dateText', formatDateLong(day, maxDay));
    set('calD', formatDateShort(day, maxDay));
    set('calT', formatTimeCompact(day, maxDay));
    set('bessePanelDate', formatDateShort(day, maxDay));
    set('bessePanelTime', formatTimeCompact(day, maxDay));

    document.querySelectorAll('#currentTime').forEach((el) => {
      el.textContent = formatTimeCompact(day, maxDay);
    });
    document.querySelectorAll('#currentDate').forEach((el) => {
      el.textContent = formatDateShort(day, maxDay);
    });
  }

  global.BesseGameCalendar = {
    clampDay,
    gameDate,
    minutesFromDay,
    formatTimeCompact,
    formatTimeHeader,
    formatDateLong,
    formatDateShort,
    updateDom
  };
})(typeof window !== 'undefined' ? window : global);

/** Sync optional top-bar element `#headerDayChip` to e.g. "Day 12 / 180". */
(function (global) {
  global.BesseSyncHeaderDayChip = function (day, maxDay) {
    const chip = document.getElementById('headerDayChip');
    if (!chip || day == null || maxDay == null) return;
    chip.textContent = 'Day ' + day + ' / ' + maxDay;
  };
})(typeof window !== 'undefined' ? window : global);

/**
 * Optional Firebase Auth bootstrap (Google sign-in / sign-out).
 * Requires `firebase-config.js` setting `window.BESSE_FIREBASE_CONFIG`.
 */
(function () {
  const CONFIG_SCRIPT_ID = 'besseFirebaseConfigScript';
  const APP_SCRIPT_ID = 'besseFirebaseAppScript';
  const AUTH_SCRIPT_ID = 'besseFirebaseAuthScript';
  const AUTH_BTN_ID = 'besseAuthBtn';
  const DISPLAY_NAME_KEY = 'besseAuthDisplayName';

  function loadScriptOnce(id, src) {
    return new Promise((resolve, reject) => {
      const existing = document.getElementById(id);
      if (existing) {
        if (existing.dataset.loaded === '1') return resolve();
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
        return;
      }
      const s = document.createElement('script');
      s.id = id;
      s.src = src;
      s.async = true;
      s.onload = () => {
        s.dataset.loaded = '1';
        resolve();
      };
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  function upsertAuthButton() {
    let btn = document.getElementById(AUTH_BTN_ID);
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = AUTH_BTN_ID;
    btn.type = 'button';
    btn.className =
      'fixed right-3 bottom-3 z-[300] rounded-full bg-[#2f5a47] text-white text-xs font-bold px-4 py-2 shadow hover:bg-[#244635]';
    btn.textContent = 'Sign in';
    document.body.appendChild(btn);
    return btn;
  }

  function applyPlayerNameToHeader(displayName) {
    const role = (() => {
      const p = new URLSearchParams(window.location.search);
      return p.get('role');
    })();
    const headerName = document.getElementById('headerPlayerName');
    if (headerName && role) {
      headerName.textContent = `@Player, ${role}`;
    } else if (headerName) {
      headerName.textContent = '@Player';
    }
    const badge = document.getElementById('playerBadgeBtn');
    if (badge) {
      const roleNormalized = normalizeRole(role || badge.getAttribute('data-player-menu-trigger'));
      const label = badge.querySelector('.font-semibold');
      if (label) label.textContent = `@Player, ${roleNormalized}`;
      const iconEl = badge.querySelector('.ml-2');
      if (iconEl) iconEl.textContent = (ROLE_META[roleNormalized] && ROLE_META[roleNormalized].icon) || '🧳';
      badge.setAttribute('data-player-menu-trigger', roleNormalized);
    }
  }

  function bootstrapFirebaseAuth() {
    const config = window.BESSE_FIREBASE_CONFIG;
    if (!config || !config.apiKey) return;
    if (!window.firebase || !window.firebase.auth) return;

    const app = window.firebase.apps && window.firebase.apps.length
      ? window.firebase.app()
      : window.firebase.initializeApp(config);
    const auth = window.firebase.auth(app);
    const provider = new window.firebase.auth.GoogleAuthProvider();
    const btn = upsertAuthButton();

    const cachedName = localStorage.getItem(DISPLAY_NAME_KEY) || '';
    if (cachedName) applyPlayerNameToHeader(cachedName);

    auth.onAuthStateChanged((user) => {
      if (user) {
        const name = user.displayName || user.email || 'Player';
        localStorage.setItem(DISPLAY_NAME_KEY, name);
        btn.textContent = `Sign out (${name})`;
        applyPlayerNameToHeader(name);
      } else {
        localStorage.removeItem(DISPLAY_NAME_KEY);
        btn.textContent = 'Sign in';
      }
    });

    btn.onclick = async () => {
      const user = auth.currentUser;
      try {
        if (user) {
          await auth.signOut();
          return;
        }
        await auth.signInWithPopup(provider);
      } catch (e) {
        alert('Firebase sign-in failed. Check popup settings and Firebase config.');
      }
    };
  }

  async function initFirebaseAuth() {
    try {
      await loadScriptOnce(CONFIG_SCRIPT_ID, 'firebase-config.js');
      if (!window.BESSE_FIREBASE_CONFIG || !window.BESSE_FIREBASE_CONFIG.apiKey) return;
      await loadScriptOnce(APP_SCRIPT_ID, 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js');
      await loadScriptOnce(AUTH_SCRIPT_ID, 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js');
      bootstrapFirebaseAuth();
    } catch {
      // silent fail: app should continue without auth
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFirebaseAuth);
  } else {
    initFirebaseAuth();
  }
})();

