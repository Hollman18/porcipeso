'use strict';
/* ============================================================
   PorciPeso — telemetry.js (módulo independiente; no toca app.js)

   Envía 1 ping anónimo al abrir la app, máximo 1 por día, con POST
   directo a {cloud}/telemetry. La URL de la nube vive en UN solo
   lugar: localStorage `porcipeso_cloud_url` — si está vacía, este
   módulo NO hace nada (apagado silencioso).

   PRIVACIDAD — payload EXACTO (sin datos personales: sin nombres,
   sin correos, sin ubicación, sin contenido de pesajes):
     {
       "device_id":  "<uuid aleatorio persistente, no derivado del equipo>",
       "plataforma": "desktop-web" | "android",
       "version_app": "<versión local, p.ej. 2.1.0>",
       "tenant":     "<slug opcional, solo si el cliente lo configuró>",
       "datos": {
         "pesajes_total": <número de sesiones locales>,
         "pesajes_mes":   <sesiones del mes en curso>,
         "nube_activa":   false   // sync de nube aún no construido
       }
     }
   Los conteos salen de GET /api/stats/global (agregados, sin detalle).
   Todo error se traga en silencio: la telemetría jamás rompe la app.
   ============================================================ */
(function () {
  /* en el APK el shim (mobile/src/telemetry.ts) envía su propio ping */
  if (window.__porcipesoTelemetryNative) return;

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* incógnito */ } };

  const cloud = String(lsGet('porcipeso_cloud_url') || '').trim();
  if (!cloud) return; // sin nube configurada: no hace nada

  const today = new Date().toISOString().slice(0, 10);
  if (lsGet('porcipeso_telemetry_last') === today) return; // máx. 1/día

  let deviceId = lsGet('porcipeso_device_id');
  if (!deviceId) {
    deviceId = (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'pp-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    lsSet('porcipeso_device_id', deviceId);
  }

  const isNative = (() => {
    try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
    catch { return false; }
  })();

  const firstOfMonth = today.slice(0, 8) + '01';
  const j = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));

  Promise.all([
    j('/api/stats/global'),
    j('/api/stats/global?desde=' + firstOfMonth),
    j('/api/update/status'),
  ])
    .then(([total, mes, status]) => {
      const payload = {
        device_id: deviceId,
        plataforma: isNative ? 'android' : 'desktop-web',
        version_app: status.current || '0.0.0',
        datos: {
          pesajes_total: Number(total.sesiones) || 0,
          pesajes_mes: Number(mes.sesiones) || 0,
          nube_activa: false,
        },
      };
      const tenant = String(lsGet('porcipeso_tenant') || '').trim();
      if (tenant) payload.tenant = tenant;
      return fetch(cloud.replace(/\/+$/, '') + '/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    })
    .then((r) => {
      /* solo se marca el día si el envío llegó: si falló, se reintenta
         en la próxima apertura */
      if (r && r.ok) lsSet('porcipeso_telemetry_last', today);
    })
    .catch(() => { /* silencio: sin red / sin backend */ });
})();
