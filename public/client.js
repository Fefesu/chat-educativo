const socket = io();

const chat = document.getElementById('chat');
const formulario = document.getElementById('formulario');
const entrada = document.getElementById('entrada');
const totalConectados = document.getElementById('totalConectados');
const listaSalasEl = document.getElementById('listaSalas');
const contadorSalas = document.getElementById('contadorSalas');
const formCrearSala = document.getElementById('formCrearSala');
const nombreSalaInput = document.getElementById('nombreSala');
const pestañasEl = document.getElementById('pestañas');
const btnAdmin = document.getElementById('btnAdmin');
const etiquetaRol = document.getElementById('etiquetaRol');
const panelAdmin = document.getElementById('panelAdmin');
const btnAsignarMod = document.getElementById('btnAsignarMod');
const nickModeradorInput = document.getElementById('nickModerador');
const listaUsuariosAdmin = document.getElementById('listaUsuariosAdmin');

let miNick = null;
let miRol = 'usuario';
let salasDisponibles = [];
let salasUnidas = new Set();
let salaActiva = null;
const mensajesPorSala = {};

function escapar(str) {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML;
}

function esPrivilegiado() {
  return miRol === 'admin' || miRol === 'moderador';
}

function idsAMostrarComoPestañas() {
  return esPrivilegiado() ? salasDisponibles.map(s => s.id) : Array.from(salasUnidas);
}

function nombreDeSala(id) {
  const s = salasDisponibles.find(s => s.id === id);
  return s ? s.nombre : '';
}

function renderPestañas() {
  const ids = idsAMostrarComoPestañas();
  pestañasEl.innerHTML = '';
  if (!ids.includes(salaActiva)) salaActiva = ids[0] || null;

  ids.forEach(id => {
    const b = document.createElement('button');
    b.className = 'pestaña' + (id === salaActiva ? ' activa' : '');
    b.textContent = nombreDeSala(id);
    b.addEventListener('click', () => {
      salaActiva = id;
      renderPestañas();
      renderMensajes();
    });
    pestañasEl.appendChild(b);
  });

  entrada.disabled = !salaActiva;
  entrada.placeholder = salaActiva ? 'Escribe algo con respeto y buen humor...' : 'Entra en una sala para escribir';
}

function renderMensajes() {
  chat.innerHTML = '';
  const lista = mensajesPorSala[salaActiva] || [];
  lista.forEach(item => {
    const div = document.createElement('div');
    if (item.tipo === 'sistema') {
      div.className = 'sistema';
      div.textContent = item.texto;
    } else {
      div.className = 'mensaje' + (item.nick === miNick ? ' propio' : '');
      const etiquetaRolMsg = item.rol && item.rol !== 'usuario' ? ` · ${item.rol}` : '';
      div.innerHTML = `
        <div class="nick">${escapar(item.nick)}${etiquetaRolMsg}</div>
        <div class="texto">${escapar(item.texto)}</div>
        <div class="hora">${item.hora}</div>
      `;
    }
    chat.appendChild(div);
  });
  chat.scrollTop = chat.scrollHeight;
}

function renderListaSalas() {
  contadorSalas.textContent = `(${salasDisponibles.length}/10)`;
  listaSalasEl.innerHTML = '';
  salasDisponibles.forEach(s => {
    const unido = salasUnidas.has(s.id);
    const div = document.createElement('div');
    div.className = 'item-sala' + (s.id === salaActiva && (unido || esPrivilegiado()) ? ' activa' : '');
    div.innerHTML = `
      <span>${escapar(s.nombre)} <small>(${s.numUsuarios})</small></span>
    `;
    const btn = document.createElement('button');
    if (esPrivilegiado()) {
      btn.textContent = 'Ver';
      btn.addEventListener('click', () => { salaActiva = s.id; renderPestañas(); renderMensajes(); });
    } else if (unido) {
      btn.textContent = 'Salir';
      btn.addEventListener('click', () => socket.emit('salirSala', { salaId: s.id }));
    } else {
      btn.textContent = 'Entrar';
      btn.addEventListener('click', () => socket.emit('unirseSala', { salaId: s.id }));
    }
    div.appendChild(btn);
    listaSalasEl.appendChild(div);
  });
}

