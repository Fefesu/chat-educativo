// ============================================================
// Verificación de correo y recuperación de contraseña
// - Los enlaces son de un solo uso y caducan.
// - En la base de datos solo se guarda el "hash" del enlace, nunca el enlace.
// - Las respuestas son iguales exista o no la cuenta (no se revela quién está registrado).
// - El correo se envía por la API web de Brevo (Render gratis bloquea el SMTP).
// ============================================================
const crypto = require('crypto');

const MIN_CONTRASENA = 8;
const MAX_CONTRASENA = 64; // bcrypt solo usa los primeros 72 bytes
const CADUCIDAD_RECUPERAR_MIN = 30;
const CADUCIDAD_VERIFICAR_MIN = 24 * 60;
const HORA_MS = 60 * 60 * 1000;
const MENSAJE_GENERICO = 'Si los datos coinciden con una cuenta con el correo confirmado, te hemos enviado un enlace. Puede tardar unos minutos; revisa también la carpeta de spam. El enlace caduca en 30 minutos.';

function crearRecuperacion({ app, bcrypt, getUsuarios, getTokens, alCambiarContrasena, fetchFn, env }) {
  env = env || process.env;
  const llamar = fetchFn || globalThis.fetch;
  const baseUrl = (env.URL_PUBLICA || 'https://chat-educativo-qgub.onrender.com').replace(/\/$/, '');

  const activo = () => !!(env.BREVO_API_KEY && env.EMAIL_REMITENTE);

  // ---------- Límites de intentos (en memoria) ----------
  const golpes = new Map();
  function permitir(clave, max, ventanaMs) {
    const ahora = Date.now();
    const lista = (golpes.get(clave) || []).filter(t => ahora - t < ventanaMs);
    if (lista.length >= max) { golpes.set(clave, lista); return false; }
    lista.push(ahora);
    golpes.set(clave, lista);
    return true;
  }
  setInterval(() => {
    const ahora = Date.now();
    for (const [k, lista] of golpes) {
      const vivos = lista.filter(t => ahora - t < HORA_MS);
      if (vivos.length) golpes.set(k, vivos); else golpes.delete(k);
    }
  }, 10 * 60 * 1000).unref();

  // Render pasa todo el tráfico por Cloudflare, que escribe la IP real del visitante en CF-Connecting-IP
  // (y no se puede falsificar a través de él). Si no viene, se usa el último valor de X-Forwarded-For.
  function ipDe(req) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const partes = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    return partes.length ? partes[partes.length - 1] : (req.socket.remoteAddress || '');
  }

  // ---------- Utilidades ----------
  const normalizarEmail = (e) => String(e || '').trim().toLowerCase();
  const emailValido = (e) => e.length <= 254 && /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[a-z]{2,}$/i.test(e);
  function enmascarar(e) {
    const [local, dominio] = String(e).split('@');
    return `${local.slice(0, 1)}***@${dominio}`;
  }
  function validarContrasena(p, usuarioClave) {
    if (p.length < MIN_CONTRASENA) return `La contraseña debe tener al menos ${MIN_CONTRASENA} caracteres.`;
    if (p.length > MAX_CONTRASENA) return `La contraseña no puede tener más de ${MAX_CONTRASENA} caracteres.`;
    if (usuarioClave && p.toLowerCase() === usuarioClave) return 'La contraseña no puede ser igual que tu nombre de usuario.';
    return null;
  }
  const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

  async function crearToken(tipo, usuarioClave, minutos, extra) {
    const tokens = getTokens();
    const crudo = crypto.randomBytes(32).toString('hex');
    await tokens.deleteMany({ tipo, usuarioClave }); // un enlace nuevo anula el anterior
    await tokens.insertOne({ tipo, usuarioClave, hash: hashToken(crudo), expira: new Date(Date.now() + minutos * 60000), creado: new Date(), ...extra });
    return crudo;
  }
  const formatoToken = (t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);

  // ---------- Envío de correo (API de Brevo) ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function plantilla({ titulo, parrafos, boton, url, pie }) {
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1E1B3A">
<h2 style="margin:0 0 16px;color:#6D4AFF">${esc(titulo)}</h2>
${parrafos.map(p => `<p style="font-size:15px;line-height:1.5;margin:0 0 14px">${esc(p)}</p>`).join('')}
${url ? `<p style="margin:22px 0"><a href="${esc(url)}" style="background:#6D4AFF;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:bold;display:inline-block">${esc(boton)}</a></p>
<p style="font-size:12px;color:#6B678C;word-break:break-all">Si el botón no funciona, copia este enlace en tu navegador:<br>${esc(url)}</p>` : ''}
<p style="font-size:12px;color:#6B678C;margin-top:22px">${esc(pie)}</p></div>`;
    const texto = `${titulo}\n\n${parrafos.join('\n\n')}\n\n${url ? url + '\n\n' : ''}${pie}`;
    return { html, texto };
  }

  async function enviarCorreo(para, asunto, contenido) {
    if (!activo()) return false;
    try {
      const r = await llamar('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': env.BREVO_API_KEY },
        body: JSON.stringify({
          sender: { name: 'La Plaza', email: env.EMAIL_REMITENTE },
          to: [{ email: para }],
          subject: asunto,
          textContent: contenido.texto,
          htmlContent: contenido.html
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) {
        let detalle = '';
        try { detalle = (await r.text()).slice(0, 200); } catch (e) { /* nada */ }
        console.error('Correo: Brevo respondió', r.status, detalle);
        return false;
      }
      return true;
    } catch (e) {
      console.error('Correo: error al enviar:', e.message);
      return false;
    }
  }

  // ---------- Funciones que usa el servidor del chat ----------
  async function enviarVerificacion(doc, email) {
    try {
      const token = await crearToken('verificar', doc.usuarioClave, CADUCIDAD_VERIFICAR_MIN, { email });
      return await enviarCorreo(email, 'Confirma tu correo en La Plaza', plantilla({
        titulo: 'Confirma tu correo',
        parrafos: [`Hola ${doc.usuario}, confirma que este correo es tuyo para poder recuperar tu contraseña si algún día la olvidas.`, 'El enlace caduca en 24 horas.'],
        boton: 'Confirmar mi correo',
        url: `${baseUrl}/recuperar.html#v=${token}`,
        pie: 'Si tú no has creado esta cuenta en La Plaza, ignora este mensaje y no pasará nada.'
      }));
    } catch (e) {
      console.error('Verificación:', e.message);
      return false;
    }
  }

  function avisarCambioCorreo(emailAnterior, usuario) {
    return enviarCorreo(emailAnterior, 'Se ha cambiado el correo de tu cuenta en La Plaza', plantilla({
      titulo: 'Cambio de correo',
      parrafos: [`El correo de recuperación de la cuenta "${usuario}" se ha cambiado por otro.`, 'Si has sido tú, no tienes que hacer nada. Si no has sido tú, contacta cuanto antes con laplazaayuda@gmail.com.'],
      pie: 'Este aviso se envía a la dirección anterior por seguridad.'
    }));
  }

  function avisarEliminacion(email, usuario) {
    return enviarCorreo(email, 'Tu cuenta de La Plaza se ha eliminado', plantilla({
      titulo: 'Cuenta eliminada',
      parrafos: [`La cuenta "${usuario}" y sus datos se han eliminado de La Plaza.`, 'Si no has sido tú, contacta cuanto antes con laplazaayuda@gmail.com.'],
      pie: 'Este aviso se envía automáticamente por seguridad.'
    }));
  }

  // ---------- Rutas web ----------
  const noCache = (res) => res.set('Cache-Control', 'no-store');

  // 1) Pedir el enlace de recuperación
  app.post('/api/cuenta/recuperar', async (req, res) => {
    noCache(res);
    if (!activo() || !getUsuarios() || !getTokens()) {
      return res.status(503).json({ error: 'La recuperación por correo no está disponible ahora mismo. Contacta con el administrador del chat.' });
    }
    if (!permitir('rec-ip:' + ipDe(req), 5, HORA_MS)) {
      return res.status(429).json({ error: 'Demasiados intentos. Inténtalo de nuevo más tarde.' });
    }
    const cuerpo = req.body || {};
    const usuario = String(cuerpo.usuario || '').trim().slice(0, 40);
    const email = normalizarEmail(cuerpo.email);
    if (!usuario || !emailValido(email)) {
      return res.status(400).json({ error: 'Escribe tu nombre de usuario y un correo válido.' });
    }
    // Se responde ya, igual en todos los casos, y el resto se hace después:
    // así no se puede averiguar si una cuenta existe ni por el mensaje ni por el tiempo de respuesta.
    res.json({ ok: true, mensaje: MENSAJE_GENERICO });
    try {
      const uClave = usuario.toLowerCase();
      const doc = await getUsuarios().findOne({ usuarioClave: uClave });
      if (!doc || !doc.emailVerificado || doc.email !== email) return;
      if (!permitir('rec-cta:' + uClave, 3, HORA_MS)) return; // máximo 3 correos por hora y cuenta
      const token = await crearToken('reset', uClave, CADUCIDAD_RECUPERAR_MIN);
      await enviarCorreo(email, 'Recupera tu contraseña de La Plaza', plantilla({
        titulo: 'Recupera tu contraseña',
        parrafos: [`Hola ${doc.usuario}, has pedido restablecer tu contraseña.`, 'Pulsa el botón para elegir una nueva. El enlace funciona una sola vez y caduca en 30 minutos.'],
        boton: 'Elegir nueva contraseña',
        url: `${baseUrl}/recuperar.html#r=${token}`,
        pie: 'Si no lo has pedido tú, ignora este mensaje: tu contraseña actual sigue siendo la misma.'
      }));
    } catch (e) {
      console.error('Recuperación:', e.message);
    }
  });

  // 2) Elegir la nueva contraseña con el enlace
  app.post('/api/cuenta/restablecer', async (req, res) => {
    noCache(res);
    const tokens = getTokens();
    const usuarios = getUsuarios();
    if (!tokens || !usuarios) return res.status(503).json({ error: 'No disponible ahora mismo.' });
    if (!permitir('res-ip:' + ipDe(req), 10, HORA_MS)) return res.status(429).json({ error: 'Demasiados intentos. Inténtalo más tarde.' });

    const cuerpo = req.body || {};
    const invalido = () => res.status(400).json({ error: 'El enlace no es válido o ha caducado. Pide uno nuevo desde la pantalla de acceso.' });
    if (!formatoToken(cuerpo.token)) return invalido();
    const hash = hashToken(cuerpo.token);
    const filtro = { tipo: 'reset', hash, expira: { $gt: new Date() } };
    try {
      const t = await tokens.findOne(filtro);
      if (!t) return invalido();
      const p = String(cuerpo.contrasena || '');
      const errorContrasena = validarContrasena(p, t.usuarioClave);
      if (errorContrasena) return res.status(400).json({ error: errorContrasena }); // el enlace sigue valiendo
      const usado = await tokens.findOneAndDelete(filtro); // un solo uso, atómico
      if (!usado) return invalido();
      const doc = await usuarios.findOne({ usuarioClave: usado.usuarioClave });
      if (!doc) return invalido();

      await usuarios.updateOne({ usuarioClave: doc.usuarioClave }, { $set: { hash: await bcrypt.hash(p, 10), contrasenaCambiada: new Date() } });
      await tokens.deleteMany({ tipo: 'reset', usuarioClave: doc.usuarioClave });
      if (alCambiarContrasena) alCambiarContrasena(doc.usuarioClave);
      if (doc.email && doc.emailVerificado) {
        enviarCorreo(doc.email, 'Tu contraseña de La Plaza ha cambiado', plantilla({
          titulo: 'Contraseña cambiada',
          parrafos: [`La contraseña de la cuenta "${doc.usuario}" se acaba de cambiar.`, 'Si has sido tú, no tienes que hacer nada. Si no has sido tú, contacta cuanto antes con laplazaayuda@gmail.com.'],
          pie: 'Este aviso se envía automáticamente por seguridad.'
        }));
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('Restablecer:', e.message);
      res.status(500).json({ error: 'No se pudo cambiar la contraseña. Inténtalo de nuevo.' });
    }
  });

  // 3) Confirmar que el correo es de la persona
  app.post('/api/cuenta/verificar-correo', async (req, res) => {
    noCache(res);
    const tokens = getTokens();
    const usuarios = getUsuarios();
    if (!tokens || !usuarios) return res.status(503).json({ error: 'No disponible ahora mismo.' });
    if (!permitir('ver-ip:' + ipDe(req), 20, HORA_MS)) return res.status(429).json({ error: 'Demasiados intentos. Inténtalo más tarde.' });
    const token = (req.body || {}).token;
    const invalido = () => res.status(400).json({ error: 'El enlace no es válido o ha caducado. Pide otro desde "Correo de recuperación" dentro del chat.' });
    if (!formatoToken(token)) return invalido();
    try {
      const t = await tokens.findOneAndDelete({ tipo: 'verificar', hash: hashToken(token), expira: { $gt: new Date() } });
      if (!t) return invalido();
      const r = await usuarios.updateOne({ usuarioClave: t.usuarioClave, email: t.email }, { $set: { emailVerificado: true, emailVerificadoEn: new Date() } });
      if (!r.matchedCount) return invalido(); // el correo de la cuenta cambió mientras tanto
      res.json({ ok: true });
    } catch (e) {
      console.error('Verificar correo:', e.message);
      res.status(500).json({ error: 'No se pudo confirmar el correo. Inténtalo de nuevo.' });
    }
  });

  return { activo, permitir, normalizarEmail, emailValido, enmascarar, validarContrasena, enviarVerificacion, avisarCambioCorreo, avisarEliminacion };
}

module.exports = { crearRecuperacion, MIN_CONTRASENA, MAX_CONTRASENA };
