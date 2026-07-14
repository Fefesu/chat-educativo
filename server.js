const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---- Configuracion de limites ----
const MAX_SALAS = 10;
const MAX_SALAS_POR_USUARIO = 3;
const MAX_MODERADORES = 5;

// La clave para reclamar el rol de administrador. En produccion se define
// como variable de entorno ADMIN_KEY en el hosting, nunca se escribe aqui.
const ADMIN_KEY = process.env.ADMIN_KEY || 'CAMBIA-ESTA-CLAVE';

// ---- Palabras para nicks aleatorios ----
const ADJETIVOS = ['Curioso', 'Sereno', 'Amable', 'Despierto', 'Ligero', 'Sabio', 'Alegre', 'Tranquilo'];
const ANIMALES = ['Zorro', 'Colibri', 'Delfin', 'Lince', 'Buho', 'Nutria', 'Halcon', 'Panda'];

function generarNick() {
  const a = ADJETIVOS[Math.floor(Math.random() * ADJETIVOS.length)];
  const n = ANIMALES[Math.floor(Math.random() * ANIMALES.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${a}${n}${num}`;
}

// ---- Estado en memoria (se reinicia si el servidor se reinicia) ----
const usuariosConectados = new Map(); // socket.id -> nick
const salas = new Map();              // salaId -> { id, nombre, creador, usuarios:Set(socketId) }
let adminSocketId = null;
const moderadores = new Set();        // socketId

function esModOAdmin(socketId) {
  return socketId === adminSocketId || moderadores.has(socketId);
}

function listaSalas() {
  return Array.from(salas.values()).map(s => ({
    id: s.id,
    nombre: s.nombre,
    numUsuarios: s.usuarios.size
  }));
}

function listaUsuarios() {
  return Array.from(usuariosConectados.entries()).map(([id, nick]) => ({
    id, nick,
    rol: id === adminSocketId ? 'admin' : (moderadores.has(id) ? 'moderador' : 'usuario')
  }));
}

io.on('connection', (socket) => {
  const nick = generarNick();
  usuariosConectados.set(socket.id, nick);
  socket.data.salasUnidas = new Set();

  socket.emit('bienvenida', {
    nick,
    totalConectados: usuariosConectados.size,
    salas: listaSalas()
  });

  socket.broadcast.emit('sistema', { texto: `${nick} se ha conectado` });
  io.emit('totalConectados', usuariosConectados.size);

  // ---- Crear sala ----
  socket.on('crearSala', ({ nombre }) => {
    const nombreLimpio = String(nombre || '').trim().slice(0, 30);
    if (!nombreLimpio) return;
    if (salas.size >= MAX_SALAS) {
      socket.emit('error_app', 'Ya existen 10 salas, el maximo permitido.');
      return;
    }
    const id = 'sala_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    salas.set(id, { id, nombre: nombreLimpio, creador: nick, usuarios: new Set() });
    io.emit('salasActualizadas', listaSalas());
    io.emit('sistema', { texto: `${nick} ha creado la sala "${nombreLimpio}"` });
  });

  // ---- Unirse a sala ----
  socket.on('unirseSala', ({ salaId }) => {
    const sala = salas.get(salaId);
    if (!sala) return;

    const yaUnido = socket.data.salasUnidas.has(salaId);
    const esPrivilegiado = esModOAdmin(socket.id);

    if (!yaUnido && !esPrivilegiado && socket.data.salasUnidas.size >= MAX_SALAS_POR_USUARIO) {
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
    const esPrivilegiado = esModOAdmin(socket.id);
    if (!esPrivilegiado && !socket.data.salasUnidas.has(salaId)) return;

    const textoLimpio = String(texto || '').trim().slice(0, 500);
    if (!textoLimpio) return;

    const msg = {
      salaId,
      nick: usuariosConectados.get(socket.id),
      rol: socket.id === adminSocketId ? 'admin' : (moderadores.has(socket.id) ? 'moderador' : 'usuario'),
      texto: textoLimpio,
      hora: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    };

    // Se envia a todos los que estan dentro de la sala
    io.to(salaId).emit('mensajeSala', msg);

    // Copia para admin/moderadores que no esten dentro, para control total
    const espectadores = [adminSocketId, ...moderadores].filter(id => id && !sala.usuarios.has(id));
    espectadores.forEach(id => io.to(id).emit('mensajeSala', msg));
  });

  // ---- Reclamar rol de administrador ----
  socket.on('reclamarAdmin', ({ clave }) => {
    if (adminSocketId && adminSocketId !== socket.id) {
      socket.emit('error_app', 'Ya hay un administrador asignado en este chat.');
      return;
    }
    if (clave !== ADMIN_KEY) {
      socket.emit('error_app', 'Clave incorrecta.');
      return;
    }
    adminSocketId = socket.id;
    socket.emit('rolAsignado', { rol: 'admin' });
    io.emit('sistema', { texto: `${nick} es ahora el administrador del chat` });
  });

  // ---- Asignar moderador (solo admin) ----
  socket.on('asignarModerador', ({ nickObjetivo }) => {
    if (socket.id !== adminSocketId) return;
    if (moderadores.size >= MAX_MODERADORES) {
      socket.emit('error_app', 'Ya hay 5 moderadores, el maximo permitido.');
      return;
    }
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n === nickObjetivo);
    if (!destino) {
      socket.emit('error_app', 'No se encuentra a ese usuario conectado.');
      return;
    }
    moderadores.add(destino[0]);
    io.to(destino[0]).emit('rolAsignado', { rol: 'moderador' });
    io.emit('sistema', { texto: `${nickObjetivo} es ahora moderador` });
  });

  // ---- Quitar moderador (solo admin) ----
  socket.on('quitarModerador', ({ nickObjetivo }) => {
    if (socket.id !== adminSocketId) return;
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n === nickObjetivo);
    if (!destino) return;
    moderadores.delete(destino[0]);
    io.to(destino[0]).emit('rolAsignado', { rol: 'usuario' });
    io.emit('sistema', { texto: `${nickObjetivo} ya no es moderador` });
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
server.listen(PUERTO, () => {
  console.log(`Chat educativo escuchando en el puerto ${PUERTO}`);
});