function agregarSistemaGlobal(texto) {
  // Se añade a la sala activa como aviso, y se guarda tambien en cada sala unida
  const ids = idsAMostrarComoPestañas();
  ids.forEach(id => {
    if (!mensajesPorSala[id]) mensajesPorSala[id] = [];
    mensajesPorSala[id].push({ tipo: 'sistema', texto });
  });
  if (salaActiva) renderMensajes();
}

// ---- Eventos del servidor ----
socket.on('bienvenida', ({ nick, totalConectados: total, salas }) => {
  miNick = nick;
  totalConectados.textContent = `${total} conectados · tu eres ${nick}`;
  salasDisponibles = salas;
  renderListaSalas();
  renderPestañas();
});

socket.on('totalConectados', (n) => {
  totalConectados.textContent = `${n} conectados${miNick ? ' · tu eres ' + miNick : ''}`;
});

socket.on('salasActualizadas', (salas) => {
  salasDisponibles = salas;
  renderListaSalas();
  renderPestañas();
});

socket.on('unido', ({ salaId }) => {
  salasUnidas.add(salaId);
  salaActiva = salaId;
  if (!mensajesPorSala[salaId]) mensajesPorSala[salaId] = [];
  renderListaSalas();
  renderPestañas();
  renderMensajes();
});

socket.on('mensajeSala', (msg) => {
  if (!mensajesPorSala[msg.salaId]) mensajesPorSala[msg.salaId] = [];
  mensajesPorSala[msg.salaId].push(msg);
  if (msg.salaId === salaActiva) renderMensajes();
});

socket.on('sistema', ({ texto }) => {
  agregarSistemaGlobal(texto);
  if (miRol === 'admin') socket.emit('pedirUsuarios');
});

socket.on('error_app', (texto) => alert(texto));

socket.on('rolAsignado', ({ rol }) => {
  miRol = rol;
  etiquetaRol.textContent = rol === 'admin' ? '👑 Administrador' : rol === 'moderador' ? '🛡️ Moderador' : '';
  btnAdmin.classList.toggle('oculto', rol !== 'usuario');
  panelAdmin.classList.toggle('oculto', rol !== 'admin');
  if (rol === 'admin') socket.emit('pedirUsuarios');
  renderListaSalas();
  renderPestañas();
});

socket.on('listaUsuarios', (usuarios) => {
  listaUsuariosAdmin.innerHTML = '';
  usuarios.forEach(u => {
    const div = document.createElement('div');
    div.className = 'fila-usuario-admin';
    div.innerHTML = `<span>${escapar(u.nick)} <small>${u.rol !== 'usuario' ? '· ' + u.rol : ''}</small></span>`;
    if (u.rol === 'moderador') {
      const btn = document.createElement('button');
      btn.textContent = 'Quitar mod';
      btn.addEventListener('click', () => socket.emit('quitarModerador', { nickObjetivo: u.nick }));
      div.appendChild(btn);
    }
    listaUsuariosAdmin.appendChild(div);
  });
});

// ---- Acciones del usuario ----
formulario.addEventListener('submit', (e) => {
  e.preventDefault();
  const texto = entrada.value.trim();
  if (!texto || !salaActiva) return;
  socket.emit('mensajeSala', { salaId: salaActiva, texto });
  entrada.value = '';
});

formCrearSala.addEventListener('submit', (e) => {
  e.preventDefault();
  const nombre = nombreSalaInput.value.trim();
  if (!nombre) return;
  socket.emit('crearSala', { nombre });
  nombreSalaInput.value = '';
});

btnAdmin.addEventListener('click', () => {
  const clave = prompt('Introduce la clave de administrador:');
  if (clave) socket.emit('reclamarAdmin', { clave });
});

btnAsignarMod.addEventListener('click', () => {
  const nickObjetivo = nickModeradorInput.value.trim();
  if (!nickObjetivo) return;
  socket.emit('asignarModerador', { nickObjetivo });
  nickModeradorInput.value = '';
});
