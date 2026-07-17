/* ============================================================
   PorciPeso Cloud — panel web (vanilla JS, sin dependencias)

   Una sola página con tres experiencias según el rol del login:
   - superadmin : Clientes · Telemetría · Config global
   - admin      : Pesajes · Resumen · Usuarios · Config
   - operador   : pantalla "usa la app en la báscula"

   Tokens: el access token vive SOLO en memoria; el refresh token
   se guarda en localStorage para reanudar la sesión. El access se
   renueva solo, un rato antes de expirar.
   ============================================================ */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const REFRESH_KEY = "porcipeso_cloud_refresh";

  // ------------------------------------------------------------ estado
  let accessToken = null;
  let refreshTimer = null;
  let session = null; // {email, nombre, rol, tenant:{id,slug,nombre}|null}

  // ------------------------------------------------------------ helpers
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  function fmtFecha(iso, conHora = true) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const opts = conHora
      ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }
      : { day: "2-digit", month: "short", year: "numeric" };
    return d.toLocaleString("es-MX", opts);
  }

  function fmtNum(n, dec = 0) {
    if (n === null || n === undefined) return "—";
    return Number(n).toLocaleString("es-MX", {
      minimumFractionDigits: dec, maximumFractionDigits: dec,
    });
  }

  function fmtHoraEvento(tsMs) {
    if (tsMs === null || tsMs === undefined) return "—";
    if (tsMs > 1e11) { // epoch en milisegundos → hora del día
      return new Date(tsMs).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    const s = Math.floor(tsMs / 1000); // tiempo transcurrido
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss} min`;
  }

  let toastTimer = null;
  function toast(msg, kind = "") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, 4200);
  }

  function humanError(err) {
    const raw = (err && err.message) || "";
    const mapa = [
      [/credenciales inválidas/i, "Correo o contraseña incorrectos."],
      [/demasiados intentos/i, "Demasiados intentos. Espera 15 minutos y vuelve a probar."],
      [/slug ya existe/i, "Ese slug ya está ocupado; prueba con otro."],
      [/email ya registrado/i, "Ese correo ya está registrado."],
      [/slug inválido/i, "El slug solo puede llevar minúsculas, números y guiones."],
      [/token inválido|no autorizado/i, "Tu sesión terminó. Vuelve a entrar."],
      [/failed to fetch|networkerror|load failed/i, "No hay conexión con el servidor. Revisa tu internet."],
    ];
    for (const [re, msg] of mapa) if (re.test(raw)) return msg;
    return raw || "Algo salió mal. Inténtalo de nuevo.";
  }

  // ------------------------------------------------------------ auth/API
  function saveTokens(pair) {
    accessToken = pair.access_token;
    localStorage.setItem(REFRESH_KEY, pair.refresh_token);
    // Renovar solo: un minuto antes de expirar (nunca antes de 5 s).
    clearTimeout(refreshTimer);
    const ms = Math.max((Number(pair.expires_in || 900) - 60) * 1000, 5000);
    refreshTimer = setTimeout(() => { doRefresh().catch(() => forceLogin()); }, ms);
  }

  function clearTokens() {
    accessToken = null;
    session = null;
    clearTimeout(refreshTimer);
    localStorage.removeItem(REFRESH_KEY);
  }

  async function rawJson(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false && accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* respuesta sin cuerpo */ }
    if (!res.ok) {
      const detail = data && data.detail;
      const msg = typeof detail === "string" ? detail
        : Array.isArray(detail) && detail[0] && detail[0].msg
          ? `Dato inválido: ${detail[0].msg}` : `error ${res.status}`;
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  async function doRefresh() {
    const rt = localStorage.getItem(REFRESH_KEY);
    if (!rt) throw new Error("no autorizado");
    const pair = await rawJson("/auth/refresh", {
      method: "POST", auth: false, body: { refresh_token: rt },
    });
    saveTokens(pair);
    return pair;
  }

  /** fetch con Bearer + reintento único tras refrescar si hubo 401. */
  async function api(path, opts = {}) {
    try {
      return await rawJson(path, opts);
    } catch (e) {
      if (e.status === 401 && opts.auth !== false) {
        try { await doRefresh(); } catch { forceLogin(); throw e; }
        return rawJson(path, opts);
      }
      throw e;
    }
  }

  async function doLogout() {
    const rt = localStorage.getItem(REFRESH_KEY);
    if (rt) { try { await rawJson("/auth/logout", { method: "POST", auth: false, body: { refresh_token: rt } }); } catch { /* da igual */ } }
    forceLogin();
  }

  function forceLogin(msg) {
    clearTokens();
    showScreen("login");
    if (msg) { const el = $("#loginError"); el.textContent = msg; el.classList.add("show"); }
  }

  // ------------------------------------------------------------ pantallas
  function showScreen(name) {
    $("#viewLogin").hidden = name !== "login";
    $("#viewOperador").hidden = name !== "operador";
    $("#appShell").hidden = name !== "app";
    $("#tabbar").hidden = name !== "app";
  }

  const NAVS = {
    superadmin: [
      { id: "clientes", label: "Clientes", ic: "🏠", load: loadTenants },
      { id: "telemetria", label: "Telemetría", ic: "📡", load: loadTelemetria },
      { id: "configGlobal", label: "Config global", ic: "⚙️", load: loadConfigGlobal },
    ],
    admin: [
      { id: "pesajes", label: "Pesajes", ic: "⚖️", load: loadSesiones },
      { id: "resumen", label: "Resumen", ic: "📊", load: loadResumen },
      { id: "usuarios", label: "Usuarios", ic: "👥", load: loadUsers },
      { id: "configTenant", label: "Config", ic: "⚙️", load: loadConfigTenant },
    ],
  };
  let currentNav = [];

  function switchView(id) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    const sec = $(`#view-${id}`);
    if (sec) sec.classList.add("active");
    document.querySelectorAll(".navbtn,.tabbtn").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === id));
    const item = currentNav.find((n) => n.id === id);
    if (item && item.load) item.load().catch((e) => toast(humanError(e), "err"));
  }

  function renderNav(items) {
    currentNav = items;
    $("#navList").innerHTML = items.map((n) =>
      `<button class="navbtn" data-view="${n.id}"><span class="ic">${n.ic}</span>${esc(n.label)}</button>`).join("");
    $("#tabbar").innerHTML = items.map((n) =>
      `<button class="tabbtn" data-view="${n.id}"><span class="ic">${n.ic}</span>${esc(n.label)}</button>`).join("");
    document.querySelectorAll("[data-view]").forEach((b) =>
      b.addEventListener("click", () => switchView(b.dataset.view)));
  }

  async function enterApp() {
    session = await api("/panel/session");
    if (session.rol === "operador") { showScreen("operador"); return; }
    const items = NAVS[session.rol];
    if (!items) { forceLogin("Tu cuenta no tiene acceso a este panel."); return; }
    $("#whoName").textContent = session.nombre || session.email;
    $("#whoRole").textContent = session.rol === "superadmin"
      ? "Superadmin" : `Admin · ${session.tenant ? session.tenant.nombre : ""}`;
    $("#navSubtitle").textContent = session.rol === "superadmin"
      ? "Panel de la plataforma" : (session.tenant ? session.tenant.nombre : "Panel de la nube");
    renderNav(items);
    showScreen("app");
    switchView(items[0].id);
  }

  // ============================================================ LOGIN
  $("#formLogin").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $("#loginError");
    err.classList.remove("show");
    const btn = $("#btnLogin");
    btn.disabled = true; btn.textContent = "Entrando…";
    try {
      const pair = await rawJson("/auth/login", {
        method: "POST", auth: false,
        body: { email: $("#loginEmail").value.trim(), password: $("#loginPass").value },
      });
      saveTokens(pair);
      $("#loginPass").value = "";
      await enterApp();
    } catch (e) {
      err.textContent = humanError(e);
      err.classList.add("show");
    } finally {
      btn.disabled = false; btn.textContent = "Entrar";
    }
  });

  $("#btnLogout").addEventListener("click", doLogout);
  $("#btnLogoutMobile").addEventListener("click", doLogout);
  $("#btnLogoutOperador").addEventListener("click", doLogout);

  // ------------------------------------------------------------ diálogos
  function openDlg(dlg) {
    dlg.querySelectorAll(".form-error").forEach((e) => e.classList.remove("show"));
    dlg.showModal();
  }
  document.querySelectorAll("dialog .dlg-cancel").forEach((b) =>
    b.addEventListener("click", () => b.closest("dialog").close()));

  function showFormError(sel, e) {
    const el = $(sel);
    el.textContent = humanError(e);
    el.classList.add("show");
  }

  // ============================================================ SUPERADMIN
  // ------------------------------------------------- Clientes (tenants)
  async function loadTenants() {
    const tenants = await api("/admin/tenants");
    $("#emptyTenants").hidden = tenants.length > 0;
    $("#tbodyTenants").innerHTML = tenants.map((t) => `
      <tr>
        <td><b>${esc(t.nombre)}</b></td>
        <td class="mono">${esc(t.slug)}</td>
        <td>${fmtNum(t.usuarios)}</td>
        <td><span class="pill ${t.activo ? "on" : "off"}">${t.activo ? "Activo" : "Inactivo"}</span></td>
        <td>${fmtFecha(t.creado_en, false)}</td>
        <td><div class="rowactions">
          <button class="btn-xs ${t.activo ? "btn-danger" : "btn-primary"}"
                  data-toggle-tenant="${t.id}" data-activo="${t.activo ? 1 : 0}">
            ${t.activo ? "Desactivar" : "Activar"}
          </button>
        </div></td>
      </tr>`).join("");
    document.querySelectorAll("[data-toggle-tenant]").forEach((b) =>
      b.addEventListener("click", async () => {
        const activar = b.dataset.activo !== "1";
        try {
          const t = await api(`/admin/tenants/${b.dataset.toggleTenant}`, {
            method: "PATCH", body: { activo: activar },
          });
          toast(activar ? `«${t.nombre}» quedó activo.` : `«${t.nombre}» quedó desactivado: su gente ya no puede entrar.`, "ok");
          loadTenants();
        } catch (e) { toast(humanError(e), "err"); }
      }));
  }

  // Slug auto-sugerido a partir del nombre (editable).
  let slugTocado = false;
  const sugerirSlug = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  $("#tNombre").addEventListener("input", () => {
    if (!slugTocado) $("#tSlug").value = sugerirSlug($("#tNombre").value);
  });
  $("#tSlug").addEventListener("input", () => { slugTocado = true; });

  $("#btnNuevoTenant").addEventListener("click", () => {
    $("#formTenant").reset();
    slugTocado = false;
    openDlg($("#dlgTenant"));
  });

  $("#formTenant").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const out = await api("/admin/tenants", {
        method: "POST",
        body: {
          nombre: $("#tNombre").value.trim(),
          slug: $("#tSlug").value.trim(),
          admin_email: $("#tEmail").value.trim(),
          admin_password: $("#tPass").value,
        },
      });
      $("#dlgTenant").close();
      toast(`Cliente «${out.tenant.nombre}» creado, con su admin ${out.admin.email}.`, "ok");
      loadTenants();
    } catch (e) { showFormError("#tenantError", e); }
  });

  // ---------------------------------------------------------- Telemetría
  async function loadTelemetria() {
    const filas = await api("/admin/telemetria");
    $("#emptyTelemetria").hidden = filas.length > 0;
    const dispositivos = filas.reduce((a, f) => a + (f.dispositivos || 0), 0);
    const reportes = filas.reduce((a, f) => a + (f.reportes || 0), 0);
    const clientes = new Set(filas.map((f) => f.tenant || "(sin cliente)")).size;
    $("#telemetriaTotales").innerHTML = `
      <div class="gstat"><div class="k">Dispositivos</div><div class="v">${fmtNum(dispositivos)}</div></div>
      <div class="gstat"><div class="k">Reportes</div><div class="v">${fmtNum(reportes)}</div></div>
      <div class="gstat"><div class="k">Clientes reportando</div><div class="v">${fmtNum(filas.length ? clientes : 0)}</div></div>`;
    $("#tbodyTelemetria").innerHTML = filas.map((f) => `
      <tr>
        <td>${f.tenant ? `<b>${esc(f.tenant)}</b>` : '<span class="chip">sin cliente</span>'}</td>
        <td>${esc(f.plataforma || "—")}</td>
        <td class="mono">${esc(f.version_app || "—")}</td>
        <td>${fmtNum(f.dispositivos)}</td>
        <td>${fmtNum(f.reportes)}</td>
        <td>${fmtFecha(f.ultimo)}</td>
      </tr>`).join("");
  }
  $("#btnRecargarTelemetria").addEventListener("click", () =>
    loadTelemetria().then(() => toast("Telemetría actualizada.", "ok")).catch((e) => toast(humanError(e), "err")));

  // -------------------------------------------------------- Config global
  let bannersGlobal = [];

  async function loadConfigGlobal() {
    const cfg = await api("/config/app", { auth: false });
    $("#cfgLatest").value = cfg.latest_version || "";
    $("#cfgMin").value = cfg.min_version || "";
    $("#cfgApk").value = cfg.apk_url || "";
    bannersGlobal = Array.isArray(cfg.banners) ? cfg.banners : [];
    renderBanners("#listaBannersGlobal", bannersGlobal, "global");
  }

  $("#btnGuardarConfigGlobal").addEventListener("click", async () => {
    try {
      const pares = [
        ["latest_version", $("#cfgLatest").value.trim() || null],
        ["min_version", $("#cfgMin").value.trim() || null],
        ["apk_url", $("#cfgApk").value.trim() || null],
      ];
      for (const [clave, valor] of pares) {
        await api(`/admin/config/${clave}`, { method: "PUT", body: { valor } });
      }
      toast("Config de versión guardada. Las apps la verán en su próximo arranque.", "ok");
    } catch (e) { toast(humanError(e), "err"); }
  });

  // ============================================================ ADMIN
  // ------------------------------------------------------------ Pesajes
  async function loadSesiones() {
    $("#pesajeDetalle").hidden = true;
    $("#pesajesLista").hidden = false;
    const p = new URLSearchParams();
    if ($("#fDesde").value) p.set("desde", $("#fDesde").value);
    if ($("#fHasta").value) p.set("hasta", $("#fHasta").value);
    if ($("#fQ").value.trim()) p.set("q", $("#fQ").value.trim());
    const qs = p.toString() ? `?${p}` : "";
    const sesiones = await api(`/sync/sesiones${qs}`);
    $("#emptySesiones").hidden = sesiones.length > 0;
    $("#tbodySesiones").innerHTML = sesiones.map((s) => `
      <tr class="rowlink" data-sesion="${esc(s.uuid)}" data-lote="${esc(s.lote || "")}">
        <td>${fmtFecha(s.hora_entrada)}</td>
        <td><b>${esc(s.lote || "—")}</b></td>
        <td>${esc(s.corral_origen || "—")}</td>
        <td>${esc(s.destino || "—")}</td>
        <td>${fmtNum(s.total_animales)}</td>
        <td>${s.total_kg == null ? "—" : fmtNum(s.total_kg, 1) + " kg"}</td>
        <td>${s.promedio_final == null ? "—" : fmtNum(s.promedio_final, 1) + " kg"}</td>
        <td><span class="pill ${esc(s.estado)}">${esc(s.estado)}</span></td>
      </tr>`).join("");
    document.querySelectorAll("[data-sesion]").forEach((tr) =>
      tr.addEventListener("click", () =>
        openDetalle(tr.dataset.sesion, sesiones.find((x) => x.uuid === tr.dataset.sesion))));
  }

  $("#formFiltros").addEventListener("submit", (ev) => {
    ev.preventDefault();
    loadSesiones().catch((e) => toast(humanError(e), "err"));
  });
  $("#btnLimpiarFiltros").addEventListener("click", () => {
    $("#fDesde").value = ""; $("#fHasta").value = ""; $("#fQ").value = "";
    loadSesiones().catch((e) => toast(humanError(e), "err"));
  });
  $("#btnVolverPesajes").addEventListener("click", () => {
    $("#pesajeDetalle").hidden = true;
    $("#pesajesLista").hidden = false;
  });

  const TIPO_EVENTO = {
    referencia: "Peso de referencia",
    subida: "Subieron animales",
    bajada: "Bajaron animales",
    reingreso: "Reingreso",
    ajuste: "Ajuste manual",
  };

  async function openDetalle(uuid, sesion) {
    const eventos = await api(`/sync/sesiones/${encodeURIComponent(uuid)}/eventos`);
    $("#pesajesLista").hidden = true;
    $("#pesajeDetalle").hidden = false;
    const s = sesion || {};
    $("#detTitulo").textContent = s.lote ? `Pesaje · ${s.lote}` : "Pesaje";
    $("#detStats").innerHTML = `
      <div class="gstat"><div class="k">Fecha</div><div class="v" style="font-size:18px">${fmtFecha(s.hora_entrada)}</div></div>
      <div class="gstat"><div class="k">Animales</div><div class="v">${fmtNum(s.total_animales)}</div></div>
      <div class="gstat"><div class="k">Kilos</div><div class="v">${s.total_kg == null ? "—" : fmtNum(s.total_kg, 1)}<em> kg</em></div></div>
      <div class="gstat"><div class="k">Promedio</div><div class="v">${s.promedio_final == null ? "—" : fmtNum(s.promedio_final, 1)}<em> kg</em></div></div>
      <div class="gstat"><div class="k">Corral</div><div class="v" style="font-size:20px">${esc(s.corral_origen || "—")}</div></div>
      <div class="gstat"><div class="k">Destino</div><div class="v" style="font-size:20px">${esc(s.destino || "—")}</div></div>`;
    $("#emptyEventos").hidden = eventos.length > 0;
    $("#tbodyEventos").innerHTML = eventos.map((e) => `
      <tr>
        <td>${fmtHoraEvento(e.ts_ms)}</td>
        <td>${esc(TIPO_EVENTO[e.tipo] || e.tipo)}${e.ambiguo ? ' <span class="chip">ambiguo</span>' : ""}</td>
        <td>${fmtNum(e.delta_kg, 1)} kg</td>
        <td>${fmtNum(e.animales_confirmados ?? e.animales_estimados)}</td>
        <td>${e.animales_confirmados != null ? "Sí" : "—"}</td>
        <td>${esc(e.motivo_bajada || "")}</td>
      </tr>`).join("");
  }

  // ------------------------------------------------------------ Resumen
  async function loadResumen() {
    const st = await api("/sync/stats/global");
    const vacio = !st.sesiones;
    $("#emptyResumen").hidden = !vacio;
    $("#resumenStats").innerHTML = `
      <div class="gstat"><div class="k">Pesajes</div><div class="v">${fmtNum(st.sesiones)}</div></div>
      <div class="gstat"><div class="k">Animales</div><div class="v">${fmtNum(st.total_animales)}</div></div>
      <div class="gstat"><div class="k">Kilos totales</div><div class="v">${fmtNum(st.total_kg, 1)}<em> kg</em></div></div>
      <div class="gstat"><div class="k">Promedio global</div><div class="v">${st.promedio_global == null ? "—" : fmtNum(st.promedio_global, 1)}<em> kg</em></div></div>`;
    $("#resumenLotes").innerHTML = (st.por_lote || []).map((l) => `
      <div class="lotecard">
        <div class="ln">${esc(l.lote)}</div>
        <div class="lm">
          <b>${fmtNum(l.animales)}</b> animales · <b>${fmtNum(l.kg, 1)}</b> kg<br>
          promedio <b>${l.promedio == null ? "—" : fmtNum(l.promedio, 1)}</b> kg ·
          ${fmtFecha(l.ultima_fecha, false)}
        </div>
      </div>`).join("") || "";
  }
  $("#btnRecargarResumen").addEventListener("click", () =>
    loadResumen().then(() => toast("Resumen actualizado.", "ok")).catch((e) => toast(humanError(e), "err")));

  // ----------------------------------------------------------- Usuarios
  async function loadUsers() {
    const users = await api("/tenant/users");
    $("#emptyUsers").hidden = users.length > 0;
    $("#tbodyUsers").innerHTML = users.map((u) => `
      <tr>
        <td><b>${esc(u.email)}</b></td>
        <td>${esc(u.nombre || "—")}</td>
        <td><span class="pill rol ${esc(u.rol)}">${u.rol === "admin" ? "Administrador" : "Operador"}</span></td>
        <td><span class="pill ${u.activo ? "on" : "off"}">${u.activo ? "Activo" : "Inactivo"}</span></td>
        <td><div class="rowactions">
          <button class="btn-xs ${u.activo ? "btn-danger" : "btn-primary"}"
                  data-user-toggle="${esc(u.uuid)}" data-activo="${u.activo ? 1 : 0}">
            ${u.activo ? "Desactivar" : "Activar"}</button>
          <button class="btn-xs" data-user-rol="${esc(u.uuid)}" data-rol="${esc(u.rol)}">
            Hacer ${u.rol === "admin" ? "operador" : "admin"}</button>
          <button class="btn-xs" data-user-pass="${esc(u.uuid)}" data-email="${esc(u.email)}">
            Contraseña</button>
        </div></td>
      </tr>`).join("");
    const patchUser = async (uuid, body, okMsg) => {
      try {
        await api(`/tenant/users/${encodeURIComponent(uuid)}`, { method: "PATCH", body });
        toast(okMsg, "ok");
        loadUsers();
      } catch (e) { toast(humanError(e), "err"); }
    };
    document.querySelectorAll("[data-user-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const activar = b.dataset.activo !== "1";
        patchUser(b.dataset.userToggle, { activo: activar },
          activar ? "Usuario activado." : "Usuario desactivado: ya no puede entrar.");
      }));
    document.querySelectorAll("[data-user-rol]").forEach((b) =>
      b.addEventListener("click", () => {
        const nuevo = b.dataset.rol === "admin" ? "operador" : "admin";
        patchUser(b.dataset.userRol, { rol: nuevo },
          nuevo === "admin" ? "Ahora es administrador." : "Ahora es operador.");
      }));
    document.querySelectorAll("[data-user-pass]").forEach((b) =>
      b.addEventListener("click", () => {
        $("#formPassword").reset();
        $("#passSub").textContent = `Nueva contraseña para ${b.dataset.email}.`;
        $("#formPassword").dataset.uuid = b.dataset.userPass;
        openDlg($("#dlgPassword"));
      }));
  }

  $("#btnNuevoUsuario").addEventListener("click", () => {
    $("#formUsuario").reset();
    openDlg($("#dlgUsuario"));
  });

  $("#formUsuario").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const u = await api("/tenant/users", {
        method: "POST",
        body: {
          email: $("#uEmail").value.trim(),
          nombre: $("#uNombre").value.trim() || null,
          password: $("#uPass").value,
          rol: $("#uRol").value,
        },
      });
      $("#dlgUsuario").close();
      toast(`Usuario ${u.email} creado.`, "ok");
      loadUsers();
    } catch (e) { showFormError("#usuarioError", e); }
  });

  $("#formPassword").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api(`/tenant/users/${encodeURIComponent($("#formPassword").dataset.uuid)}`, {
        method: "PATCH", body: { password: $("#pPass").value },
      });
      $("#dlgPassword").close();
      toast("Contraseña cambiada.", "ok");
    } catch (e) { showFormError("#passwordError", e); }
  });

  // ------------------------------------------------------ Config (tenant)
  let bannersTenant = [];

  async function loadConfigTenant() {
    // /config/app concatena: banners globales primero, luego los del
    // tenant. Restamos los globales para editar SOLO los propios.
    const global = await api("/config/app", { auth: false });
    const nGlobales = (global.banners || []).length;
    let propios = [];
    if (session && session.tenant) {
      const merged = await api(`/config/app?tenant=${encodeURIComponent(session.tenant.slug)}`, { auth: false });
      propios = (merged.banners || []).slice(nGlobales);
    }
    bannersTenant = propios;
    renderBanners("#listaBannersTenant", bannersTenant, "tenant");
  }

  // ------------------------------------------- editor de avisos (ambos)
  function renderBanners(sel, lista, ambito) {
    const cont = $(sel);
    if (!lista.length) {
      cont.innerHTML = `<p class="empty">No hay avisos. Crea uno con «Nuevo aviso».</p>`;
      return;
    }
    cont.innerHTML = lista.map((b, i) => `
      <div class="banneritem">
        <div class="bt">
          <div class="txt">${esc(b.texto || "(sin texto)")}</div>
          <div class="meta">
            id: <span class="mono">${esc(b.id || "—")}</span>
            ${b.boton ? ` · botón: «${esc(b.boton)}»` : ""}
            ${b.url ? ` · ${esc(b.url)}` : ""}
            ${b.desde || b.hasta ? ` · vigencia: ${esc(b.desde || "…")} → ${esc(b.hasta || "…")}` : ""}
            ${b.solo_sin_nube ? " · solo básculas sin nube" : ""}
          </div>
        </div>
        <div class="rowactions">
          <button class="btn-xs" data-banner-edit="${i}" data-ambito="${ambito}">Editar</button>
          <button class="btn-xs btn-danger" data-banner-del="${i}" data-ambito="${ambito}">Quitar</button>
        </div>
      </div>`).join("");
    cont.querySelectorAll("[data-banner-edit]").forEach((btn) =>
      btn.addEventListener("click", () =>
        openBannerDlg(btn.dataset.ambito, Number(btn.dataset.bannerEdit))));
    cont.querySelectorAll("[data-banner-del]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const amb = btn.dataset.ambito;
        const lista2 = amb === "global" ? bannersGlobal : bannersTenant;
        lista2.splice(Number(btn.dataset.bannerDel), 1);
        try {
          await saveBanners(amb);
          toast("Aviso quitado.", "ok");
        } catch (e) { toast(humanError(e), "err"); }
      }));
  }

  async function saveBanners(ambito) {
    if (ambito === "global") {
      await api("/admin/config/banners", { method: "PUT", body: { valor: bannersGlobal } });
      renderBanners("#listaBannersGlobal", bannersGlobal, "global");
    } else {
      await api("/tenant/config/banners", { method: "PUT", body: { valor: bannersTenant } });
      renderBanners("#listaBannersTenant", bannersTenant, "tenant");
    }
  }

  function openBannerDlg(ambito, index = -1) {
    const form = $("#formBanner");
    form.reset();
    form.dataset.ambito = ambito;
    form.dataset.index = String(index);
    const lista = ambito === "global" ? bannersGlobal : bannersTenant;
    const b = index >= 0 ? lista[index] : null;
    $("#bannerTitle").textContent = b ? "Editar aviso" : "Nuevo aviso";
    if (b) {
      $("#bId").value = b.id || "";
      $("#bTexto").value = b.texto || "";
      $("#bBoton").value = b.boton || "";
      $("#bUrl").value = b.url || "";
      $("#bDesde").value = b.desde || "";
      $("#bHasta").value = b.hasta || "";
      $("#bSoloSinNube").checked = !!b.solo_sin_nube;
    }
    openDlg($("#dlgBanner"));
  }

  $("#btnNuevoBannerGlobal").addEventListener("click", () => openBannerDlg("global"));
  $("#btnNuevoBannerTenant").addEventListener("click", () => openBannerDlg("tenant"));

  $("#formBanner").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = $("#formBanner");
    const ambito = form.dataset.ambito;
    const index = Number(form.dataset.index);
    const lista = ambito === "global" ? bannersGlobal : bannersTenant;
    const banner = {
      id: $("#bId").value.trim(),
      texto: $("#bTexto").value.trim(),
      boton: $("#bBoton").value.trim() || null,
      url: $("#bUrl").value.trim() || null,
      desde: $("#bDesde").value || null,
      hasta: $("#bHasta").value || null,
      solo_sin_nube: $("#bSoloSinNube").checked,
    };
    if (!banner.id || !banner.texto) {
      showFormError("#bannerError", new Error("El aviso necesita un id y un texto."));
      return;
    }
    const duplicado = lista.some((x, i) => x.id === banner.id && i !== index);
    if (duplicado) {
      showFormError("#bannerError", new Error("Ya hay un aviso con ese id; usa otro."));
      return;
    }
    if (index >= 0) lista[index] = banner; else lista.push(banner);
    try {
      await saveBanners(ambito);
      $("#dlgBanner").close();
      toast("Aviso guardado. Las apps lo verán en su próximo arranque.", "ok");
    } catch (e) {
      if (index >= 0) { /* se queda el valor editado en memoria; el server manda */ }
      showFormError("#bannerError", e);
    }
  });

  // ============================================================ arranque
  (async () => {
    if (localStorage.getItem(REFRESH_KEY)) {
      try {
        await doRefresh();
        await enterApp();
        return;
      } catch { clearTokens(); }
    }
    showScreen("login");
  })();
})();
