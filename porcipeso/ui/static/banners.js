'use strict';
/* ============================================================
   PorciPeso — banners.js (módulo independiente; no toca app.js)

   Al abrir consulta GET /api/update/status:
     {current, latest, update_available, min_version_ok, apk_url,
      banners:[{id, texto, boton, url, desde, hasta, solo_sin_nube}]}

   - update_available → banner discreto "Hay una versión nueva…".
       · escritorio: el botón abre la url de release (apk_url).
       · APK (Capacitor nativo): el botón dispara la descarga vía el
         shim (POST /api/update/download) y Android abre el instalador.
   - banners remotos → tarjeta cerrable; el cierre persiste en
     localStorage `porcipeso_banner_dismissed_{id}`. Respeta las
     ventanas desde/hasta y `solo_sin_nube` (solo se muestra si el
     cliente NO tiene nube configurada → localStorage
     `porcipeso_cloud_url` vacía).
   - NO invasivo: máximo 1 banner visible, debajo del header.
   ============================================================ */
(function () {
  const CLOUD_KEY = 'porcipeso_cloud_url';

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* incógnito */ } };

  const cloudConfigured = () => !!String(lsGet(CLOUD_KEY) || '').trim();
  const isNative = () => {
    try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
    catch { return false; }
  };

  const dismissed = (id) => lsGet('porcipeso_banner_dismissed_' + id) === '1';
  const dismiss = (id) => lsSet('porcipeso_banner_dismissed_' + id, '1');

  function inWindow(b, now) {
    const t = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.getTime(); };
    if (b.desde) { const d = t(b.desde); if (d !== null && now < d) return false; }
    if (b.hasta) { const h = t(b.hasta); if (h !== null && now > h) return false; }
    return true;
  }

  /* estilos propios (no se toca styles.css) */
  function injectCss() {
    const css = `
      .pp-banner{display:flex;align-items:center;gap:10px;margin:0 0 12px;
        padding:10px 12px;border-radius:10px;font-size:.92rem;line-height:1.35;
        border:1px solid rgba(23,138,80,.35);background:rgba(23,138,80,.08);
        color:inherit}
      .pp-banner .pp-txt{flex:1;min-width:0}
      .pp-banner .pp-act{white-space:nowrap;border:1px solid rgba(23,138,80,.5);
        background:#178A50;color:#fff;border-radius:8px;padding:6px 12px;
        font:inherit;font-weight:600;cursor:pointer}
      .pp-banner .pp-act[disabled]{opacity:.6;cursor:default}
      .pp-banner .pp-x{border:0;background:none;color:inherit;opacity:.55;
        font-size:1.05rem;line-height:1;cursor:pointer;padding:4px}
      .pp-banner .pp-x:hover{opacity:1}`;
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  function mountPoint() {
    const main = document.querySelector('main.main');
    if (!main) return null;
    const head = main.querySelector('header.mobilehead');
    return { main, before: head ? head.nextSibling : main.firstChild };
  }

  function show(banner) {
    const mp = mountPoint();
    if (!mp) return;
    const el = document.createElement('div');
    el.className = 'pp-banner';
    el.setAttribute('role', 'status');

    const txt = document.createElement('span');
    txt.className = 'pp-txt';
    txt.textContent = banner.texto;
    el.appendChild(txt);

    if (banner.boton && banner.action) {
      const btn = document.createElement('button');
      btn.className = 'pp-act';
      btn.type = 'button';
      btn.textContent = banner.boton;
      btn.addEventListener('click', () => banner.action(btn, el));
      el.appendChild(btn);
    }

    const x = document.createElement('button');
    x.className = 'pp-x';
    x.type = 'button';
    x.setAttribute('aria-label', 'Cerrar aviso');
    x.textContent = '✕';
    x.addEventListener('click', () => { dismiss(banner.id); el.remove(); });
    el.appendChild(x);

    mp.main.insertBefore(el, mp.before);
  }

  /* botón del banner de actualización */
  function updateAction(status) {
    return (btn) => {
      if (isNative()) {
        btn.disabled = true;
        btn.textContent = 'Descargando…';
        fetch('/api/update/download', { method: 'POST' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then(() => { btn.textContent = 'Abriendo instalador…'; })
          .catch(() => { btn.disabled = false; btn.textContent = 'Reintentar descarga'; });
      } else if (status.apk_url) {
        window.open(status.apk_url, '_blank');
      }
    };
  }

  /** Elige EL banner a mostrar (máximo 1): actualización > remotos. */
  function pick(status, now) {
    if (status.update_available && status.latest) {
      const id = 'update_' + status.latest;
      if (!dismissed(id)) {
        return {
          id,
          texto: 'Hay una versión nueva (' + status.latest + ')',
          boton: 'Ver cómo actualizar',
          action: updateAction(status),
        };
      }
    }
    const banners = Array.isArray(status.banners) ? status.banners : [];
    for (const b of banners) {
      if (!b || !b.id || !b.texto) continue;
      if (dismissed(b.id)) continue;
      if (!inWindow(b, now)) continue;
      if (b.solo_sin_nube && cloudConfigured()) continue;
      return {
        id: b.id,
        texto: b.texto,
        boton: b.boton || null,
        action: b.url ? () => window.open(b.url, '_blank') : null,
      };
    }
    return null;
  }

  function init() {
    fetch('/api/update/status')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((status) => {
        const banner = pick(status, Date.now());
        if (!banner) return;
        injectCss();
        show(banner);
      })
      .catch(() => { /* sin backend / sin nube: silencio */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
