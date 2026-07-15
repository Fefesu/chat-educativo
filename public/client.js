const socket = io();

const chat = document.getElementById('chat');
const formulario = document.getElementById('formulario');
const entrada = document.getElementById('entrada');
const totalConectados = document.getElementById('totalConectados');
const listaSalasEl = document.getElementById('listaSalas');
const cabeceraSalas = document.getElementById('cabeceraSalas');
const flechaSalas = document.getElementById('flechaSalas');
const contadorSalas = document.getElementById('contadorSalas');
const formCrearSala = document.getElementById('formCrearSala');
const nombreSalaInput = document.getElementById('nombreSala');
const pestañasEl = document.getElementById('pestañas');
const btnAdmin = document.getElementById('btnAdmin');
const etiquetaRol = document.getElementById('etiquetaRol');
const panelAdmin = document.getElementById('panelAdmin');
const btnAsignarMod = document.getElementById('btnAsignarMod');
const usuarioResetInput = document.getElementById('usuarioResetInput');
const nuevaContrasenaInput = document.getElementById('nuevaContrasenaInput');
const btnResetPass = document.getElementById('btnResetPass');
const nickModeradorInput = document.getElementById('nickModerador');
const listaUsuariosAdmin = document.getElementById('listaUsuariosAdmin');
const usuarioInput = document.getElementById('usuarioInput');
const contrasenaInput = document.getElementById('contrasenaInput');
const btnRegistrar = document.getElementById('btnRegistrar');
const btnIniciarSesion = document.getElementById('btnIniciarSesion');
const cuentaAnonima = document.getElementById('cuentaAnonima');
const cuentaConectada = document.getElementById('cuentaConectada');
const textoConectadoComo = document.getElementById('textoConectadoComo');
const avisoEscribiendo = document.getElementById('avisoEscribiendo');
const mayorEdadInput = document.getElementById('mayorEdadInput');
const seccionAsignarMod = document.getElementById('seccionAsignarMod');
const listaConectadosSala = document.getElementById('listaConectadosSala');
const contadorConectadosSala = document.getElementById('contadorConectadosSala');

const usuariosPorSala = {}; // salaId -> array de nicks presentes ahora mismo

let miNick = null;
let miRol = 'usuario';
let salasDisponibles = [];
let salasUnidas = new Set();
let salaActiva = null;
const mensajesPorSala = {};
const escribiendoPorSala = {}; // salaId -> Set de nicks escribiendo
const timersEscribiendo = {};  // "salaId:nick" -> timeout id
let miTimerEscribiendo = null;

function escapar(str) {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML;
}

// Paleta de colores para diferenciar nicks. La misma persona siempre
// obtiene el mismo color (se calcula a partir de las letras de su nick),
// asi que se ve igual en la pantalla de todo el mundo.
const PALETA_NICKS = ['#B24C4C', '#4C6FB2', '#7A4CB2', '#3E8E8E', '#B2854C', '#3E8E5C', '#B24C8F', '#5C6BC0', '#2F7DA6', '#A65E2F'];
const PALETA_SALAS = ['#C9622A', '#2F7D6B', '#7A4CB2', '#B23F63', '#2F6EA6', '#8E7A2F', '#4C8F3E', '#A6472F', '#4C6FB2', '#8F3E6B'];

function colorDeSala(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETA_SALAS[Math.abs(hash) % PALETA_SALAS.length];
}

