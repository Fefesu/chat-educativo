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
const seccionCrearMod = document.getElementById('seccionCrearMod');
const usuarioNuevoModInput = document.getElementById('usuarioNuevoModInput');
const contrasenaNuevoModInput = document.getElementById('contrasenaNuevoModInput');
const btnCrearMod = document.getElementById('btnCrearMod');
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

// ---- Usuarios silenciados/ignorados (se guarda en este navegador) ----
const usuariosIgnorados = new Set(JSON.parse(localStorage.getItem('ignorados') || '[]'));
function guardarIgnorados() {
  localStorage.setItem('ignorados', JSON.stringify(Array.from(usuariosIgnorados)));
}

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

function resaltarMenciones(texto) {
  const escapado = escapar(texto);
  return escapado.replace(/@([a-zA-Z0-9_.-]{3,20})/g, (coincidencia, nombre) => {
    const esParaMi = miNick && nombre.toLowerCase() === miNick.toLowerCase();
    return `<span class="mencion${esParaMi ? ' mencion-propia' : ''}">@${nombre}</span>`;
  });
}

function contieneMiMencion(texto) {
  if (!miNick || !texto) return false;
  const regex = new RegExp(`@${miNick.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
  return regex.test(texto);
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
    b.style.setProperty('--c', color);
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

function crearBotonEliminar(mensajeId) {
  const btn = document.createElement('button');
  btn.className = 'btn-reportar btn-eliminar-msg';
  btn.textContent = '🗑';
  btn.title = 'Eliminar este mensaje';
  btn.addEventListener('click', () => {
    if (confirm('¿Eliminar este mensaje? Quedará una marca visible de que se borró.')) {
      socket.emit('eliminarMensaje', { salaId: salaActiva, mensajeId });
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
      chat.appendChild(div);
      return;
    }

    if (usuariosIgnorados.has(item.nick)) {
      div.className = 'mensaje mensaje-silenciado';
      div.innerHTML = `<p class="imagen-eliminada">🔇 Mensaje oculto (has silenciado a ${escapar(item.nick)})</p>`;
      chat.appendChild(div);
      return;
    }

    if (item.eliminadoManual) {
      div.className = 'mensaje' + (item.nick === miNick ? ' propio' : '');
      div.innerHTML = `
        <div class="nick" style="color:${colorDeNick(item.nick)}">${escapar(item.nick)}</div>
        <p class="imagen-eliminada">[Mensaje eliminado por infringir la norma de respeto]</p>
        <div class="hora">${item.hora}</div>
      `;
      chat.appendChild(div);
      return;
    }

    if (item.tipo === 'imagen') {
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
      if (esPrivilegiado() && item.id) div.appendChild(crearBotonEliminar(item.id));
    } else {
      div.className = 'mensaje' + (item.nick === miNick ? ' propio' : '');
      div.innerHTML = `
        <div class="nick" style="color:${colorDeNick(item.nick)}">${escapar(item.nick)}</div>
        <div class="texto">${resaltarMenciones(item.texto)}</div>
        <div class="hora">${item.hora}</div>
      `;
      if (item.nick !== miNick) div.appendChild(crearBotonReportar(item.nick, item.texto));
      if (esPrivilegiado() && item.id) div.appendChild(crearBotonEliminar(item.id));
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
    const escribiendoAhora = escribiendoPorSala[salaActiva] && escribiendoPorSala[salaActiva].has(n);
    const bocadillo = escribiendoAhora
      ? '<span class="bocadillo-escribiendo"><span></span><span></span><span></span></span>'
      : '';
    div.innerHTML = `<span class="punto-conexion online"></span><span style="color:${colorDeNick(n)}">${escapar(n)}</span>${bocadillo}`;
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
  const salasVisiblesCount = salasDisponibles.filter(s => s.id !== 'staff').length;
  contadorSalas.textContent = `(${salasVisiblesCount}/10)`;
  listaSalasEl.innerHTML = '';
  salasDisponibles.forEach(s => {
    const unido = salasUnidas.has(s.id);
    const div = document.createElement('div');
    div.className = 'item-sala' + (s.id === salaActiva && (unido || esPrivilegiado()) ? ' activa' : '');
    div.style.setProperty('--c', colorDeSala(s.id));
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
  totalConectados.textContent = total;
  totalConectados.dataset.num = '1';
  salasDisponibles = salas;
  renderListaSalas();
  renderPestañas();
});

socket.on('totalConectados', (n) => {
  totalConectados.textContent = n;
  totalConectados.dataset.num = '1';
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

socket.on('historialStaff', (mensajes) => {
  mensajesPorSala['staff'] = mensajes.map(m => ({ ...m, tipo: m.tipo || 'texto', salaId: 'staff' }));
  if (salaActiva === 'staff') renderMensajes();
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
  if (salaId === salaActiva) { renderAvisoEscribiendo(); renderListaConectadosSala(); }

  const clave = `${salaId}:${nick}`;
  clearTimeout(timersEscribiendo[clave]);
  timersEscribiendo[clave] = setTimeout(() => {
    escribiendoPorSala[salaId] && escribiendoPorSala[salaId].delete(nick);
    if (salaId === salaActiva) { renderAvisoEscribiendo(); renderListaConectadosSala(); }
  }, 3000);
});

socket.on('dejoEscribir', ({ salaId, nick }) => {
  if (escribiendoPorSala[salaId]) escribiendoPorSala[salaId].delete(nick);
  if (salaId === salaActiva) { renderAvisoEscribiendo(); renderListaConectadosSala(); }
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
  if (msg.tipo === 'texto' && msg.nick !== miNick && contieneMiMencion(msg.texto)) {
    avisarMensajePrivadoNuevo();
  }
  if (msg.salaId === salaActiva) { renderMensajes(); renderAvisoEscribiendo(); }
});

socket.on('mensajeEliminado', ({ salaId, mensajeId }) => {
  const lista = mensajesPorSala[salaId];
  if (!lista) return;
  const msg = lista.find(m => m.id === mensajeId);
  if (msg) msg.eliminadoManual = true;
  if (salaId === salaActiva) renderMensajes();
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

socket.on('error_app', (texto) => avisarError(texto));

socket.on('estasBaneado', ({ adminOnline, modsOnline }) => {
  const textoBoton = adminOnline
    ? 'Contactar con el administrador'
    : modsOnline
      ? 'Contactar con moderación'
      : 'Dejar un mensaje';

  document.body.innerHTML = `
    <div class="pantalla-baneado">
      <div class="pantalla-baneado-caja">
        <h2>🚫 Has sido bloqueado de este chat</h2>
        <p>Si crees que ha sido un error, puedes dejar un mensaje explicándolo. Quedará guardado y lo revisará el equipo de moderación.</p>
        <textarea id="mensajeApelacion" maxlength="500" placeholder="Escribe aquí tu mensaje..."></textarea>
        <button type="button" id="btnEnviarApelacion">${textoBoton}</button>
        <p id="avisoApelacion" class="aviso-apelacion"></p>
      </div>
    </div>
  `;
  document.getElementById('btnEnviarApelacion').addEventListener('click', async () => {
    const mensaje = document.getElementById('mensajeApelacion').value.trim();
    const aviso = document.getElementById('avisoApelacion');
    if (!mensaje) { aviso.textContent = 'Escribe algo antes de enviar.'; return; }
    try {
      const resp = await fetch('/api/apelar-baneo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje })
      });
      if (resp.ok) {
        aviso.textContent = '✅ Mensaje enviado. Gracias por tu paciencia.';
        document.getElementById('btnEnviarApelacion').disabled = true;
      } else {
        aviso.textContent = 'No se pudo enviar, inténtalo de nuevo en unos minutos.';
      }
    } catch (e) {
      aviso.textContent = 'No se pudo enviar, inténtalo de nuevo en unos minutos.';
    }
  });
});
socket.on('avisoOk', (texto) => alert(texto));

socket.on('rolAsignado', ({ rol }) => {
  miRol = rol;
  etiquetaRol.textContent = rol === 'admin' ? '👑 Administrador' : rol === 'moderador' ? '🛡️ Moderador' : '';
  btnAdmin.classList.toggle('oculto', rol !== 'usuario');
  panelAdmin.classList.toggle('oculto', !esPrivilegiado());
  seccionAsignarMod.classList.toggle('oculto', rol !== 'admin');
  seccionCrearMod.classList.toggle('oculto', rol !== 'admin');
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
    const apelaciones = (b.mensajesApelacion || []).map(m =>
      `<p class="mensaje-apelacion">📨 "${escapar(m.texto)}" <span>(${escapar(m.fecha)})</span></p>`
    ).join('');
    div.innerHTML = `
      <span><strong>${escapar(b.nick)}</strong></span>
      <span class="detalle-baneo">Bloqueado por ${escapar(b.baneadoPor)} · ${escapar(b.fecha)}</span>
      ${apelaciones}
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

const cabeceraStats = document.getElementById('cabeceraStats');
const flechaStats = document.getElementById('flechaStats');
const panelStats = document.getElementById('panelStats');

cabeceraStats.addEventListener('click', () => {
  panelStats.classList.toggle('plegada');
  flechaStats.textContent = panelStats.classList.contains('plegada') ? '▸' : '▾';
  if (!panelStats.classList.contains('plegada')) socket.emit('pedirEstadisticas');
});

socket.on('estadisticas', (s) => {
  const filasTop = s.topUsuarios.length
    ? s.topUsuarios.map((u, i) => `<p class="stat-linea">${i + 1}. ${escapar(u.nick)} — ${u.total} mensajes</p>`).join('')
    : '<p class="stat-linea">Todavía no hay datos suficientes.</p>';

  panelStats.innerHTML = `
    <p class="stat-linea"><strong>${s.conectadosAhora}</strong> conectados ahora mismo</p>
    <p class="stat-linea"><strong>${s.salasActivas}</strong> salas activas</p>
    <p class="stat-linea"><strong>${s.totalRegistrados}</strong> cuentas registradas</p>
    <p class="stat-linea"><strong>${s.mensajesHoy}</strong> mensajes hoy</p>
    <p class="stat-linea"><strong>${s.totalMensajes}</strong> mensajes en total</p>
    <p class="stat-linea">Hora con más actividad: <strong>${s.horaPico || '—'}</strong></p>
    <p class="panel-admin-subtitulo" style="margin-top:8px;">Usuarios más activos:</p>
    ${filasTop}
  `;
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

socket.on('sesionCerrada', ({ nick }) => {
  miNick = nick;
  miRol = 'usuario';
  cuentaAnonima.classList.remove('oculto');
  cuentaConectada.classList.add('oculto');
  usuarioInput.value = '';
  contrasenaInput.value = '';
  if (mayorEdadInput) mayorEdadInput.checked = false;
  etiquetaRol.textContent = '';
  btnAdmin.classList.remove('oculto');
  panelAdmin.classList.add('oculto');
  renderListaSalas();
  renderPestañas();
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
  seccionCrearMod.classList.toggle('oculto', rol !== 'admin');
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

// ---- Modo oscuro ----
const btnTema = document.getElementById('btnTema');
function actualizarIconoTema() {
  btnTema.textContent = document.documentElement.getAttribute('data-tema') === 'oscuro' ? '☀️' : '🌙';
}
actualizarIconoTema();
btnTema.addEventListener('click', () => {
  const esOscuroAhora = document.documentElement.getAttribute('data-tema') === 'oscuro';
  if (esOscuroAhora) {
    document.documentElement.removeAttribute('data-tema');
    localStorage.setItem('tema', 'claro');
  } else {
    document.documentElement.setAttribute('data-tema', 'oscuro');
    localStorage.setItem('tema', 'oscuro');
  }
  actualizarIconoTema();
});

const btnVerNormas = document.getElementById('btnVerNormas');
const modalNormas = document.getElementById('modalNormas');
const btnCerrarNormas = document.getElementById('btnCerrarNormas');

if (btnVerNormas) {
  btnVerNormas.addEventListener('click', () => modalNormas.classList.remove('oculto'));
  btnCerrarNormas.addEventListener('click', () => modalNormas.classList.add('oculto'));
  modalNormas.addEventListener('click', (e) => { if (e.target === modalNormas) modalNormas.classList.add('oculto'); });
}

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

btnCrearMod.addEventListener('click', () => {
  const usuario = usuarioNuevoModInput.value.trim();
  const contrasena = contrasenaNuevoModInput.value;
  if (!usuario || !contrasena) { alert('Rellena el usuario y la contrasena.'); return; }
  socket.emit('crearCuentaModerador', { usuario, contrasena });
  usuarioNuevoModInput.value = '';
  contrasenaNuevoModInput.value = '';
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
  if (!usuario || !contrasena) { avisarAcceso('Rellena usuario y contraseña.'); return; }
  if (contrasena !== document.getElementById('contrasena2Input').value) { avisarAcceso('Las contraseñas no coinciden.'); return; }
  if (contrasena.length < 8) { avisarAcceso('La contraseña debe tener al menos 8 caracteres.'); return; }
  if (correoActivo && !emailInput.value.trim()) { avisarAcceso('Escribe tu correo electrónico: lo necesitarás para recuperar tu contraseña.'); return; }
  socket.emit('registrar', { usuario, contrasena, mayorDeEdad: true, email: emailInput.value.trim() });
});

btnIniciarSesion.addEventListener('click', () => {
  const usuario = usuarioInput.value.trim();
  const contrasena = contrasenaInput.value;
  if (!usuario || !contrasena) { avisarAcceso('Rellena usuario y contraseña.'); return; }
  socket.emit('iniciarSesion', { usuario, contrasena });
});

document.getElementById('btnCerrarSesion').addEventListener('click', () => {
  if (confirm('¿Cerrar tu sesión?')) socket.emit('cerrarSesion');
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

// ---- Selector de emojis (por categorías, con recientes) ----
const CATEGORIAS_EMOJI = [
  { icono: '🕘', nombre: 'Recientes', lista: null },
  { icono: '😀', nombre: 'Caras', lista: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 🤡 💩 👻 💀 ☠️ 👽 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾' },
  { icono: '👍', nombre: 'Gestos', lista: '👍 👎 👊 ✊ 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✌️ 🤞 🤟 🤘 👌 🤏 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤙 💪 🦾 ✍️ 🤳 💅 👀 👂 👃 👄 🧠 🦷 🙋 🙆 🙅 🤷 🤦 🙇 💁 🕺 💃 👯 🧑‍🤝‍🧑 👶 👦 👧 🧑 👨 👩 🧓 👴 👵' },
  { icono: '❤️', nombre: 'Corazones', lista: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💋 💌 💐 🌹 🥀 😍 🥰 😘 😻 🫶' },
  { icono: '🐶', nombre: 'Animales y naturaleza', lista: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🐢 🐍 🦎 🐙 🦑 🦐 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦒 🐪 🐑 🐐 🐕 🐈 🐓 🦜 🕊️ 🐇 🐿️ 🦔 🌸 🌹 🌺 🌻 🌼 🌷 🌱 🌲 🌳 🌴 🌵 🍀 🍁 🍂 🍃 🌾 ☘️ ☀️ 🌤️ ⛅ 🌈 ☁️ 🌧️ ⛈️ ❄️ ⛄ 🔥 💧 🌊 🌙 ⭐ 🌟 ✨ ⚡ 🌍' },
  { icono: '🍕', nombre: 'Comida y bebida', lista: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥕 🌽 🌶️ 🥔 🍠 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🍢 🍡 🍧 🍨 🍦 🥧 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 ☕ 🍵 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾 🧊 🍴 🥄' },
  { icono: '⚽', nombre: 'Deporte y ocio', lista: '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏒 🏑 🥍 🏏 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 ⛸️ 🎿 🏂 🏋️ 🤸 🚴 🏊 🎮 🕹️ 🎲 🧩 🎯 🎳 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🏆 🥇 🥈 🥉 🏅 🎖️ 🎪 🎉 🎊 🎈 🎁 🎀' },
  { icono: '🚗', nombre: 'Viajes y lugares', lista: '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚚 🚜 🛵 🏍️ 🚲 🛴 🚂 🚆 🚇 🚈 ✈️ 🛫 🛬 🚀 🛸 🚁 ⛵ 🚤 🛳️ ⚓ 🏠 🏡 🏢 🏥 🏫 🏰 🗼 🗽 ⛪ 🕌 🌋 🏖️ 🏝️ ⛺ 🌃 🌉 🎡 🎢 🗺️ 🧭' },
  { icono: '💡', nombre: 'Objetos', lista: '💡 📱 💻 🖥️ ⌨️ 🖱️ 📷 📸 📹 🎥 📺 📻 ⏰ ⌚ 🔋 🔌 💰 💵 💳 💎 🔧 🔨 ⚙️ 🔒 🔓 🔑 📚 📖 📝 ✏️ 🖊️ 📌 📎 ✂️ 📦 📬 📧 💼 🎒 👓 🕶️ 👑 👒 🎩 🧢 👕 👖 👗 👟 👠 💄 💍 🌂 ☂️ 🧳 🛒 🧸 🕯️' },
  { icono: '🔣', nombre: 'Símbolos', lista: '✅ ❌ ❎ ⭕ ❗ ❓ ❕ ❔ ‼️ ⁉️ 💯 💥 💫 💦 💨 💤 💢 💬 💭 🗯️ ➕ ➖ ➗ ✖️ ♻️ ⚠️ 🚫 ⛔ 🔞 🆗 🆒 🆕 🆓 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ ▶️ ⏸️ ⏹️ ⏩ ⏪ 🔁 🔀 🔔 🔕 📣 🎵 🎶 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ✔️ ☑️ 💲' }
].map(cat => ({ ...cat, lista: cat.lista ? cat.lista.split(/\s+/).filter(Boolean) : null }));

const CLAVE_RECIENTES = 'emojisRecientes';
function leerRecientes() {
  try { const l = JSON.parse(localStorage.getItem(CLAVE_RECIENTES)); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}
function guardarReciente(emoji) {
  try { localStorage.setItem(CLAVE_RECIENTES, JSON.stringify([emoji, ...leerRecientes().filter(x => x !== emoji)].slice(0, 24))); } catch (e) { /* sin almacenamiento: no pasa nada */ }
}

const btnEmoji = document.getElementById('btnEmoji');
const panelEmoji = document.getElementById('panelEmoji');
panelEmoji.innerHTML =
  `<div class="emoji-tabs">${CATEGORIAS_EMOJI.map((cat, i) => `<button type="button" class="emoji-tab" data-i="${i}" title="${cat.nombre}">${cat.icono}</button>`).join('')}</div>` +
  '<div class="emoji-rejilla"></div>';
const rejillaEmoji = panelEmoji.querySelector('.emoji-rejilla');
const tabsEmoji = panelEmoji.querySelectorAll('.emoji-tab');

function mostrarCategoriaEmoji(i) {
  const lista = CATEGORIAS_EMOJI[i].lista || leerRecientes();
  rejillaEmoji.innerHTML = lista.length
    ? lista.map(e => `<button type="button" class="emoji-item">${e}</button>`).join('')
    : '<p class="emoji-vacio">Aquí aparecerán los emojis que uses.</p>';
  tabsEmoji.forEach((t, j) => t.classList.toggle('activa', j === i));
  rejillaEmoji.scrollTop = 0;
}

btnEmoji.addEventListener('click', (e) => {
  e.stopPropagation();
  const abrir = panelEmoji.classList.contains('oculto');
  panelEmoji.classList.toggle('oculto');
  if (abrir) mostrarCategoriaEmoji(leerRecientes().length ? 0 : 1);
});

panelEmoji.addEventListener('click', (e) => {
  const tab = e.target.closest('.emoji-tab');
  if (tab) { mostrarCategoriaEmoji(Number(tab.dataset.i)); return; }
  const item = e.target.closest('.emoji-item');
  if (!item) return;
  const emoji = item.textContent;
  if (entrada.value.length + emoji.length > entrada.maxLength) return;
  const ini = entrada.selectionStart;
  const fin = entrada.selectionEnd;
  if (ini == null) {
    entrada.value += emoji;
  } else {
    entrada.value = entrada.value.slice(0, ini) + emoji + entrada.value.slice(fin);
    entrada.setSelectionRange(ini + emoji.length, ini + emoji.length);
  }
  guardarReciente(emoji);
  // El panel se queda abierto para poder elegir varios; en móvil no se enfoca para no abrir el teclado
  if (!window.matchMedia('(pointer: coarse)').matches) entrada.focus();
});

document.addEventListener('click', (e) => {
  const ruta = e.composedPath();
  if (!ruta.includes(panelEmoji) && !ruta.includes(btnEmoji)) panelEmoji.classList.add('oculto');
});

// ---- Chats privados (ventanas flotantes, maximo 2 a la vez) ----
function renderMensajesPrivado(canalId) {
  const cont = document.getElementById(`chatPrivado_${canalId}`);
  const p = privados[canalId];
  if (!cont || !p) return;
  cont.innerHTML = '';

  if (usuariosIgnorados.has(p.conNick)) {
    cont.innerHTML = '<p class="aviso-silenciado">🔇 Has silenciado a esta persona. Ya no ves sus mensajes.</p>';
    return;
  }

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
        <div class="ventana-privado-cab-botones">
          <button type="button" class="btn-silenciar-privado" title="Silenciar a esta persona">${usuariosIgnorados.has(p.conNick) ? '🔇' : '🔊'}</button>
          <button type="button" class="btn-cerrar-privado">✕</button>
        </div>
      </div>
      <div class="ventana-privado-chat" id="chatPrivado_${canalId}"></div>
      <div class="ventana-privado-input">
        <input type="text" placeholder="Mensaje privado..." maxlength="400" ${p.conectado ? '' : 'disabled'}>
        <button type="button" class="btn-foto-privado" ${p.conectado ? '' : 'disabled'}>📷</button>
        <button type="button" class="btn-enviar-privado" ${p.conectado ? '' : 'disabled'}>➤</button>
      </div>
    `;
    privadosContenedor.appendChild(div);
    renderMensajesPrivado(canalId);

    div.querySelector('.btn-silenciar-privado').addEventListener('click', () => {
      if (usuariosIgnorados.has(p.conNick)) usuariosIgnorados.delete(p.conNick);
      else usuariosIgnorados.add(p.conNick);
      guardarIgnorados();
      renderPrivados();
      renderMensajes();
    });

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


// ================== PANTALLAS: ACCESO / CHAT ==================
const tabLogin = document.getElementById('tabLogin');
const tabRegistro = document.getElementById('tabRegistro');
const filaRepetir = document.getElementById('filaRepetir');
const ayudaRegistro = document.getElementById('ayudaRegistro');
const avisoAcceso = document.getElementById('avisoAcceso');
const estadoConexion = document.getElementById('estadoConexion');
const menuUsuario = document.getElementById('menuUsuario');
const modalMod = document.getElementById('modalMod');
const velo = document.getElementById('velo');
let modoAcceso = 'login';
let yaSaludo = false;
let correoActivo = false;
let estadoCorreoActual = null;
const emailInput = document.getElementById('emailInput');
const filaEmail = document.getElementById('filaEmail');
const filaClave = document.getElementById('filaClave');
const segmentado = document.getElementById('segmentado');
const btnRecuperar = document.getElementById('btnRecuperar');
const btnOlvide = document.getElementById('btnOlvide');
const btnVolverLogin = document.getElementById('btnVolverLogin');
const textoSinCorreo = document.getElementById('textoSinCorreo');
const ayudaRecuperar = document.getElementById('ayudaRecuperar');
const modalCorreo = document.getElementById('modalCorreo');
const avisoCorreo = document.getElementById('avisoCorreo');

function avisarAcceso(texto, correcto) {
  avisoAcceso.textContent = texto || '';
  avisoAcceso.classList.toggle('ok', !!correcto);
}

function avisarError(texto) {
  if (document.body.dataset.vista === 'acceso') avisarAcceso(texto);
  else if (!modalCorreo.classList.contains('oculto')) { avisoCorreo.textContent = texto; avisoCorreo.classList.remove('ok'); }
  else alert(texto);
}

function fijarModo(modo, conservarAviso) {
  modoAcceso = modo;
  const login = modo === 'login';
  const registro = modo === 'registro';
  const recuperar = modo === 'recuperar';
  tabLogin.classList.toggle('activo', !registro);
  tabRegistro.classList.toggle('activo', registro);
  segmentado.classList.toggle('oculto', recuperar);
  filaEmail.classList.toggle('oculto', !(recuperar || (registro && correoActivo)));
  filaClave.classList.toggle('oculto', recuperar);
  filaRepetir.classList.toggle('oculto', !registro);
  ayudaRegistro.classList.toggle('oculto', !registro);
  ayudaRecuperar.classList.toggle('oculto', !recuperar);
  btnIniciarSesion.classList.toggle('oculto', !login);
  btnRegistrar.classList.toggle('oculto', !registro);
  btnRecuperar.classList.toggle('oculto', !recuperar);
  btnOlvide.classList.toggle('oculto', !(login && correoActivo));
  btnVolverLogin.classList.toggle('oculto', !recuperar);
  textoSinCorreo.classList.toggle('oculto', correoActivo || recuperar);
  contrasenaInput.autocomplete = login ? 'current-password' : 'new-password';
  if (!conservarAviso) avisarAcceso('');
}

function sincronizarRolUI() {
  document.body.classList.toggle('es-staff', esPrivilegiado());
  document.body.classList.toggle('es-registrado', !cuentaConectada.classList.contains('oculto'));
  const nombre = miNick || '…';
  const inicial = nombre.charAt(0).toUpperCase();
  const color = miNick ? colorDeNick(miNick) : '#6D4AFF';
  ['avatarInicial', 'menuAvatar'].forEach(id => {
    const el = document.getElementById(id);
    el.textContent = inicial;
    el.style.background = color;
  });
  document.getElementById('chipNick').textContent = nombre;
  document.getElementById('menuNick').textContent = nombre;
}

function cerrarDrawers() { document.body.classList.remove('drawer-salas', 'drawer-gente'); }

function mostrarChat() {
  document.body.dataset.vista = 'chat';
  avisarAcceso('');
  sincronizarRolUI();
  chat.scrollTop = chat.scrollHeight;
}

function mostrarAcceso(texto) {
  document.body.dataset.vista = 'acceso';
  cerrarDrawers();
  menuUsuario.classList.add('oculto');
  modalMod.classList.add('oculto');
  modalCorreo.classList.add('oculto');
  fijarModo('login');
  if (texto) avisarAcceso(texto);
}

tabLogin.addEventListener('click', () => fijarModo('login'));
tabRegistro.addEventListener('click', () => fijarModo('registro'));
[usuarioInput, emailInput, contrasenaInput, document.getElementById('contrasena2Input')].forEach(inp => {
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    ({ login: btnIniciarSesion, registro: btnRegistrar, recuperar: btnRecuperar })[modoAcceso].click();
  });
});
document.getElementById('verClave').addEventListener('click', (e) => {
  const mostrar = contrasenaInput.type === 'password';
  contrasenaInput.type = mostrar ? 'text' : 'password';
  document.getElementById('contrasena2Input').type = mostrar ? 'text' : 'password';
  e.currentTarget.textContent = mostrar ? '🙈' : '👁';
});
document.getElementById('btnInvitado').addEventListener('click', mostrarChat);
document.getElementById('verNormasAcceso').addEventListener('click', () => modalNormas.classList.remove('oculto'));

// Estado de conexión (el servidor gratuito de Render puede tardar en despertar)
socket.on('connect', () => { estadoConexion.textContent = 'Conectado'; estadoConexion.classList.add('ok'); });
socket.on('disconnect', () => { estadoConexion.textContent = 'Reconectando…'; estadoConexion.classList.remove('ok'); });

socket.on('sesionIniciada', () => { mostrarChat(); });
socket.on('sesionCerrada', () => { mostrarAcceso(); sincronizarRolUI(); });
socket.on('rolAsignado', sincronizarRolUI);
socket.on('unido', cerrarDrawers);
socket.on('privadoAbierto', cerrarDrawers);

// Si el servidor se reinicia, la sesión en memoria se pierde: volvemos al acceso en limpio
socket.on('bienvenida', () => {
  if (yaSaludo && document.body.dataset.vista === 'chat') {
    salasUnidas.clear();
    salaActiva = null;
    miRol = 'usuario';
    Object.keys(mensajesPorSala).forEach(k => delete mensajesPorSala[k]);
    Object.keys(privados).forEach(k => delete privados[k]);
    renderPrivados();
    cuentaAnonima.classList.remove('oculto');
    cuentaConectada.classList.add('oculto');
    etiquetaRol.textContent = '';
    btnAdmin.classList.remove('oculto');
    panelAdmin.classList.add('oculto');
    renderListaSalas();
    renderPestañas();
    renderMensajes();
    mostrarAcceso('La conexión se reinició. Vuelve a entrar para continuar.');
  }
  yaSaludo = true;
  sincronizarRolUI();
});

// Menú de usuario
document.getElementById('btnUsuario').addEventListener('click', (e) => {
  e.stopPropagation();
  menuUsuario.classList.toggle('oculto');
});
menuUsuario.addEventListener('click', (e) => { if (e.target.closest('button')) menuUsuario.classList.add('oculto'); });
document.addEventListener('click', (e) => { if (!menuUsuario.contains(e.target)) menuUsuario.classList.add('oculto'); });

// Panel de moderación (modal, solo staff)
document.getElementById('btnPanelMod').addEventListener('click', () => {
  modalMod.classList.remove('oculto');
  socket.emit('pedirUsuarios');
});
document.getElementById('btnCerrarMod').addEventListener('click', () => modalMod.classList.add('oculto'));
modalMod.addEventListener('click', (e) => { if (e.target === modalMod) modalMod.classList.add('oculto'); });

// Cajones laterales en móvil
document.getElementById('btnMenuSalas').addEventListener('click', () => {
  document.body.classList.remove('drawer-gente');
  document.body.classList.toggle('drawer-salas');
});
document.getElementById('btnMenuGente').addEventListener('click', () => {
  document.body.classList.remove('drawer-salas');
  document.body.classList.toggle('drawer-gente');
});
velo.addEventListener('click', cerrarDrawers);
document.querySelectorAll('.cerrar-drawer').forEach(b => b.addEventListener('click', cerrarDrawers));
listaSalasEl.addEventListener('click', (e) => {
  if (e.target.closest('button') && !e.target.closest('.btn-borrar-sala')) cerrarDrawers();
});


// ================== CORREO DE RECUPERACIÓN ==================
function aplicarConfigCorreo() {
  document.body.classList.toggle('correo-activo', correoActivo);
  fijarModo(modoAcceso, true);
}
socket.on('configCuenta', (d) => { correoActivo = !!(d && d.recuperacion); aplicarConfigCorreo(); });

btnOlvide.addEventListener('click', () => fijarModo('recuperar'));
btnVolverLogin.addEventListener('click', () => fijarModo('login'));

btnRecuperar.addEventListener('click', async () => {
  const usuario = usuarioInput.value.trim();
  const email = emailInput.value.trim();
  if (!usuario || !email) { avisarAcceso('Escribe tu usuario y tu correo.'); return; }
  btnRecuperar.disabled = true;
  try {
    const r = await fetch('/api/cuenta/recuperar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario, email })
    });
    const d = await r.json().catch(() => ({}));
    avisarAcceso(r.ok ? d.mensaje : (d.error || 'No se pudo enviar. Inténtalo de nuevo.'), r.ok);
  } catch (e) {
    avisarAcceso('No se pudo conectar con el servidor.');
  }
  setTimeout(() => { btnRecuperar.disabled = false; }, 20000);
});

let temporizadorToast = null;
function mostrarToast(texto) {
  const t = document.getElementById('toast');
  t.textContent = texto;
  t.classList.remove('oculto');
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => t.classList.add('oculto'), 7000);
}

function pintarEstadoCorreo() {
  const el = document.getElementById('estadoCorreo');
  const d = estadoCorreoActual;
  if (!d || !d.email) el.textContent = 'Todavía no tienes un correo de recuperación. Sin él, si olvidas la contraseña tendrías que pedírsela al administrador.';
  else if (d.verificado) el.textContent = `✅ Correo confirmado: ${d.email}. Puedes cambiarlo escribiendo otro abajo.`;
  else el.textContent = `⏳ Pendiente de confirmar: ${d.email}. Abre el enlace que te enviamos (mira también el spam).`;
}

socket.on('estadoCorreo', (d) => {
  estadoCorreoActual = d;
  if (!modalCorreo.classList.contains('oculto')) pintarEstadoCorreo();
});

socket.on('correoGuardado', (d) => {
  document.getElementById('correoClaveInput').value = '';
  const texto = d.enviado
    ? '📧 Te hemos enviado un correo para confirmar tu dirección. Revisa también el spam.'
    : '⚠️ No hemos podido enviar el correo ahora mismo. Inténtalo más tarde desde "Correo de recuperación".';
  if (!modalCorreo.classList.contains('oculto')) {
    avisoCorreo.textContent = texto;
    avisoCorreo.classList.toggle('ok', !!d.enviado);
    pintarEstadoCorreo();
  } else {
    mostrarToast(texto);
  }
});

document.getElementById('btnCorreo').addEventListener('click', () => {
  pintarEstadoCorreo();
  avisoCorreo.textContent = '';
  document.getElementById('correoNuevoInput').value = '';
  document.getElementById('correoClaveInput').value = '';
  modalCorreo.classList.remove('oculto');
});
document.getElementById('btnCerrarCorreo').addEventListener('click', () => modalCorreo.classList.add('oculto'));
modalCorreo.addEventListener('click', (e) => { if (e.target === modalCorreo) modalCorreo.classList.add('oculto'); });

document.getElementById('btnGuardarCorreo').addEventListener('click', (e) => {
  const email = document.getElementById('correoNuevoInput').value.trim();
  const contrasena = document.getElementById('correoClaveInput').value;
  if (!email || !contrasena) { avisoCorreo.textContent = 'Escribe el correo y tu contraseña.'; avisoCorreo.classList.remove('ok'); return; }
  avisoCorreo.textContent = '';
  const boton = e.currentTarget;
  boton.disabled = true;
  setTimeout(() => { boton.disabled = false; }, 4000);
  socket.emit('guardarCorreo', { email, contrasena });
});
