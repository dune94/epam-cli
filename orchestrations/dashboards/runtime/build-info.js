(() => {
  const POLL_MS = Number(window.EPAM_BUILDINFO_POLL_MS || 4000);
  const WARN_MS = Number(window.EPAM_BUILDINFO_WARN_MS || 20000);
  const STALE_MS = Number(window.EPAM_BUILDINFO_STALE_MS || 60000);
  const subscribers = new Set();
  const state = {
    info: null,
    status: 'loading',
    error: null,
    ageMs: null
  };
  let timerId = null;

  function injectStyles() {
    if (document.getElementById('epam-build-info-style')) return;
    const style = document.createElement('style');
    style.id = 'epam-build-info-style';
    style.textContent = `
      .build-info-pill {
        position: fixed;
        right: 18px;
        bottom: 18px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 16px;
        border-radius: 999px;
        backdrop-filter: blur(8px);
        background: rgba(15, 23, 42, 0.92);
        color: #e2e8f0;
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 12px;
        line-height: 1.2;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.25);
        z-index: 10000;
        border: 1px solid rgba(148, 163, 184, 0.25);
        cursor: default;
      }
      .build-info-pill .bi-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        box-shadow: 0 0 10px currentColor;
      }
      .build-info-pill .bi-text {
        display: flex;
        flex-direction: column;
      }
      .build-info-pill .bi-label {
        text-transform: uppercase;
        letter-spacing: 0.8px;
        font-size: 11px;
        color: rgba(226, 232, 240, 0.9);
      }
      .build-info-pill .bi-value {
        font-size: 13px;
        font-weight: 700;
      }
      .build-info-pill .bi-meta {
        font-size: 11px;
        color: rgba(226, 232, 240, 0.8);
      }
      .build-info-pill.state-loading .bi-dot { color: #38bdf8; }
      .build-info-pill.state-ok .bi-dot { color: #34d399; }
      .build-info-pill.state-warn .bi-dot { color: #fbbf24; }
      .build-info-pill.state-stale .bi-dot { color: #f97316; }
      .build-info-pill.state-error .bi-dot { color: #f87171; }
      @media (max-width: 600px) {
        .build-info-pill {
          inset: auto 12px 12px 12px;
          border-radius: 12px;
          justify-content: space-between;
          flex-wrap: wrap;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    let panel = document.getElementById('buildInfoPill');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'buildInfoPill';
    panel.className = 'build-info-pill state-loading';
    panel.innerHTML = `
      <div class="bi-dot"></div>
      <div class="bi-text">
        <div class="bi-label">Dash Sync</div>
        <div class="bi-value" id="biValue">Starting…</div>
        <div class="bi-meta" id="biMeta">Awaiting build-info.json</div>
      </div>
    `;
    document.body.appendChild(panel);
    return panel;
  }

  function computeAgeMs(info) {
    if (!info || !info.generatedAt) return null;
    const ts = Date.parse(info.generatedAt);
    if (Number.isNaN(ts)) return null;
    return Math.max(0, Date.now() - ts);
  }

  function formatAgo(ageMs) {
    if (ageMs == null) return '—';
    if (ageMs < 1500) return 'just now';
    const sec = Math.floor(ageMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function shortHash(hash) {
    if (!hash) return '—';
    return `#${hash.slice(0, 7)}`;
  }

  function metaLine(info) {
    if (!info) return 'Waiting for Eleventy snapshot…';
    const parts = [];
    const prdHash = info.sources?.prd?.hash;
    if (prdHash) parts.push(`PRD ${shortHash(prdHash)}`);
    const phaseHash = info.sources?.phaseCost?.hash;
    if (phaseHash) parts.push(`Cost ${shortHash(phaseHash)}`);
    if (info.metrics?.storyCount != null) parts.push(`${info.metrics.storyCount} stories`);
    if (Array.isArray(info.metrics?.activeLanes) && info.metrics.activeLanes.length) {
      parts.push(`${info.metrics.activeLanes.length} lanes active`);
    }
    const spec = info.metrics?.specification;
    if (spec && spec.total) {
      parts.push(`Spec ${spec.completed}/${spec.total}`);
    }
    return parts.join(' · ') || 'Watching orchestrations/logs';
  }

  function classifyStatus(detail) {
    if (detail.error) return 'state-error';
    if (detail.status === 'loading') return 'state-loading';
    const age = detail.ageMs;
    if (age == null) return 'state-loading';
    if (age < WARN_MS) return 'state-ok';
    if (age < STALE_MS) return 'state-warn';
    return 'state-stale';
  }

  function broadcast(detail) {
    subscribers.forEach((cb) => {
      try { cb(detail); } catch (err) { console.error(err); }
    });
    window.dispatchEvent(new CustomEvent('buildinfo:update', { detail }));
  }

  function updatePanel(detail) {
    const panel = ensurePanel();
    const valueEl = panel.querySelector('#biValue');
    const metaEl = panel.querySelector('#biMeta');
    valueEl.textContent = detail.error
      ? 'Paused — cannot read build-info'
      : `Snapshot ${formatAgo(detail.ageMs)}`;
    metaEl.textContent = detail.error
      ? (detail.error.message || String(detail.error))
      : metaLine(detail.info);
    panel.title = detail.info?.generatedAt || 'No snapshot yet';
    panel.classList.remove('state-loading', 'state-ok', 'state-warn', 'state-stale', 'state-error');
    panel.classList.add(classifyStatus(detail));
  }

  function setState(partial) {
    Object.assign(state, partial);
    state.ageMs = computeAgeMs(state.info);
    broadcast({ ...state });
  }

  async function poll() {
    clearTimeout(timerId);
    try {
      const res = await fetch(`build-info.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({ info: data, status: 'ok', error: null });
    } catch (error) {
      console.warn('Build info poll failed:', error);
      setState({ status: 'error', error });
    } finally {
      timerId = setTimeout(poll, POLL_MS);
    }
  }

  function subscribe(fn, options = {}) {
    subscribers.add(fn);
    if (options.immediate !== false) {
      try {
        fn({ ...state });
      } catch (err) {
        console.error(err);
      }
    }
    return () => subscribers.delete(fn);
  }

  function init() {
    injectStyles();
    ensurePanel();
    subscribe(updatePanel, { immediate: true });
    poll();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        poll();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.EPAMBuildInfo = {
    getLatest: () => ({ ...state }),
    subscribe
  };
})();