function colorDeNick(nick) {
  let hash = 0;
  for (let i = 0; i < nick.length; i++) {
    hash = nick.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETA_NICKS[Math.abs(hash) % PALETA_NICKS.length];
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
    const color = colorDeSala(id);
    const activa = id === salaActiva;
    b.className = 'pestaña' + (activa ? ' activa' : '');
    b.style.borderLeft = `4px solid ${color}`;
    if (activa) { b.style.background = color; b.style.color = '#fff'; }
    b.textContent = nombreDeSala(id);
    b.addEventListener('click', () => {
      salaActiva = id;
      renderPestañas();
      renderMensajes();
      renderAvisoEscribiendo();
      socket.emit('pedirUsuariosDeSala', { salaId: id });
    });
    pestañasEl.appendChild(b);
  });

  entrada.disabled = !salaActiva;
  entrada.placeholder = salaActiva ? 'Escribe algo con respeto y buen humor...' : 'Entra en una sala para escribir';
  renderAvisoEscribiendo();
  renderListaConectadosSala();
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
        <div class="nick" style="color:${colorDeNick(item.nick)}">${escapar(item.nick)}${etiquetaRolMsg}</div>
        <div class="texto">${escapar(item.texto)}</div>
        <div class="hora">${item.hora}</div>
      `;
    }
    chat.appendChild(div);
  });
  chat.scrollTop = chat.scrollHeight;
}

function renderAvisoEscribiendo() {
  const set = escribiendoPorSala[salaActiva];
  if (!set || set.size === 0) { avisoEscribiendo.textContent = ''; return; }
  const nombres = Array.from(set);
  if (nombres.length === 1) avisoEscribiendo.textContent = `${nombres[0]} está escribiendo...`;
  else if (nombres.length === 2) avisoEscribiendo.textContent = `${nombres[0]} y ${nombres[1]} están escribiendo...`;
  else avisoEscribiendo.textContent = `Varias personas están escribiendo...`;
}

function renderListaConectadosSala() {
  const nicks = usuariosPorSala[salaActiva] || [];
  contadorConectadosSala.textContent = nicks.length;
  listaConectadosSala.innerHTML = '';
  nicks.forEach(n => {
    const div = document.createElement('div');
    div.className = 'item-conectado';
    div.innerHTML = `<span class="punto-conexion online"></span><span style="color:${colorDeNick(n)}">${escapar(n)}</span>`;
    listaConectadosSala.appendChild(div);
  });
}

function renderListaSalas() {
  contadorSalas.textContent = `(${salasDisponibles.length}/10)`;
  listaSalasEl.innerHTML = '';
  salasDisponibles.forEach(s => {
    const unido = salasUnidas.has(s.id);
    const div = document.createElement('div');
    div.className = 'item-sala' + (s.id === salaActiva && (unido || esPrivilegiado()) ? ' activa' : '');
    div.style.borderLeft = `4px solid ${colorDeSala(s.id)}`;
    div.innerHTML = `
      <span>${s.permanente ? '🔒 ' : ''}${escapar(s.nombre)} <small>(${s.numUsuarios})</small></span>
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

    if (esPrivilegiado()) {
      const btnBorrar = document.createElement('button');
      btnBorrar.textContent = '🗑';
      btnBorrar.className = 'btn-borrar-sala';
      btnBorrar.addEventListener('click', () => {
        if (confirm(`¿Eliminar la sala "${s.nombre}"?`)) socket.emit('eliminarSala', { salaId: s.id });
      });
      div.appendChild(btnBorrar);
    }

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

socket.on('usuariosDeSala', ({ salaId, usuarios }) => {
  usuariosPorSala[salaId] = usuarios;
  if (salaId === salaActiva) renderListaConectadosSala();
});

socket.on('unido', ({ salaId }) => {
  salasUnidas.add(salaId);
  salaActiva = salaId;
  if (!mensajesPorSala[salaId]) mensajesPorSala[salaId] = [];
  renderListaSalas();
  renderPestañas();
  renderMensajes();
});

socket.on('escribiendo', ({ salaId, nick }) => {
  if (!escribiendoPorSala[salaId]) escribiendoPorSala[salaId] = new Set();
  escribiendoPorSala[salaId].add(nick);
  if (salaId === salaActiva) renderAvisoEscribiendo();

  const clave = `${salaId}:${nick}`;
  clearTimeout(timersEscribiendo[clave]);
  timersEscribiendo[clave] = setTimeout(() => {
    escribiendoPorSala[salaId] && escribiendoPorSala[salaId].delete(nick);
    if (salaId === salaActiva) renderAvisoEscribiendo();
  }, 3000);
});

socket.on('dejoEscribir', ({ salaId, nick }) => {
  if (escribiendoPorSala[salaId]) escribiendoPorSala[salaId].delete(nick);
  if (salaId === salaActiva) renderAvisoEscribiendo();
});

socket.on('mensajeSala', (msg) => {
  if (!mensajesPorSala[msg.salaId]) mensajesPorSala[msg.salaId] = [];
  mensajesPorSala[msg.salaId].push(msg);
  if (escribiendoPorSala[msg.salaId]) escribiendoPorSala[msg.salaId].delete(msg.nick);
  if (msg.salaId === salaActiva) { renderMensajes(); renderAvisoEscribiendo(); }
});

socket.on('salaEliminada', ({ salaId }) => {
  salasUnidas.delete(salaId);
  delete mensajesPorSala[salaId];
  if (salaActiva === salaId) salaActiva = null;
  renderListaSalas();
  renderPestañas();
});

socket.on('sistema', ({ texto }) => {
  agregarSistemaGlobal(texto);
  if (esPrivilegiado()) socket.emit('pedirUsuarios');
});

socket.on('error_app', (texto) => alert(texto));
socket.on('avisoOk', (texto) => alert(texto));

