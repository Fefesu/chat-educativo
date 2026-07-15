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
const btnAdjuntar = document.getElementById('btnAdjuntar');
const inputArchivo = document.getElementById('inputArchivo');
const privadosContenedor = document.getElementById('privadosContenedor');
const cabeceraBaneados = document.getElementById('cabeceraBaneados');
const flechaBaneados = document.getElementById('flechaBaneados');
const listaBaneadosEl = document.getElementById('listaBaneadosEl');

const usuariosPorSala = {}; // salaId -> array de nicks presentes ahora mismo
const privados = {}; // canalId -> { conNick, mensajes: [], conectado: true }

// ---- Aviso de mensaje privado nuevo: sonido suave + parpadeo del titulo ----
const tituloOriginal = document.title;
let parpadeoInterval = null;

function reproducirSonidoAviso() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) { /* el navegador puede bloquear audio sin interaccion previa */ }
}

function iniciarParpadeoTitulo() {
  if (parpadeoInterval) return;
  let mostrandoAviso = false;
  parpadeoInterval = setInterval(() => {
    document.title = mostrandoAviso ? tituloOriginal : '🔔 Mensaje nuevo';
    mostrandoAviso = !mostrandoAviso;
  }, 1000);
}

function detenerParpadeoTitulo() {
  if (!parpadeoInterval) return;
  clearInterval(parpadeoInterval);
  parpadeoInterval = null;
  document.title = tituloOriginal;
}

window.addEventListener('focus', detenerParpadeoTitulo);
document.addEventListener('visibilitychange', () => { if (!document.hidden) detenerParpadeoTitulo(); });

function avisarMensajePrivadoNuevo() {
  reproducirSonidoAviso();
  if (document.hidden || !document.hasFocus()) iniciarParpadeoTitulo();
}

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

function crearBotonReportar(nickReportado, texto) {
  const btn = document.createElement('button');
  btn.className = 'btn-reportar';
  btn.textContent = '🚩';
  btn.title = 'Reportar este mensaje';
  btn.addEventListener('click', () => {
    if (confirm(`¿Reportar este mensaje de ${nickReportado} a los moderadores?`)) {
      socket.emit('reportarMensaje', { salaId: salaActiva, nickReportado, texto });
    }
  });
  return btn;
}

