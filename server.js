const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function obtenerIPDesdeRequest(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

app.post('/api/apelar-baneo', async (req, res) => {
  const ip = obtenerIPDesdeRequest(req);
  const mensaje = String((req.body && req.body.mensaje) || '').trim().slice(0, 500);
  if (!mensaje) return res.status(400).json({ error: 'Escribe un mensaje.' });
  if (!baneadosCol) return res.status(503).json({ error: 'No disponible ahora mismo.' });

  await baneadosCol.updateOne(
    { ip },
    { $push: { mensajesApelacion: { texto: mensaje, fecha: new Date() } } }
  );

  [adminSocketId, ...moderadores].filter(Boolean).forEach(id => {
    io.to(id).emit('sistema', { texto: '📨 Alguien bloqueado ha dejado un mensaje. Revísalo en "IPs bloqueadas".' });
  });

  res.json({ ok: true });
});

// ---- Configuracion de limites ----
const MAX_SALAS = 10;
const MAX_SALAS_POR_USUARIO = 3;
const MAX_MODERADORES = 5;
const MAX_PRIVADOS_POR_USUARIO = 2;
const MAX_TAMANO_IMAGEN = 4 * 1024 * 1024; // 4MB en base64
const MAX_INTENTOS_LOGIN = 3;
const BLOQUEO_LOGIN_MS = 15 * 60 * 1000;
const intentosLogin = new Map(); // usuarioClave -> { intentos, bloqueadoHasta }
const ADMIN_KEY = process.env.ADMIN_KEY || 'CAMBIA-ESTA-CLAVE';

// Copia de las imagenes de las salas publicas para moderacion (24h) - no se usa para privados
const imagenesModeracion = new Map(); // id -> { dataUrl, nick, salaId, fecha }

function esImagenValida(dataUrl) {
  return typeof dataUrl === 'string' && /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,/.test(dataUrl) && dataUrl.length <= MAX_TAMANO_IMAGEN;
}

// ---- Palabras para nicks aleatorios (usuarios no registrados) ----
const ADJETIVOS = ['Curioso', 'Sereno', 'Amable', 'Despierto', 'Ligero', 'Sabio', 'Alegre', 'Tranquilo'];
const ANIMALES = ['Zorro', 'Colibri', 'Delfin', 'Lince', 'Buho', 'Nutria', 'Halcon', 'Panda'];

function generarNick() {
  const a = ADJETIVOS[Math.floor(Math.random() * ADJETIVOS.length)];
  const n = ANIMALES[Math.floor(Math.random() * ANIMALES.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${a}${n}${num}`;
}

// ---- Conexion a la base de datos (guarda cuentas de forma permanente) ----
let usuariosCol = null;
let notasStaffCol = null;
let estadisticasCol = null;
async function conectarDB() {
  if (!process.env.MONGODB_URI) {
    console.log('Aviso: no hay MONGODB_URI configurada. El registro de usuarios no estara disponible.');
    return;
  }
  const cliente = new MongoClient(process.env.MONGODB_URI);
  await cliente.connect();
  usuariosCol = cliente.db('chat_educativo').collection('usuarios');

  // Migracion: las cuentas creadas antes de este cambio no tienen "usuarioClave" todavia
  const antiguas = await usuariosCol.find({ usuarioClave: { $exists: false } }).toArray();
  for (const doc of antiguas) {
    await usuariosCol.updateOne({ _id: doc._id }, { $set: { usuarioClave: doc.usuario.toLowerCase() } });
  }

  await usuariosCol.createIndex({ usuarioClave: 1 }, { unique: true });
  baneadosCol = cliente.db('chat_educativo').collection('baneados');
  await baneadosCol.createIndex({ ip: 1 }, { unique: true });
  notasStaffCol = cliente.db('chat_educativo').collection('notasStaff');
  estadisticasCol = cliente.db('chat_educativo').collection('estadisticas');
  await cargarBaneados();
  console.log('Conectado a la base de datos correctamente');
}

// ---- Estado en memoria de la sesion en curso ----
const usuariosConectados = new Map(); // socket.id -> nick actual
const salas = new Map();              // salaId -> { id, nombre, creador, usuarios:Set(socketId) }

// Sala fija, oculta y permanente solo para admin/moderadores. Nadie mas sabe que existe.
salas.set('staff', {
  id: 'staff', nombre: '👑 Sala Staff', creador: 'sistema',
  usuarios: new Set(), vacioDesde: null, permanente: true, oculta: true
});
let adminSocketId = null;
const moderadores = new Set();        // socketId

function esModOAdmin(socketId) {
  return socketId === adminSocketId || moderadores.has(socketId);
}

function listaSalas() {
  return Array.from(salas.values()).map(s => ({
    id: s.id, nombre: s.nombre, numUsuarios: s.usuarios.size, permanente: !!s.permanente
  }));
}

function listaSalasPara(socketId) {
  const miNickActual = usuariosConectados.get(socketId);
  const privilegiado = esModOAdmin(socketId);
  return Array.from(salas.values())
    .filter(s => !s.oculta || privilegiado)
    .map(s => ({
      id: s.id, nombre: s.nombre, numUsuarios: s.usuarios.size, permanente: !!s.permanente,
      puedeCerrar: !s.oculta && (privilegiado || s.creador === miNickActual)
    }));
}

function emitirSalasATodos() {
  io.sockets.sockets.forEach((s) => s.emit('salasActualizadas', listaSalasPara(s.id)));
}

function registrarEstadistica(nick) {
  if (!estadisticasCol) return;
  const hoy = new Date().toISOString().slice(0, 10); // AAAA-MM-DD
  const hora = new Date().getHours();
  estadisticasCol.findOneAndUpdate(
    { _id: 'global' },
    { $inc: { totalMensajes: 1, [`porUsuario.${nick}`]: 1, [`porHora.${hora}`]: 1 } },
    { upsert: true }
  ).catch(() => {});
  estadisticasCol.findOneAndUpdate(
    { _id: 'dia_' + hoy },
    { $inc: { mensajes: 1 } },
    { upsert: true }
  ).catch(() => {});
}

function usuariosDeSala(sala) {
  return Array.from(sala.usuarios).map(id => usuariosConectados.get(id)).filter(Boolean);
}

function unirseAStaff(socket) {
  const sala = salas.get('staff');
  if (!sala) return;
  socket.join('staff');
  sala.usuarios.add(socket.id);
  socket.data.salasUnidas.add('staff');
  enviarHistorialStaff(socket);
}

async function enviarHistorialStaff(socket) {
  if (!notasStaffCol) return;
  try {
    const historial = await notasStaffCol.find({}).sort({ fecha: -1 }).limit(100).toArray();
    socket.emit('historialStaff', historial.reverse().map(n => ({
      nick: n.nick,
      texto: n.texto,
      hora: new Date(n.fecha).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    })));
  } catch (e) { /* silencioso: si falla, simplemente no hay historial */ }
}

function salirDeStaff(socket) {
  const sala = salas.get('staff');
  if (sala) sala.usuarios.delete(socket.id);
  socket.leave('staff');
  socket.data.salasUnidas.delete('staff');
}

function marcarEstadoVacio(sala) {
  if (sala.permanente) { sala.vacioDesde = null; return; }
  if (sala.usuarios.size === 0) {
    if (!sala.vacioDesde) sala.vacioDesde = Date.now();
  } else {
    sala.vacioDesde = null;
  }
}

function listaUsuarios() {
  return Array.from(usuariosConectados.entries()).map(([id, nick]) => ({
    id, nick,
    rol: id === adminSocketId ? 'admin' : (moderadores.has(id) ? 'moderador' : 'usuario')
  }));
}

function rolDe(socketId) {
  return socketId === adminSocketId ? 'admin' : (moderadores.has(socketId) ? 'moderador' : 'usuario');
}

// ---- Filtro basico de palabras malsonantes / faltas de respeto ----
// No es infalible (ningun filtro automatico lo es), pero cubre los casos mas comunes.
const PALABRAS_PROHIBIDAS = [
  'gilipollas', 'imbecil', 'idiota', 'subnormal', 'retrasado', 'tonto de remate',
  'hijo de puta', 'hijoputa', 'cabron', 'cabrona', 'zorra', 'puta', 'puto',
  'mierda', 'joder te', 'maricon', 'marica', 'negro de mierda', 'sudaca',
  'nazi', 'pedofilo'
];

function contieneMalasPalabras(texto) {
  const t = texto.toLowerCase();
  return PALABRAS_PROHIBIDAS.some(p => t.includes(p));
}

function censurar(texto) {
  let resultado = texto;
  PALABRAS_PROHIBIDAS.forEach(p => {
    const regex = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    resultado = resultado.replace(regex, m => m[0] + '*'.repeat(Math.max(m.length - 1, 1)));
  });
  return resultado;
}

// ---- Antispam: maximo de mensajes por usuario en una ventana de tiempo ----
const LIMITE_MENSAJES = 5;
const VENTANA_MS = 5000;
const historialMensajes = new Map(); // socket.id -> array de timestamps

function estaEnFlood(socketId) {
  const ahora = Date.now();
  const historial = (historialMensajes.get(socketId) || []).filter(t => ahora - t < VENTANA_MS);
  historial.push(ahora);
  historialMensajes.set(socketId, historial);
  return historial.length > LIMITE_MENSAJES;
}

// ---- IPs baneadas (persistentes si hay base de datos) ----
let baneadosCol = null;
const ipsBaneadasCache = new Set();

async function cargarBaneados() {
  if (!baneadosCol) return;
  const baneados = await baneadosCol.find({}).toArray();
  baneados.forEach(b => ipsBaneadasCache.add(b.ip));
}

function obtenerIP(socket) {
  return (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim();
}

io.on('connection', (socket) => {
  const ip = obtenerIP(socket);
  if (ipsBaneadasCache.has(ip)) {
    socket.emit('estasBaneado', {
      adminOnline: !!adminSocketId,
      modsOnline: moderadores.size > 0
    });
    socket.disconnect(true);
    return;
  }

  const nick = generarNick();
  usuariosConectados.set(socket.id, nick);
  socket.data.salasUnidas = new Set();
  socket.data.privados = new Map(); // otroNick -> canalId
  socket.data.registrado = false;

  socket.emit('bienvenida', { nick, totalConectados: usuariosConectados.size, salas: listaSalasPara(socket.id) });
  socket.broadcast.emit('sistema', { texto: `${nick} se ha conectado` });
  io.emit('totalConectados', usuariosConectados.size);

  // ---- Registro de cuenta nueva ----
  socket.on('registrar', async ({ usuario, contrasena, mayorDeEdad }) => {
    if (!usuariosCol) { socket.emit('error_app', 'El registro no esta disponible ahora mismo.'); return; }
    if (!mayorDeEdad) { socket.emit('error_app', 'Debes confirmar que eres mayor de 18 años para registrarte.'); return; }
    const u = String(usuario || '').trim();
    const uClave = u.toLowerCase();
    const p = String(contrasena || '');
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(u)) {
      socket.emit('error_app', 'El usuario debe tener 3-20 caracteres: letras, numeros, guion (-), guion bajo (_) o punto (.), sin espacios.');
      return;
    }
    if (p.length < 6) {
      socket.emit('error_app', 'La contrasena debe tener al menos 6 caracteres.');
      return;
    }
    try {
      const hash = await bcrypt.hash(p, 10);
      await usuariosCol.insertOne({ usuario: u, usuarioClave: uClave, hash, rol: 'usuario', mayorDeEdad: true, creado: new Date() });
      aplicarSesion(socket, u, 'usuario');
      socket.emit('sesionIniciada', { usuario: u, rol: 'usuario' });
      io.emit('sistema', { texto: `${u} se ha registrado` });
    } catch (err) {
      if (err.code === 11000) socket.emit('error_app', 'Ese nombre de usuario ya existe (no distingue mayusculas de minusculas).');
      else socket.emit('error_app', 'No se pudo completar el registro.');
    }
  });

  // ---- Inicio de sesion ----
  socket.on('iniciarSesion', async ({ usuario, contrasena }) => {
    if (!usuariosCol) { socket.emit('error_app', 'El inicio de sesion no esta disponible ahora mismo.'); return; }
    const uClave = String(usuario || '').trim().toLowerCase();

    const bloqueo = intentosLogin.get(uClave);
    if (bloqueo && bloqueo.bloqueadoHasta && Date.now() < bloqueo.bloqueadoHasta) {
      const minutosRestantes = Math.ceil((bloqueo.bloqueadoHasta - Date.now()) / 60000);
      socket.emit('error_app', `Demasiados intentos fallidos. Espera ${minutosRestantes} minuto(s) antes de volver a intentarlo.`);
      return;
    }

    const doc = await usuariosCol.findOne({ usuarioClave: uClave });
    const ok = doc && await bcrypt.compare(String(contrasena || ''), doc.hash);

    if (!ok) {
      const actual = intentosLogin.get(uClave) || { intentos: 0, bloqueadoHasta: null };
      actual.intentos += 1;
      if (actual.intentos >= MAX_INTENTOS_LOGIN) {
        actual.bloqueadoHasta = Date.now() + BLOQUEO_LOGIN_MS;
        actual.intentos = 0;
        intentosLogin.set(uClave, actual);
        socket.emit('error_app', 'Demasiados intentos fallidos. Esta cuenta se bloquea 15 minutos por seguridad.');
      } else {
        intentosLogin.set(uClave, actual);
        const restantes = MAX_INTENTOS_LOGIN - actual.intentos;
        socket.emit('error_app', `Usuario o contrasena incorrectos. Te queda${restantes === 1 ? '' : 'n'} ${restantes} intento${restantes === 1 ? '' : 's'} antes de un bloqueo temporal.`);
      }
      return;
    }

    intentosLogin.delete(uClave);
    aplicarSesion(socket, doc.usuario, doc.rol);
    socket.emit('sesionIniciada', { usuario: doc.usuario, rol: doc.rol });
    io.emit('sistema', { texto: `${doc.usuario} ha iniciado sesion` });
  });

  function aplicarSesion(socket, usuario, rol) {
    usuariosConectados.set(socket.id, usuario);
    socket.data.registrado = true;
    socket.data.usuario = usuario;
    if (rol === 'admin') adminSocketId = socket.id;
    if (rol === 'moderador') moderadores.add(socket.id);
    if (rol === 'admin' || rol === 'moderador') unirseAStaff(socket);
    io.emit('totalConectados', usuariosConectados.size);
    emitirSalasATodos();
  }

  // ---- Crear sala ----
  socket.on('crearSala', ({ nombre }) => {
    const nombreLimpio = String(nombre || '').trim().slice(0, 30);
    if (!nombreLimpio) return;
    const salasVisibles = Array.from(salas.values()).filter(s => !s.oculta).length;
    if (salasVisibles >= MAX_SALAS) { socket.emit('error_app', 'Ya existen 10 salas, el maximo permitido.'); return; }
    const id = 'sala_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const permanente = esModOAdmin(socket.id);
    salas.set(id, { id, nombre: nombreLimpio, creador: usuariosConectados.get(socket.id), usuarios: new Set(), vacioDesde: permanente ? null : Date.now(), permanente });
    emitirSalasATodos();
    io.emit('sistema', { texto: `${usuariosConectados.get(socket.id)} ha creado la sala "${nombreLimpio}"` });
  });

  // ---- Unirse a sala ----
  socket.on('unirseSala', ({ salaId }) => {
    const sala = salas.get(salaId);
    if (!sala) return;
    const yaUnido = socket.data.salasUnidas.has(salaId);
    const privilegiado = esModOAdmin(socket.id);
    if (!yaUnido && !privilegiado && socket.data.salasUnidas.size >= MAX_SALAS_POR_USUARIO) {
      socket.emit('error_app', `Solo puedes estar en ${MAX_SALAS_POR_USUARIO} salas a la vez. Sal de alguna para entrar en esta.`);
      return;
    }
    socket.join(salaId);
    sala.usuarios.add(socket.id);
    socket.data.salasUnidas.add(salaId);
    marcarEstadoVacio(sala);
    socket.emit('unido', { salaId });
    emitirSalasATodos();
    io.emit('usuariosDeSala', { salaId, usuarios: usuariosDeSala(sala) });
  });

  // ---- Salir de sala ----
  socket.on('salirSala', ({ salaId }) => {
    const sala = salas.get(salaId);
    socket.leave(salaId);
    socket.data.salasUnidas.delete(salaId);
    if (sala) { sala.usuarios.delete(socket.id); marcarEstadoVacio(sala); io.emit('usuariosDeSala', { salaId, usuarios: usuariosDeSala(sala) }); }
    emitirSalasATodos();
  });

  // ---- Mensaje en una sala ----
  socket.on('mensajeSala', ({ salaId, texto, imagenDataUrl, imagenNombre }) => {
    const sala = salas.get(salaId);
    if (!sala) return;
    const privilegiado = esModOAdmin(socket.id);
    if (!privilegiado && !socket.data.salasUnidas.has(salaId)) return;

    if (estaEnFlood(socket.id)) {
      socket.emit('error_app', 'Estas enviando mensajes demasiado rapido. Espera unos segundos.');
      return;
    }

    const nick = usuariosConectados.get(socket.id);
    const hora = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

    if (imagenDataUrl) {
      if (!esImagenValida(imagenDataUrl)) {
        socket.emit('error_app', 'Solo se permiten imagenes (foto o GIF) de hasta 4MB.');
        return;
      }
      const id = 'img_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      imagenesModeracion.set(id, { dataUrl: imagenDataUrl, nick, salaId, fecha: Date.now() });
      setTimeout(() => imagenesModeracion.delete(id), 24 * 60 * 60 * 1000);

      const msg = { salaId, id, nick, rol: rolDe(socket.id), registrado: !!socket.data.registrado, tipo: 'imagen', imagenDataUrl, imagenNombre: String(imagenNombre || 'imagen'), hora };
      io.to(salaId).emit('mensajeSala', msg);
      const espectadores = [adminSocketId, ...moderadores].filter(sid => sid && !sala.usuarios.has(sid));
      espectadores.forEach(sid => io.to(sid).emit('mensajeSala', msg));
      socket.emit('sistema', { texto: 'Tu imagen se retira de la vista en 3 minutos. Se guarda una copia solo para moderacion durante 24h.' });
      return;
    }

    let textoLimpio = String(texto || '').trim().slice(0, 500);
    if (!textoLimpio) return;
    if (contieneMalasPalabras(textoLimpio)) textoLimpio = censurar(textoLimpio);

    const msg = { salaId, nick, rol: rolDe(socket.id), registrado: !!socket.data.registrado, tipo: 'texto', texto: textoLimpio, hora };
    if (salaId === 'staff' && notasStaffCol) {
      notasStaffCol.insertOne({ nick, texto: textoLimpio, fecha: new Date() }).catch(() => {});
    } else {
      registrarEstadistica(nick);
    }
    io.to(salaId).emit('mensajeSala', msg);
    const espectadores = [adminSocketId, ...moderadores].filter(id => id && !sala.usuarios.has(id));
    espectadores.forEach(id => io.to(id).emit('mensajeSala', msg));
  });

  // ---- Reclamar rol de administrador (requiere estar registrado) ----
  socket.on('reclamarAdmin', async ({ clave }) => {
    if (!socket.data.registrado) { socket.emit('error_app', 'Debes registrarte e iniciar sesion primero.'); return; }
    if (adminSocketId && adminSocketId !== socket.id) { socket.emit('error_app', 'Ya hay un administrador asignado en este chat.'); return; }
    if (clave !== ADMIN_KEY) { socket.emit('error_app', 'Clave incorrecta.'); return; }
    adminSocketId = socket.id;
    unirseAStaff(socket);
    if (usuariosCol) await usuariosCol.updateOne({ usuario: socket.data.usuario }, { $set: { rol: 'admin' } });
    socket.emit('rolAsignado', { rol: 'admin' });
    emitirSalasATodos();
    io.emit('sistema', { texto: `${socket.data.usuario} es ahora el administrador del chat` });
  });

  // ---- Asignar moderador (solo admin, el objetivo debe estar registrado) ----
  // ---- Crear directamente una cuenta nueva de moderador (solo admin) ----
  socket.on('crearCuentaModerador', async ({ usuario, contrasena }) => {
    if (socket.id !== adminSocketId) return;
    if (!usuariosCol) { socket.emit('error_app', 'La base de datos no esta disponible ahora mismo.'); return; }
    if (moderadores.size >= MAX_MODERADORES) { socket.emit('error_app', 'Ya hay 5 moderadores, el maximo permitido.'); return; }
    const u = String(usuario || '').trim();
    const uClave = u.toLowerCase();
    const p = String(contrasena || '');
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(u)) {
      socket.emit('error_app', 'El usuario debe tener 3-20 caracteres: letras, numeros, guion (-), guion bajo (_) o punto (.).');
      return;
    }
    if (p.length < 6) { socket.emit('error_app', 'La contrasena debe tener al menos 6 caracteres.'); return; }
    try {
      const hash = await bcrypt.hash(p, 10);
      await usuariosCol.insertOne({ usuario: u, usuarioClave: uClave, hash, rol: 'moderador', mayorDeEdad: true, creado: new Date() });
      socket.emit('avisoOk', `Cuenta "${u}" creada como moderador. Dale la contrasena a esa persona para que inicie sesion con ella.`);
    } catch (err) {
      if (err.code === 11000) socket.emit('error_app', 'Ya existe una cuenta con ese nombre de usuario.');
      else socket.emit('error_app', 'No se pudo crear la cuenta.');
    }
  });

  socket.on('asignarModerador', async ({ nickObjetivo }) => {
    if (socket.id !== adminSocketId) return;
    if (moderadores.size >= MAX_MODERADORES) { socket.emit('error_app', 'Ya hay 5 moderadores, el maximo permitido.'); return; }
    const uClave = String(nickObjetivo || '').trim().toLowerCase();
    let nombreReal = nickObjetivo;
    if (usuariosCol) {
      const doc = await usuariosCol.findOne({ usuarioClave: uClave });
      if (!doc) { socket.emit('error_app', 'Ese usuario no esta registrado.'); return; }
      nombreReal = doc.usuario;
      await usuariosCol.updateOne({ usuarioClave: uClave }, { $set: { rol: 'moderador' } });
    }
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n.toLowerCase() === uClave);
    if (destino) {
      moderadores.add(destino[0]);
      const socketDestino = io.sockets.sockets.get(destino[0]);
      if (socketDestino) unirseAStaff(socketDestino);
      io.to(destino[0]).emit('rolAsignado', { rol: 'moderador' });
    }
    io.emit('sistema', { texto: `${nombreReal} es ahora moderador` });
    emitirSalasATodos();
  });

  // ---- Quitar moderador (solo admin) ----
  socket.on('quitarModerador', async ({ nickObjetivo }) => {
    if (socket.id !== adminSocketId) return;
    const uClave = String(nickObjetivo || '').trim().toLowerCase();
    let nombreReal = nickObjetivo;
    if (usuariosCol) {
      const doc = await usuariosCol.findOne({ usuarioClave: uClave });
      if (doc) nombreReal = doc.usuario;
      await usuariosCol.updateOne({ usuarioClave: uClave }, { $set: { rol: 'usuario' } });
    }
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n.toLowerCase() === uClave);
    if (destino) {
      moderadores.delete(destino[0]);
      const socketDestino = io.sockets.sockets.get(destino[0]);
      if (socketDestino) salirDeStaff(socketDestino);
      io.to(destino[0]).emit('rolAsignado', { rol: 'usuario' });
    }
    io.emit('sistema', { texto: `${nombreReal} ya no es moderador` });
    emitirSalasATodos();
  });

  // ---- Indicador de "esta escribiendo" ----
  socket.on('escribiendo', ({ salaId }) => {
    if (!salaId) return;
    socket.to(salaId).emit('escribiendo', { salaId, nick: usuariosConectados.get(socket.id) });
  });

  socket.on('dejoEscribir', ({ salaId }) => {
    if (!salaId) return;
    socket.to(salaId).emit('dejoEscribir', { salaId, nick: usuariosConectados.get(socket.id) });
  });

  // ---- Eliminar sala (admin o quien la creo) ----
  // ---- Banear IP (admin o moderador) ----
  // ---- Restablecer contraseña de un usuario (admin o moderador) ----
  socket.on('restablecerContrasena', async ({ usuario, nuevaContrasena }) => {
    if (!esModOAdmin(socket.id)) return;
    if (!usuariosCol) { socket.emit('error_app', 'La base de datos no esta disponible ahora mismo.'); return; }
    const uClave = String(usuario || '').trim().toLowerCase();
    const p = String(nuevaContrasena || '');
    if (p.length < 6) { socket.emit('error_app', 'La nueva contrasena debe tener al menos 6 caracteres.'); return; }
    const doc = await usuariosCol.findOne({ usuarioClave: uClave });
    if (!doc) { socket.emit('error_app', 'Ese usuario no existe.'); return; }
    const hash = await bcrypt.hash(p, 10);
    await usuariosCol.updateOne({ usuarioClave: uClave }, { $set: { hash } });
    socket.emit('avisoOk', `Contrasena de ${doc.usuario} restablecida correctamente.`);
  });

  socket.on('banearIP', async ({ nickObjetivo }) => {
    if (!esModOAdmin(socket.id)) return;
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n === nickObjetivo);
    if (!destino) { socket.emit('error_app', 'Ese usuario no esta conectado ahora mismo.'); return; }
    const [socketIdDestino] = destino;
    const socketDestino = io.sockets.sockets.get(socketIdDestino);
    if (!socketDestino) return;
    const ip = obtenerIP(socketDestino);
    ipsBaneadasCache.add(ip);
    const baneadoPor = usuariosConectados.get(socket.id);
    if (baneadosCol) {
      try { await baneadosCol.insertOne({ ip, nick: nickObjetivo, baneadoPor, fecha: new Date() }); } catch (e) { /* ya existia */ }
    }
    socketDestino.emit('error_app', 'Has sido bloqueado de este chat por un administrador.');
    socketDestino.disconnect(true);
    io.emit('sistema', { texto: `${nickObjetivo} ha sido bloqueado del chat` });
  });

  // ---- Listado y desbaneo de IPs (admin o moderador) ----
  socket.on('pedirEstadisticas', async () => {
    if (!esModOAdmin(socket.id)) return;
    if (!estadisticasCol || !usuariosCol) { socket.emit('error_app', 'Estadisticas no disponibles ahora mismo.'); return; }

    const global = await estadisticasCol.findOne({ _id: 'global' });
    const hoy = new Date().toISOString().slice(0, 10);
    const deHoy = await estadisticasCol.findOne({ _id: 'dia_' + hoy });
    const totalRegistrados = await usuariosCol.countDocuments({});

    let topUsuarios = [];
    let horaPico = null;
    if (global && global.porUsuario) {
      topUsuarios = Object.entries(global.porUsuario)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([nick, total]) => ({ nick, total }));
    }
    if (global && global.porHora) {
      const entradas = Object.entries(global.porHora).sort((a, b) => b[1] - a[1]);
      if (entradas.length) horaPico = `${entradas[0][0]}:00 - ${Number(entradas[0][0]) + 1}:00`;
    }

    socket.emit('estadisticas', {
      totalMensajes: (global && global.totalMensajes) || 0,
      mensajesHoy: (deHoy && deHoy.mensajes) || 0,
      conectadosAhora: usuariosConectados.size,
      salasActivas: Array.from(salas.values()).filter(s => !s.oculta).length,
      totalRegistrados,
      horaPico,
      topUsuarios
    });
  });

  socket.on('pedirBaneados', async () => {
    if (!esModOAdmin(socket.id) || !baneadosCol) return;
    const lista = await baneadosCol.find({}).sort({ fecha: -1 }).toArray();
    socket.emit('listaBaneados', lista.map(b => ({
      ip: b.ip, nick: b.nick, baneadoPor: b.baneadoPor || '—',
      fecha: new Date(b.fecha).toLocaleString('es-ES'),
      mensajesApelacion: (b.mensajesApelacion || []).map(m => ({
        texto: m.texto, fecha: new Date(m.fecha).toLocaleString('es-ES')
      }))
    })));
  });

  socket.on('desbanearIP', async ({ ip }) => {
    if (!esModOAdmin(socket.id)) return;
    ipsBaneadasCache.delete(ip);
    if (baneadosCol) await baneadosCol.deleteOne({ ip });
    socket.emit('avisoOk', 'IP desbloqueada correctamente.');
    const lista = baneadosCol ? await baneadosCol.find({}).sort({ fecha: -1 }).toArray() : [];
    socket.emit('listaBaneados', lista.map(b => ({
      ip: b.ip, nick: b.nick, baneadoPor: b.baneadoPor || '—',
      fecha: new Date(b.fecha).toLocaleString('es-ES')
    })));
  });

  // ---- Chats privados (100% anonimos, ni siquiera admin/mod los ven) ----
  function socketPorNick(nickBuscado) {
    const entrada = Array.from(usuariosConectados.entries()).find(([, n]) => n === nickBuscado);
    return entrada ? io.sockets.sockets.get(entrada[0]) : null;
  }

  socket.on('abrirPrivado', ({ nickObjetivo }) => {
    const miNick = usuariosConectados.get(socket.id);
    if (!nickObjetivo || nickObjetivo === miNick) return;
    if (socket.data.privados.has(nickObjetivo)) {
      const canalExistente = socket.data.privados.get(nickObjetivo);
      socket.emit('privadoAbierto', { canalId: canalExistente, conNick: nickObjetivo });
      return;
    }
    const otro = socketPorNick(nickObjetivo);
    if (!otro) { socket.emit('error_app', 'Ese usuario ya no esta conectado.'); return; }
    if (socket.data.privados.size >= MAX_PRIVADOS_POR_USUARIO) {
      socket.emit('error_app', `Solo puedes tener ${MAX_PRIVADOS_POR_USUARIO} chats privados a la vez.`);
      return;
    }
    if (otro.data.privados.size >= MAX_PRIVADOS_POR_USUARIO) {
      socket.emit('error_app', `${nickObjetivo} ya tiene ${MAX_PRIVADOS_POR_USUARIO} chats privados abiertos ahora mismo.`);
      return;
    }
    const canalId = 'priv_' + [miNick, nickObjetivo].sort().join('_').replace(/[^a-zA-Z0-9_]/g, '');
    socket.join(canalId);
    otro.join(canalId);
    socket.data.privados.set(nickObjetivo, canalId);
    otro.data.privados.set(miNick, canalId);
    socket.emit('privadoAbierto', { canalId, conNick: nickObjetivo });
    otro.emit('privadoAbierto', { canalId, conNick: miNick });
  });

  socket.on('mensajePrivado', ({ canalId, texto }) => {
    if (!socket.rooms.has(canalId)) return;
    const textoLimpio = String(texto || '').trim().slice(0, 500);
    if (!textoLimpio) return;
    io.to(canalId).emit('mensajePrivado', {
      canalId, nick: usuariosConectados.get(socket.id), texto: textoLimpio,
      hora: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('imagenPrivada', ({ canalId, imagenDataUrl, imagenNombre }) => {
    if (!socket.rooms.has(canalId)) return;
    if (!esImagenValida(imagenDataUrl)) { socket.emit('error_app', 'Solo se permiten imagenes (foto o GIF) de hasta 4MB.'); return; }
    io.to(canalId).emit('imagenPrivada', {
      canalId, nick: usuariosConectados.get(socket.id), imagenDataUrl, imagenNombre: String(imagenNombre || 'imagen'),
      hora: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    });
    // No se guarda ninguna copia: el privado es 100% anonimo y se borra al cerrarse.
  });

  function cerrarPrivadoInterno(socketOrigen, canalId, motivo) {
    const miNickOrigen = usuariosConectados.get(socketOrigen.id);
    let otroNick = null;
    socketOrigen.data.privados.forEach((c, nick) => { if (c === canalId) otroNick = nick; });
    socketOrigen.leave(canalId);
    if (otroNick) socketOrigen.data.privados.delete(otroNick);
    io.to(canalId).emit('privadoCerrado', { canalId, motivo: motivo || 'cerrado', porQuien: miNickOrigen });
    const otro = otroNick ? socketPorNick(otroNick) : null;
    if (otro) { otro.leave(canalId); otro.data.privados.delete(miNickOrigen); }
  }

  socket.on('cerrarPrivado', ({ canalId }) => cerrarPrivadoInterno(socket, canalId, 'cerrado'));

  // ---- Reportar mensaje (cualquier usuario) ----
  socket.on('reportarMensaje', ({ salaId, nickReportado, texto }) => {
    const sala = salas.get(salaId);
    const nombreSala = sala ? sala.nombre : salaId;
    const quienReporta = usuariosConectados.get(socket.id);
    const resumen = String(texto || '').slice(0, 120);
    const aviso = `🚩 ${quienReporta} reportó a ${nickReportado} en "${nombreSala}": "${resumen}"`;
    [adminSocketId, ...moderadores].filter(Boolean).forEach(id => io.to(id).emit('sistema', { texto: aviso }));
    socket.emit('avisoOk', 'Gracias, tu reporte se ha enviado a los moderadores.');
  });

  socket.on('eliminarSala', ({ salaId }) => {
    const sala = salas.get(salaId);
    if (!sala) return;
    if (sala.oculta) return;
    const esCreador = sala.creador === usuariosConectados.get(socket.id);
    const esPriv = esModOAdmin(socket.id);

    if (!esPriv && !esCreador) { socket.emit('error_app', 'No puedes cerrar esta sala.'); return; }

    if (!esPriv && esCreador) {
      const hayOtrosDentro = Array.from(sala.usuarios).some(id => id !== socket.id);
      if (hayOtrosDentro) {
        socket.emit('error_app', 'No puedes cerrar la sala mientras haya otras personas dentro.');
        return;
      }
    }

    salas.delete(salaId);
    io.socketsLeave(salaId);
    emitirSalasATodos();
    io.emit('salaEliminada', { salaId });
    io.emit('sistema', { texto: `La sala "${sala.nombre}" ha sido cerrada` });
  });

  socket.on('pedirUsuariosDeSala', ({ salaId }) => {
    const sala = salas.get(salaId);
    if (sala) socket.emit('usuariosDeSala', { salaId, usuarios: usuariosDeSala(sala) });
  });

  socket.on('pedirUsuarios', () => {
    if (esModOAdmin(socket.id)) socket.emit('listaUsuarios', listaUsuarios());
  });

  // ---- Desconexion ----
  socket.on('disconnect', () => {
    const nickSaliente = usuariosConectados.get(socket.id);
    Array.from(socket.data.privados.values()).forEach(canalId => {
      io.to(canalId).emit('privadoCerrado', { canalId, motivo: 'desconexion', porQuien: nickSaliente });
    });
    usuariosConectados.delete(socket.id);
    salas.forEach(sala => {
      if (sala.usuarios.has(socket.id)) {
        sala.usuarios.delete(socket.id);
        marcarEstadoVacio(sala);
        io.emit('usuariosDeSala', { salaId: sala.id, usuarios: usuariosDeSala(sala) });
      }
    });
    if (adminSocketId === socket.id) adminSocketId = null;
    moderadores.delete(socket.id);
    io.emit('sistema', { texto: `${nickSaliente} se ha desconectado` });
    io.emit('totalConectados', usuariosConectados.size);
    emitirSalasATodos();
  });
});

const PUERTO = process.env.PORT || 3000;

// Cada minuto, borra las salas que llevan 5 minutos o mas sin nadie dentro
setInterval(() => {
  const ahora = Date.now();
  salas.forEach((sala, id) => {
    if (sala.vacioDesde && ahora - sala.vacioDesde >= 5 * 60 * 1000) {
      salas.delete(id);
      emitirSalasATodos();
      io.emit('salaEliminada', { salaId: id });
      io.emit('sistema', { texto: `La sala "${sala.nombre}" se elimino por estar vacia` });
    }
  });
}, 60 * 1000);

conectarDB().finally(() => {
  server.listen(PUERTO, () => console.log(`Chat educativo escuchando en el puerto ${PUERTO}`));
});