socket.on('rolAsignado', ({ rol }) => {
  miRol = rol;
  etiquetaRol.textContent = rol === 'admin' ? '👑 Administrador' : rol === 'moderador' ? '🛡️ Moderador' : '';
  btnAdmin.classList.toggle('oculto', rol !== 'usuario');
  panelAdmin.classList.toggle('oculto', !esPrivilegiado());
  seccionAsignarMod.classList.toggle('oculto', rol !== 'admin');
  if (esPrivilegiado()) socket.emit('pedirUsuarios');
  renderListaSalas();
  renderPestañas();
});

socket.on('listaUsuarios', (usuarios) => {
  listaUsuariosAdmin.innerHTML = '';
  usuarios.forEach(u => {
    const div = document.createElement('div');
    div.className = 'fila-usuario-admin';
    div.innerHTML = `<span>${escapar(u.nick)} <small>${u.rol !== 'usuario' ? '· ' + u.rol : ''}</small></span>`;
    if (u.rol === 'moderador' && miRol === 'admin') {
      const btn = document.createElement('button');
      btn.textContent = 'Quitar mod';
      btn.addEventListener('click', () => socket.emit('quitarModerador', { nickObjetivo: u.nick }));
      div.appendChild(btn);
    }
    if (u.nick !== miNick && u.rol !== 'admin') {
      const btnBan = document.createElement('button');
      btnBan.textContent = 'Banear IP';
      btnBan.className = 'btn-banear';
      btnBan.addEventListener('click', () => {
        if (confirm(`¿Bloquear a ${u.nick} de este chat? No podra volver a entrar.`)) {
          socket.emit('banearIP', { nickObjetivo: u.nick });
        }
      });
      div.appendChild(btnBan);
    }
    listaUsuariosAdmin.appendChild(div);
  });
});

socket.on('sesionIniciada', ({ usuario, rol }) => {
  miNick = usuario;
  cuentaAnonima.classList.add('oculto');
  cuentaConectada.classList.remove('oculto');
  textoConectadoComo.textContent = `Conectado como ${usuario}`;
  if (rol !== 'usuario') {
    miRol = rol;
    etiquetaRol.textContent = rol === 'admin' ? '👑 Administrador' : '🛡️ Moderador';
    panelAdmin.classList.remove('oculto');
    seccionAsignarMod.classList.toggle('oculto', rol !== 'admin');
    socket.emit('pedirUsuarios');
  }
  btnAdmin.classList.toggle('oculto', rol !== 'usuario');
  renderListaSalas();
  renderPestañas();
});

// ---- Acciones del usuario ----
entrada.addEventListener('input', () => {
  if (!salaActiva) return;
  socket.emit('escribiendo', { salaId: salaActiva });
  clearTimeout(miTimerEscribiendo);
  miTimerEscribiendo = setTimeout(() => {
    socket.emit('dejoEscribir', { salaId: salaActiva });
  }, 2000);
});

formulario.addEventListener('submit', (e) => {
  e.preventDefault();
  const texto = entrada.value.trim();
  if (!texto || !salaActiva) return;
  socket.emit('mensajeSala', { salaId: salaActiva, texto });
  socket.emit('dejoEscribir', { salaId: salaActiva });
  clearTimeout(miTimerEscribiendo);
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

cabeceraSalas.addEventListener('click', () => {
  listaSalasEl.classList.toggle('plegada');
  flechaSalas.textContent = listaSalasEl.classList.contains('plegada') ? '▸' : '▾';
});

btnAsignarMod.addEventListener('click', () => {
  const nickObjetivo = nickModeradorInput.value.trim();
  if (!nickObjetivo) return;
  socket.emit('asignarModerador', { nickObjetivo });
  nickModeradorInput.value = '';
});

btnResetPass.addEventListener('click', () => {
  const usuario = usuarioResetInput.value.trim();
  const nuevaContrasena = nuevaContrasenaInput.value;
  if (!usuario || !nuevaContrasena) { alert('Rellena el usuario y la nueva contrasena.'); return; }
  socket.emit('restablecerContrasena', { usuario, nuevaContrasena });
  usuarioResetInput.value = '';
  nuevaContrasenaInput.value = '';
});

btnRegistrar.addEventListener('click', () => {
  const usuario = usuarioInput.value.trim();
  const contrasena = contrasenaInput.value;
  if (!usuario || !contrasena) { alert('Rellena usuario y contrasena.'); return; }
  if (!mayorEdadInput.checked) { alert('Debes confirmar que eres mayor de 18 años.'); return; }
  socket.emit('registrar', { usuario, contrasena, mayorDeEdad: true });
});

btnIniciarSesion.addEventListener('click', () => {
  const usuario = usuarioInput.value.trim();
  const contrasena = contrasenaInput.value;
  if (!usuario || !contrasena) { alert('Rellena usuario y contrasena.'); return; }
  socket.emit('iniciarSesion', { usuario, contrasena });
});