function renderMensajes() {
  chat.innerHTML = '';
  const lista = mensajesPorSala[salaActiva] || [];
  lista.forEach(item => {
    const div = document.createElement('div');
    if (item.tipo === 'sistema') {
      div.className = 'sistema';
      div.textContent = item.texto;
    } else if (item.tipo === 'imagen') {
      div.className = 'mensaje' + (item.nick === miNick ? ' propio' : '');
      const cuerpoImg = item.eliminada
        ? '<p class="imagen-eliminada">🕒 Imagen eliminada tras 3 minutos</p>'
        : `<img class="imagen-chat" src="${item.imagenDataUrl}" alt="Imagen enviada por ${escapar(item.nick)}">`;
      div.innerHTML = `
        <div class="nick" style="color:${colorDeNick(item.nick)}">${escapar(item.nick)}</div>
        ${cuerpoImg}
        <div class="hora">${item.hora}</div>
      `;
      if (item.nick !== miNick) div.appendChild(crearBotonReportar(item.nick, '[imagen]'));
    } else {
      div.className = 'mensaje' + (item.nick === miNick ? ' propio' : '');
      div.innerHTML = `
        <div class="nick" style="color:${colorDeNick(item.nick)}">${escapar(item.nick)}</div>
        <div class="texto">${escapar(item.texto)}</div>
        <div class="hora">${item.hora}</div>
      `;
      if (item.nick !== miNick) div.appendChild(crearBotonReportar(item.nick, item.texto));
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
    if (n !== miNick) {
      div.addEventListener('click', () => socket.emit('abrirPrivado', { nickObjetivo: n }));
    } else {
      div.style.cursor = 'default';
      div.style.opacity = '0.7';
    }
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

    if (s.puedeCerrar) {
      const btnBorrar = document.createElement('button');
      btnBorrar.textContent = '🗑';
      btnBorrar.className = 'btn-borrar-sala';
      btnBorrar.title = esPrivilegiado() ? 'Eliminar sala' : 'Cerrar tu sala';
      btnBorrar.addEventListener('click', () => {
        if (confirm(`¿Cerrar la sala "${s.nombre}"?`)) socket.emit('eliminarSala', { salaId: s.id });
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
  if (msg.tipo === 'imagen') {
    setTimeout(() => {
      msg.eliminada = true;
      if (msg.salaId === salaActiva) renderMensajes();
    }, 3 * 60 * 1000);
  }
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

socket.on('listaBaneados', (baneados) => {
  listaBaneadosEl.innerHTML = '';
  if (baneados.length === 0) {
    listaBaneadosEl.innerHTML = '<p style="font-size:11px;color:var(--tinta-suave)">Nadie bloqueado por ahora.</p>';
    return;
  }
  baneados.forEach(b => {
    const div = document.createElement('div');
    div.className = 'fila-baneado';
    div.innerHTML = `
      <span><strong>${escapar(b.nick)}</strong></span>
      <span class="detalle-baneo">Bloqueado por ${escapar(b.baneadoPor)} · ${escapar(b.fecha)}</span>
    `;
    const btn = document.createElement('button');
    btn.textContent = 'Desbanear';
    btn.addEventListener('click', () => {
      if (confirm(`¿Desbloquear a ${b.nick}? Podra volver a entrar al chat.`)) {
        socket.emit('desbanearIP', { ip: b.ip });
      }
    });
    div.appendChild(btn);
    listaBaneadosEl.appendChild(div);
  });
});

cabeceraBaneados.addEventListener('click', () => {
  listaBaneadosEl.classList.toggle('plegada');
  flechaBaneados.textContent = listaBaneadosEl.classList.contains('plegada') ? '▸' : '▾';
  if (!listaBaneadosEl.classList.contains('plegada')) socket.emit('pedirBaneados');
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

// ---- Subida de imagenes (fotos y GIFs desde el propio dispositivo) ----
function manejarArchivoSeleccionado(file, destino) {
  if (!file.type.startsWith('image/')) { alert('Solo se permiten imagenes (foto en cualquier formato) o GIFs.'); return; }
  if (file.size > 4 * 1024 * 1024) { alert('La imagen pesa demasiado (maximo 4MB).'); return; }
  const lector = new FileReader();
  lector.onload = () => {
    const dataUrl = lector.result;
    if (destino.tipo === 'sala') {
      if (!salaActiva) { alert('Entra en una sala antes de enviar una imagen.'); return; }
      socket.emit('mensajeSala', { salaId: salaActiva, imagenDataUrl: dataUrl, imagenNombre: file.name });
    } else {
      socket.emit('imagenPrivada', { canalId: destino.canalId, imagenDataUrl: dataUrl, imagenNombre: file.name });
    }
  };
  lector.readAsDataURL(file);
}

btnAdjuntar.addEventListener('click', () => inputArchivo.click());
inputArchivo.addEventListener('change', () => {
  if (inputArchivo.files[0]) manejarArchivoSeleccionado(inputArchivo.files[0], { tipo: 'sala' });
  inputArchivo.value = '';
});

// ---- Chats privados (ventanas flotantes, maximo 2 a la vez) ----
function renderMensajesPrivado(canalId) {
  const cont = document.getElementById(`chatPrivado_${canalId}`);
  const p = privados[canalId];
  if (!cont || !p) return;
  cont.innerHTML = '';
  p.mensajes.forEach(m => {
    const div = document.createElement('div');
    div.className = 'msg-privado' + (m.nick === miNick ? ' propio' : '');
    const cuerpo = m.tipo === 'imagen'
      ? `<img src="${m.imagenDataUrl}" alt="Imagen privada">`
      : `<div>${escapar(m.texto)}</div>`;
    div.innerHTML = `<div class="nick-privado" style="color:${colorDeNick(m.nick)}">${escapar(m.nick)}</div>${cuerpo}<div class="hora">${m.hora}</div>`;
    cont.appendChild(div);
  });
  cont.scrollTop = cont.scrollHeight;
}

function renderPrivados() {
  privadosContenedor.innerHTML = '';
  Object.keys(privados).forEach(canalId => {
    const p = privados[canalId];
    const div = document.createElement('div');
    div.className = 'ventana-privado';
    div.innerHTML = `
      <div class="ventana-privado-cab">
        <span>${escapar(p.conNick)}${p.conectado ? '' : ' <span class="estado-privado">(desconectado)</span>'}</span>
        <button type="button" class="btn-cerrar-privado">✕</button>
      </div>
      <div class="ventana-privado-chat" id="chatPrivado_${canalId}"></div>
      <div class="ventana-privado-input">
        <input type="text" placeholder="Mensaje privado..." ${p.conectado ? '' : 'disabled'}>
        <button type="button" class="btn-foto-privado" ${p.conectado ? '' : 'disabled'}>📷</button>
        <button type="button" class="btn-enviar-privado" ${p.conectado ? '' : 'disabled'}>➤</button>
      </div>
    `;
    privadosContenedor.appendChild(div);
    renderMensajesPrivado(canalId);

    div.querySelector('.btn-cerrar-privado').addEventListener('click', () => {
      socket.emit('cerrarPrivado', { canalId });
      delete privados[canalId];
      renderPrivados();
    });

    const inputP = div.querySelector('input[type="text"]');
    const enviar = () => {
      const texto = inputP.value.trim();
      if (!texto) return;
      socket.emit('mensajePrivado', { canalId, texto });
      inputP.value = '';
    };
    div.querySelector('.btn-enviar-privado').addEventListener('click', enviar);
    inputP.addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });

    div.querySelector('.btn-foto-privado').addEventListener('click', () => {
      const inputTemp = document.createElement('input');
      inputTemp.type = 'file';
      inputTemp.accept = 'image/*';
      inputTemp.addEventListener('change', () => {
        if (inputTemp.files[0]) manejarArchivoSeleccionado(inputTemp.files[0], { tipo: 'privado', canalId });
      });
      inputTemp.click();
    });
  });
}

socket.on('privadoAbierto', ({ canalId, conNick }) => {
  if (!privados[canalId]) privados[canalId] = { conNick, mensajes: [], conectado: true };
  renderPrivados();
});

socket.on('mensajePrivado', ({ canalId, nick, texto, hora }) => {
  if (!privados[canalId]) return;
  privados[canalId].mensajes.push({ nick, texto, hora, tipo: 'texto' });
  renderMensajesPrivado(canalId);
  if (nick !== miNick) avisarMensajePrivadoNuevo();
});

socket.on('imagenPrivada', ({ canalId, nick, imagenDataUrl, hora }) => {
  if (!privados[canalId]) return;
  privados[canalId].mensajes.push({ nick, imagenDataUrl, hora, tipo: 'imagen' });
  renderMensajesPrivado(canalId);
  if (nick !== miNick) avisarMensajePrivadoNuevo();
});

socket.on('privadoCerrado', ({ canalId, motivo }) => {
  if (!privados[canalId]) return;
  if (motivo === 'desconexion') {
    privados[canalId].conectado = false;
    renderPrivados();
    setTimeout(() => { delete privados[canalId]; renderPrivados(); }, 5000);
  } else {
    delete privados[canalId];
    renderPrivados();
  }
});
