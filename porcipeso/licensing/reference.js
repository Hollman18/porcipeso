/* Espejo Node del algoritmo de activación por dispositivo de PorciPeso.
 *
 * Es la FUENTE PURE-JS del algoritmo (SHA-256 + HMAC-SHA256 propios, sin
 * crypto.subtle) que corre idéntico en:
 *   - la app:            porcipeso/ui/static/app.js  (bloque "LICENCIA")
 *   - la herramienta:    packaging/emitir_llave.html (bloque <script>)
 *
 * Se usa crypto propio (no crypto.subtle) para que emitir_llave.html funcione
 * con doble clic (file://), donde Chrome NO expone crypto.subtle. Los tests de
 * tests/licensing/ verifican la paridad de ESTE archivo con keygen.py; los
 * tests e2e verifican app.js y emitir_llave.html contra keygen.py.
 *
 * MODELO DE SEGURIDAD: candado de conveniencia; el secreto viaja embebido en la
 * app. Ver ~/porcipeso_secrets/README.md.
 *
 * Uso CLI (para los tests): node reference.js <deviceIdOrCode> [...]
 *   -> imprime JSON: [{device_id, device_code, activation_key}, ...]
 */
'use strict';

// ===== INICIO NÚCLEO DE LICENCIA (idéntico en app.js y emitir_llave.html) =====
// MISMO valor que keygen.py (MASTER_SECRET) y ~/porcipeso_secrets/README.md.
var LIC_SECRET = 'fc437ab3333024f51ca8cbb1d323882d3e7d43dcabbe7252748bb4a161b9d40b';

var LIC_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford (sin I,L,O,U)
var LIC_ALPHASET = new Set(LIC_ALPHABET.split(''));
var LIC_AMBIG = { O: '0', I: '1', L: '1' };

var _LIC_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
function _licRotr(x, n) { return (x >>> n) | (x << (32 - n)); }
function _licSha256(msg) { // Uint8Array -> Uint8Array(32)
  var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
      h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  var l = msg.length, withOne = l + 1;
  var k = ((56 - (withOne % 64)) + 64) % 64;
  var total = withOne + k + 8;
  var buf = new Uint8Array(total);
  buf.set(msg, 0); buf[l] = 0x80;
  var bitLen = l * 8;
  var dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, bitLen >>> 0, false);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
  var w = new Uint32Array(64);
  for (var off = 0; off < total; off += 64) {
    for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (i = 16; i < 64; i++) {
      var s0 = _licRotr(w[i-15],7) ^ _licRotr(w[i-15],18) ^ (w[i-15] >>> 3);
      var s1 = _licRotr(w[i-2],17) ^ _licRotr(w[i-2],19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    var a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (i = 0; i < 64; i++) {
      var S1 = _licRotr(e,6) ^ _licRotr(e,11) ^ _licRotr(e,25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + _LIC_K[i] + w[i]) >>> 0;
      var S0 = _licRotr(a,2) ^ _licRotr(a,13) ^ _licRotr(a,22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d + t1) >>> 0; d=c; c=b; b=a; a=(t1 + t2) >>> 0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
  }
  var outb = new Uint8Array(32), ov = new DataView(outb.buffer), hs = [h0,h1,h2,h3,h4,h5,h6,h7];
  for (i = 0; i < 8; i++) ov.setUint32(i*4, hs[i] >>> 0, false);
  return outb;
}
function _licUtf8(str) { return new Uint8Array(new TextEncoder().encode(str)); }
function _licHmac(keyStr, msgStr) { // -> Uint8Array(32)
  var key = _licUtf8(keyStr);
  if (key.length > 64) key = _licSha256(key);
  var kpad = new Uint8Array(64); kpad.set(key, 0);
  var ipad = new Uint8Array(64), opad = new Uint8Array(64);
  for (var i = 0; i < 64; i++) { ipad[i] = kpad[i] ^ 0x36; opad[i] = kpad[i] ^ 0x5c; }
  var msg = _licUtf8(msgStr);
  var inner = new Uint8Array(64 + msg.length); inner.set(ipad, 0); inner.set(msg, 64);
  var ih = _licSha256(inner);
  var outer = new Uint8Array(96); outer.set(opad, 0); outer.set(ih, 64);
  return _licSha256(outer);
}
function _licB32(bytes, length) {
  var bits = 0, value = 0, out = '';
  for (var i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += LIC_ALPHABET[(value >>> bits) & 31];
      if (out.length >= length) return out;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0 && out.length < length) out += LIC_ALPHABET[(value << (5 - bits)) & 31];
  return out.slice(0, length);
}
function licDeviceCode(deviceId) {
  var p = _licB32(_licSha256(_licUtf8(deviceId || '')), 8);
  return 'PORCI-' + p.slice(0, 4) + '-' + p.slice(4, 8);
}
function licNormalizeDeviceCode(code) {
  var s = (code || '').toUpperCase().replace(/^\s*PORCI[\s-]*/, '');
  s = Array.from(s).map(function (c) { return LIC_AMBIG[c] || c; }).join('');
  var payload = Array.from(s).filter(function (c) { return LIC_ALPHASET.has(c); })
    .join('').slice(0, 8);
  return 'PORCI-' + payload.slice(0, 4) + '-' + payload.slice(4, 8);
}
function licActivationKeyFromCode(code) {
  var canon = licNormalizeDeviceCode(code);
  var p = _licB32(_licHmac(LIC_SECRET, canon), 16);
  return p.slice(0,4) + '-' + p.slice(4,8) + '-' + p.slice(8,12) + '-' + p.slice(12,16);
}
function licActivationKey(deviceId) { return licActivationKeyFromCode(licDeviceCode(deviceId)); }
function licNormalizeKey(key) {
  var s = (key || '').toUpperCase();
  s = Array.from(s).map(function (c) { return LIC_AMBIG[c] || c; }).join('');
  return Array.from(s).filter(function (c) { return LIC_ALPHASET.has(c); }).join('');
}
// ===== FIN NÚCLEO DE LICENCIA =====

module.exports = {
  LIC_SECRET,
  deviceCode: licDeviceCode,
  normalizeDeviceCode: licNormalizeDeviceCode,
  activationKeyFromCode: licActivationKeyFromCode,
  activationKey: licActivationKey,
  normalizeKey: licNormalizeKey,
};

if (require.main === module) {
  var args = process.argv.slice(2);
  var out = args.map(function (a) {
    return { device_id: a, device_code: licDeviceCode(a), activation_key: licActivationKey(a) };
  });
  process.stdout.write(JSON.stringify(out));
}
