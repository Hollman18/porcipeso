'use strict';
/* ============================================================
   PorciPeso — nube: configuración, login, roles y estado de sync.

   Se carga DESPUÉS de app.js (usa setModule del scope global).

   Diseño:
   - SIN nube configurada (localStorage porcipeso_cloud_url vacío) la
     app funciona EXACTAMENTE como siempre: este archivo no hace nada
     visible (modo standalone).
   - Con nube configurada y sin sesión → overlay de login modal
     (bloquea operar) contra el proxy local POST /api/cloud/login
     (mismo origen ⇒ sin CORS; el sync worker recibe los tokens ahí).
   - Offline-first: si hay refresh + perfil cacheados y no hay señal,
     se entra igual con el perfil cacheado y un aviso discreto.
   - El REFRESH lo rota el sync worker (dueño único): la UI pide el
     access vigente a GET /api/cloud/token y guarda una copia del
     refresh solo como caché de arranque.
   - Roles: rol "operador" ve SOLO el módulo Pesaje (los demás módulos
     DESAPARECEN, sin candado) — se aplica con body.rol-operador (CSS)
     + guard en setModule. Autorización real = la nube; esto es UX.
   - Nunca se loguean tokens.
   ============================================================ */
(function () {
  const $ = (id) => document.getElementById(id);
  const LS = {
    url: 'porcipeso_cloud_url',
    tenant: 'porcipeso_tenant',
    refresh: 'porcipeso_refresh',
    perfil: 'porcipeso_perfil',
  };
  const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const lsSet = (k, v) => {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); }
    catch { /* sin storage */ }
  };

  const AUTH = {
    access: '',            // access token SOLO en memoria
    perfil: null,          // {email, nombre, rol, tenant_id}
    offline: false,
    refreshTimer: null,
    statusTimer: null,
  };
  window.PPAuth = {
    get perfil() { return AUTH.perfil; },
    get rol() { return AUTH.perfil?.rol ?? null; },
    pokeStatus: () => { pollStatus().catch(() => {}); },
  };

  const cloudCfg = () => ({
    url: lsGet(LS.url).trim().replace(/\/+$/, ''),
    tenant: lsGet(LS.tenant).trim().toLowerCase(),
  });
  const cachedPerfil = () => {
    try { return JSON.parse(lsGet(LS.perfil) || 'null'); } catch { return null; }
  };

  /** fetch local sin lanzar: → {status, body} (status 0 = sin red). */
  async function jreq(method, path, body) {
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body != null ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return { status: res.status, body: data };
    } catch {
      return { status: 0, body: null };
    }
  }

  /* ============================ ROLES ============================ */
  const origSetModule = window.setModule;
  window.setModule = function (mod) {
    // operador: opera y punto — Datos y Báscula no existen para él
    if (AUTH.perfil?.rol === 'operador' && mod !== 'pesaje') mod = 'pesaje';
    return origSetModule(mod);
  };

  function applyRol() {
    const op = AUTH.perfil?.rol === 'operador';
    document.body.classList.toggle('rol-operador', op);
    if (op) origSetModule('pesaje');
    renderUser();
  }

  function renderUser() {
    const p = AUTH.perfil;
    for (const [box, name, rol] of [
      ['userBox', 'userName', 'userRol'],
      ['userBoxM', 'userNameM', 'userRolM'],
    ]) {
      const el = $(box);
      if (!el) continue;
      el.hidden = !p;
      if (p) {
        $(name).textContent = p.nombre || p.email || '';
        $(rol).textContent = p.rol || '';
      }
    }
    renderCloudChip(null);
  }

  function renderCloudChip(st) {
    for (const id of ['cloudChip', 'cloudChipM']) {
      const chip = $(id);
      if (!chip) continue;
      chip.hidden = !AUTH.perfil;
      chip.classList.toggle('ok', !!st?.conectado);
      chip.title = st?.conectado
        ? `Nube conectada · última subida: ${st?.ultimo_push ?? '—'}`
        : 'Nube sin conexión — los pesajes se subirán al volver la señal';
    }
  }

  /* ==================== AVISO DISCRETO (nube) ==================== */
  let noteTimer = null;
  function cloudNote(msg, sticky = false) {
    const el = $('cloudNote');
    if (!el) return;
    if (!msg) { el.classList.remove('show'); return; }
    $('cloudNoteTxt').textContent = msg;
    el.classList.add('show');
    if (noteTimer) clearTimeout(noteTimer);
    if (!sticky) noteTimer = setTimeout(() => el.classList.remove('show'), 8000);
  }

  /* ============================ LOGIN ============================ */
  function loginDlg() { return $('dlgLogin'); }

  function showLogin(msg) {
    const c = cloudCfg();
    $('loginSub').textContent = c.tenant
      ? `${c.tenant} · ${c.url}` : c.url;
    const err = $('loginError');
    err.textContent = msg || '';
    err.classList.toggle('show', !!msg);
    $('bLoginOffline').hidden = !(lsGet(LS.refresh) && cachedPerfil());
    try { loginDlg().showModal(); } catch { /* ya abierto */ }
  }

  function hideLogin() { try { loginDlg().close(); } catch { /* cerrado */ } }

  async function doLogin(email, password) {
    const c = cloudCfg();
    const r = await jreq('POST', '/api/cloud/login', {
      cloud_url: c.url, tenant: c.tenant, email, password,
    });
    if (r.status === 200 && r.body?.access_token) {
      AUTH.access = r.body.access_token;
      AUTH.perfil = r.body.perfil || { email };
      AUTH.offline = false;
      lsSet(LS.refresh, r.body.refresh_token || '');
      lsSet(LS.perfil, JSON.stringify(AUTH.perfil));
      scheduleRefresh(Number(r.body.expires_in) || 1800);
      hideLogin();
      applyRol();
      startStatusPoll();
      cloudNote(`Sesión iniciada: ${AUTH.perfil.nombre || email}`);
      return;
    }
    if (r.status === 401) {
      showLogin('Correo o contraseña incorrectos.');
    } else if (r.status === 429) {
      showLogin('Demasiados intentos — espera 15 minutos e inténtalo de nuevo.');
    } else {
      // 504/0/otros: nube inalcanzable
      showLogin('No pude hablar con la nube. Si ya habías entrado antes, puedes entrar sin conexión.');
    }
  }

  function enterOffline() {
    const perfil = cachedPerfil();
    if (!perfil) return;
    AUTH.perfil = perfil;
    AUTH.offline = true;
    hideLogin();
    applyRol();
    startStatusPoll();
    // re-siembra el worker por si perdió su estado; empujará al volver la red
    const c = cloudCfg();
    jreq('POST', '/api/cloud/session', {
      cloud_url: c.url, tenant: c.tenant,
      refresh_token: lsGet(LS.refresh), perfil,
    }).catch(() => {});
    cloudNote('Sin conexión — tus pesajes se subirán al volver la señal', true);
  }

  async function doLogout() {
    await jreq('DELETE', '/api/cloud/session');
    lsSet(LS.refresh, null);
    lsSet(LS.perfil, null);
    AUTH.access = '';
    AUTH.perfil = null;
    AUTH.offline = false;
    if (AUTH.refreshTimer) clearTimeout(AUTH.refreshTimer);
    applyRol();
    showLogin();
  }

  /* ------------- auto-refresh del access (vía worker) ------------- */
  function scheduleRefresh(expiresIn) {
    if (AUTH.refreshTimer) clearTimeout(AUTH.refreshTimer);
    const waitS = Math.max(60, (Number(expiresIn) || 1800) - 120);
    AUTH.refreshTimer = setTimeout(() => { refreshAccess().catch(() => {}); }, waitS * 1000);
  }

  async function refreshAccess() {
    const r = await jreq('GET', '/api/cloud/token');
    if (r.status === 200 && r.body?.access_token) {
      AUTH.access = r.body.access_token;
      AUTH.offline = false;
      if (r.body.refresh_token) lsSet(LS.refresh, r.body.refresh_token);
      if (r.body.perfil) {
        AUTH.perfil = r.body.perfil;
        lsSet(LS.perfil, JSON.stringify(r.body.perfil));
        applyRol();
      }
      scheduleRefresh(Number(r.body.expires_in) || 1800);
      return true;
    }
    if (r.status === 401) {
      // refresh muerto: sesión vencida — datos locales intactos
      lsSet(LS.refresh, null);
      showLogin('Tu sesión venció — vuelve a entrar. Tus pesajes locales están a salvo.');
      return false;
    }
    // 504/0: sin red — se reintenta luego
    AUTH.offline = true;
    scheduleRefresh(300);
    return false;
  }

  /* ====================== ESTADO DE LA NUBE ====================== */
  async function pollStatus() {
    const r = await jreq('GET', '/api/cloud/status');
    if (r.status !== 200 || !r.body) return;
    const st = r.body;
    renderCloudChip(st);
    renderNubeEstado(st);
    if (st.configurada && st.sesion_vencida && AUTH.perfil) {
      lsSet(LS.refresh, null);
      showLogin('Tu sesión venció — vuelve a entrar. Tus pesajes locales están a salvo.');
    }
  }

  function startStatusPoll() {
    if (AUTH.statusTimer) clearInterval(AUTH.statusTimer);
    pollStatus().catch(() => {});
    AUTH.statusTimer = setInterval(() => pollStatus().catch(() => {}), 30000);
  }

  function fmtTs(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('es-CO', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      });
    } catch { return iso; }
  }

  function renderNubeEstado(st) {
    const el = $('nubeEstado');
    if (!el) return;
    if (!st?.configurada) { el.hidden = true; return; }
    el.hidden = false;
    const dot = st.conectado ? '🟢' : '⚪';
    el.textContent = `${dot} ${st.conectado ? 'Conectada' : 'Sin conexión'}`
      + ` · última subida: ${fmtTs(st.ultimo_push)}`
      + (st.pendientes ? ` · ${st.pendientes} pesaje${st.pendientes === 1 ? '' : 's'} por subir` : '');
  }

  /* ============== SECCIÓN ☁️ NUBE (módulo Báscula) ============== */
  function nubeResult(cls, text) {
    const res = $('nubeResult');
    if (!res) return;
    res.className = 'test-result show' + (cls ? ' ' + cls : '');
    res.textContent = text;
  }

  function refreshNubeForm() {
    const c = cloudCfg();
    if ($('nubeUrl')) $('nubeUrl').value = c.url;
    if ($('nubeTenant')) $('nubeTenant').value = c.tenant;
    if ($('bNubeQuitar')) $('bNubeQuitar').hidden = !c.url;
  }

  async function nubeConectar() {
    const url = ($('nubeUrl')?.value ?? '').trim().replace(/\/+$/, '');
    const tenant = ($('nubeTenant')?.value ?? '').trim().toLowerCase();
    if (!/^https?:\/\//.test(url)) {
      nubeResult('fail', 'Escribe la dirección completa del servidor (empieza con http:// o https://).');
      return;
    }
    if (!tenant) {
      nubeResult('fail', 'Falta el código del cliente (te lo da tu proveedor).');
      return;
    }
    $('bNubeConectar').disabled = true;
    nubeResult('', 'Probando…');
    const r = await jreq('POST', '/api/cloud/probe', { cloud_url: url, tenant });
    $('bNubeConectar').disabled = false;
    if (r.status === 200 && r.body?.ok) {
      lsSet(LS.url, url);
      lsSet(LS.tenant, tenant);
      refreshNubeForm();
      nubeResult('ok', 'Nube conectada ✓ — ahora inicia sesión con tu usuario.');
      if (!AUTH.perfil) showLogin();
      startStatusPoll();
    } else {
      nubeResult('fail', 'No encuentro el servidor. Revisa la dirección, el código del cliente y tu internet.');
    }
  }

  async function nubeQuitar() {
    await jreq('DELETE', '/api/cloud/session');
    for (const k of [LS.url, LS.tenant, LS.refresh, LS.perfil]) lsSet(k, null);
    AUTH.access = '';
    AUTH.perfil = null;
    AUTH.offline = false;
    if (AUTH.statusTimer) clearInterval(AUTH.statusTimer);
    if (AUTH.refreshTimer) clearTimeout(AUTH.refreshTimer);
    hideLogin();
    applyRol();
    refreshNubeForm();
    renderNubeEstado(null);
    nubeResult('ok', 'Nube quitada — la app vuelve a funcionar sola (standalone).');
  }

  /* ============================ WIRING ============================ */
  function bind() {
    $('formLogin')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = ($('loginEmail')?.value ?? '').trim();
      const pass = $('loginPass')?.value ?? '';
      if (!email || !pass) return;
      $('bLogin').disabled = true;
      try { await doLogin(email, pass); }
      finally { $('bLogin').disabled = false; }
    });
    $('bLoginOffline')?.addEventListener('click', enterOffline);
    // el login es obligatorio con nube configurada: sin escape con Esc
    loginDlg()?.addEventListener('cancel', (e) => e.preventDefault());
    $('bLogout')?.addEventListener('click', doLogout);
    $('bLogoutM')?.addEventListener('click', doLogout);
    $('bNubeConectar')?.addEventListener('click', nubeConectar);
    $('bNubeQuitar')?.addEventListener('click', nubeQuitar);
    window.addEventListener('online', () => {
      refreshAccess().catch(() => {});
      pollStatus().catch(() => {});
    });
  }

  /* ============================= BOOT ============================= */
  async function boot() {
    bind();
    refreshNubeForm();
    const c = cloudCfg();
    if (!c.url) { applyRol(); return; }   // standalone: intacto

    const perfil = cachedPerfil();
    const refresh = lsGet(LS.refresh);
    if (perfil && refresh) {
      // offline-first: entra YA con el perfil cacheado…
      AUTH.perfil = perfil;
      applyRol();
      startStatusPoll();
      // …y reconcilia con el worker en segundo plano
      const st = await jreq('GET', '/api/cloud/status');
      if (st.status === 200 && st.body && !st.body.configurada) {
        await jreq('POST', '/api/cloud/session', {
          cloud_url: c.url, tenant: c.tenant, refresh_token: refresh, perfil,
        });
      }
      const okTok = await refreshAccess();
      if (!okTok && AUTH.offline) {
        cloudNote('Sin conexión — tus pesajes se subirán al volver la señal', true);
      }
    } else {
      applyRol();
      showLogin();
    }
  }

  boot().catch(() => {});
})();
