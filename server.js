const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---- Configuracion de limites ----
const MAX_SALAS = 10;
const MAX_SALAS_POR_USUARIO = 3;
const MAX_MODERADORES = 5;
const ADMIN_KEY = process.env.ADMIN_KEY || 'CAMBIA-ESTA-CLAVE';

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
async function conectarDB() {
  if (!process.env.MONGODB_URI) {
    console.log('Aviso: no hay MONGODB_URI configurada. El registro de usuarios no estara disponible.');
    return;
  }
  const cliente = new MongoClient(process.env.MONGODB_URI);
  await cliente.connect();
  usuariosCol = cliente.db('chat_educativo').collection('usuarios');
  await usuariosCol.createIndex({ usuario: 1 }, { unique: true });
  console.log('Conectado a la base de datos correctamente');
}

// ---- Estado en memoria de la sesion en curso ----
const usuariosConectados = new Map(); // socket.id -> nick actual
const salas = new Map();              // salaId -> { id, nombre, creador, usuarios:Set(socketId) }
let adminSocketId = null;
const moderadores = new Set();        // socketId

function esModOAdmin(socketId) {
  return socketId === adminSocketId || moderadores.has(socketId);
}

function listaSalas() {
  return Array.from(salas.values()).map(s => ({ id: s.id, nombre: s.nombre, numUsuarios: s.usuarios.size }));
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

io.on('connection', (socket) => {
  const nick = generarNick();
  usuariosConectados.set(socket.id, nick);
  socket.data.salasUnidas = new Set();
  socket.data.registrado = false;

  socket.emit('bienvenida', { nick, totalConectados: usuariosConectados.size, salas: listaSalas() });
  socket.broadcast.emit('sistema', { texto: `${nick} se ha conectado` });
  io.emit('totalConectados', usuariosConectados.size);

  // ---- Registro de cuenta nueva ----
  socket.on('registrar', async ({ usuario, contrasena }) => {
    if (!usuariosCol) { socket.emit('error_app', 'El registro no esta disponible ahora mismo.'); return; }
    const u = String(usuario || '').trim().toLowerCase();
    const p = String(contrasena || '');
    if (!/^[a-z0-9_]{3,20}$/.test(u)) {
      socket.emit('error_app', 'El nombre de usuario debe tener entre 3 y 20 letras/numeros, sin espacios.');
      return;
    }
    if (p.length < 6) {
      socket.emit('error_app', 'La contrasena debe tener al menos 6 caracteres.');
      return;
    }
    try {
      const hash = await bcrypt.hash(p, 10);
      await usuariosCol.insertOne({ usuario: u, hash, rol: 'usuario', creado: new Date() });
      aplicarSesion(socket, u, 'usuario');
      socket.emit('sesionIniciada', { usuario: u, rol: 'usuario' });
      io.emit('sistema', { texto: `${u} se ha registrado` });
    } catch (err) {
      if (err.code === 11000) socket.emit('error_app', 'Ese nombre de usuario ya existe.');
      else socket.emit('error_app', 'No se pudo completar el registro.');
    }
  });

  // ---- Inicio de sesion ----
  socket.on('iniciarSesion', async ({ usuario, contrasena }) => {
    if (!usuariosCol) { socket.emit('error_app', 'El inicio de sesion no esta disponible ahora mismo.'); return; }
    const u = String(usuario || '').trim().toLowerCase();
    const doc = await usuariosCol.findOne({ usuario: u });
    if (!doc) { socket.emit('error_app', 'Usuario o contrasena incorrectos.'); return; }
    const ok = await bcrypt.compare(String(contrasena || ''), doc.hash);
    if (!ok) { socket.emit('error_app', 'Usuario o contrasena incorrectos.'); return; }

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
    io.emit('totalConectados', usuariosConectados.size);
  }

  // ---- Crear sala ----
  socket.on('crearSala', ({ nombre }) => {
    const nombreLimpio = String(nombre || '').trim().slice(0, 30);
    if (!nombreLimpio) return;
    if (salas.size >= MAX_SALAS) { socket.emit('error_app', 'Ya existen 10 salas, el maximo permitido.'); return; }
    const id = 'sala_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    salas.set(id, { id, nombre: nombreLimpio, creador: usuariosConectados.get(socket.id), usuarios: new Set() });
    io.emit('salasActualizadas', listaSalas());
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
    socket.emit('unido', { salaId });
    io.emit('salasActualizadas', listaSalas());
  });

  // ---- Salir de sala ----
  socket.on('salirSala', ({ salaId }) => {
    const sala = salas.get(salaId);
    socket.leave(salaId);
    socket.data.salasUnidas.delete(salaId);
    if (sala) sala.usuarios.delete(socket.id);
    io.emit('salasActualizadas', listaSalas());
  });

  // ---- Mensaje en una sala ----
  socket.on('mensajeSala', ({ salaId, texto }) => {
    const sala = salas.get(salaId);
    if (!sala) return;
    const privilegiado = esModOAdmin(socket.id);
    if (!privilegiado && !socket.data.salasUnidas.has(salaId)) return;

    const textoLimpio = String(texto || '').trim().slice(0, 500);
    if (!textoLimpio) return;

    const msg = {
      salaId,
      nick: usuariosConectados.get(socket.id),
      rol: rolDe(socket.id),
      registrado: !!socket.data.registrado,
      texto: textoLimpio,
      hora: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    };
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
    if (usuariosCol) await usuariosCol.updateOne({ usuario: socket.data.usuario }, { $set: { rol: 'admin' } });
    socket.emit('rolAsignado', { rol: 'admin' });
    io.emit('sistema', { texto: `${socket.data.usuario} es ahora el administrador del chat` });
  });

  // ---- Asignar moderador (solo admin, el objetivo debe estar registrado) ----
  socket.on('asignarModerador', async ({ nickObjetivo }) => {
    if (socket.id !== adminSocketId) return;
    if (moderadores.size >= MAX_MODERADORES) { socket.emit('error_app', 'Ya hay 5 moderadores, el maximo permitido.'); return; }
    const u = String(nickObjetivo || '').trim().toLowerCase();
    if (usuariosCol) {
      const doc = await usuariosCol.findOne({ usuario: u });
      if (!doc) { socket.emit('error_app', 'Ese usuario no esta registrado.'); return; }
      await usuariosCol.updateOne({ usuario: u }, { $set: { rol: 'moderador' } });
    }
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n === u);
    if (destino) { moderadores.add(destino[0]); io.to(destino[0]).emit('rolAsignado', { rol: 'moderador' }); }
    io.emit('sistema', { texto: `${u} es ahora moderador` });
  });

  // ---- Quitar moderador (solo admin) ----
  socket.on('quitarModerador', async ({ nickObjetivo }) => {
    if (socket.id !== adminSocketId) return;
    const u = String(nickObjetivo || '').trim().toLowerCase();
    if (usuariosCol) await usuariosCol.updateOne({ usuario: u }, { $set: { rol: 'usuario' } });
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n === u);
    if (destino) { moderadores.delete(destino[0]); io.to(destino[0]).emit('rolAsignado', { rol: 'usuario' }); }
    io.emit('sistema', { texto: `${u} ya no es moderador` });
  });

  socket.on('pedirUsuarios', () => {
    if (socket.id === adminSocketId) socket.emit('listaUsuarios', listaUsuarios());
  });

  // ---- Desconexion ----
  socket.on('disconnect', () => {
    const nickSaliente = usuariosConectados.get(socket.id);
    usuariosConectados.delete(socket.id);
    salas.forEach(sala => sala.usuarios.delete(socket.id));
    if (adminSocketId === socket.id) adminSocketId = null;
    moderadores.delete(socket.id);
    io.emit('sistema', { texto: `${nickSaliente} se ha desconectado` });
    io.emit('totalConectados', usuariosConectados.size);
    io.emit('salasActualizadas', listaSalas());
  });
});

const PUERTO = process.env.PORT || 3000;
conectarDB().finally(() => {
  server.listen(PUERTO, () => console.log(`Chat educativo escuchando en el puerto ${PUERTO}`));
});
