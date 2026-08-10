// Script que corre GitHub Actions cada 30 minutos.
// Revisa TODOS los usuarios de AiresCare y manda notificaciones push
// (via Firebase Cloud Messaging) en tres momentos distintos:
//   1. El dia ANTERIOR al mantenimiento ("Mañana: ...")
//   2. El mismo dia del mantenimiento ("Hoy: ...")
//   3. Si el mantenimiento tiene hora puesta, 30 minutos antes de esa hora
//
// No necesita el plan de pago de Firebase (Blaze): usar el Admin SDK desde
// un script externo (como este, corrido por GitHub Actions) es gratis.

const admin = require("firebase-admin");

function cargarCredenciales() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error("Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT");
  }
  return JSON.parse(raw);
}

admin.initializeApp({
  credential: admin.credential.cert(cargarCredenciales()),
});

const db = admin.firestore();

// --- Hora actual en Ecuador (UTC-5), sin depender de la zona horaria del runner ---
function ahoraEcuador() {
  const ahoraUTC = new Date();
  return new Date(ahoraUTC.getTime() - 5 * 60 * 60 * 1000);
}

function isoDeFecha(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sumarDias(iso, dias) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return isoDeFecha(dt);
}

function fechaDMYaISO(dmy) {
  if (!dmy || dmy.indexOf("/") === -1) return "";
  const [d, m, y] = dmy.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Minutos transcurridos del dia (0-1439) para una hora "HH:MM"
function minutosDeHora(hora) {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

const FILTRO_FRECUENCIA_DIAS = 14; // debe coincidir con el mismo valor en index.html

function diasEntreISO(isoDesde, isoHasta) {
  const [y1, m1, d1] = isoDesde.split("-").map(Number);
  const [y2, m2, d2] = isoHasta.split("-").map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((t2 - t1) / 86400000);
}

/* ---------------------------------------------------------
   Panel de administración: arma un resumen de TODAS las cuentas
   registradas en AiresCare (el robot ya tiene acceso total como
   administrador) y lo guarda DENTRO de la propia cuenta admin, en
   usuarios/{ADMIN_UID}/admin/panel — así la app solo necesita leer
   sus propios datos para mostrarlo, sin reglas de Firestore especiales.

   Bloquear/desbloquear y eliminar cuentas ajenas tampoco lo hace la
   app directamente (nunca tiene permiso sobre los datos de otra
   cuenta) — deja una "solicitud" en usuarios/{ADMIN_UID}/admin/, y
   este mismo robot la ejecuta en su próxima corrida.
----------------------------------------------------------*/
const ADMIN_UID = "Vf0N4vay8VZIeLqKGARrfwclzy42";

async function procesarSolicitudesEliminacion() {
  try {
    const ref = db.collection("usuarios").doc(ADMIN_UID).collection("admin").doc("solicitudesEliminacion");
    const doc = await ref.get();
    const solicitudes = doc.exists ? (doc.data().value || []) : [];
    if (solicitudes.length === 0) return;

    const pendientes = [];
    for (const solicitud of solicitudes) {
      const { uid, nombre } = solicitud || {};
      if (!uid || uid === ADMIN_UID) continue; // nunca te borres a ti mismo por accidente
      try {
        let correo = "";
        try {
          const authUser = await admin.auth().getUser(uid);
          correo = authUser.email || "";
        } catch (e) {
          correo = "";
        }
        await db.recursiveDelete(db.collection("usuarios").doc(uid));
        try {
          await admin.auth().deleteUser(uid);
        } catch (e) {
          console.log(`  (no se pudo borrar de Authentication, puede que ya no existiera): ${e.message}`);
        }
        if (correo) {
          const registroRef = db.collection("sistema").doc("cuentasEliminadas");
          const registroDoc = await registroRef.get();
          const correosActuales = registroDoc.exists ? (registroDoc.data().correos || []) : [];
          if (!correosActuales.includes(correo)) {
            await registroRef.set({ correos: [...correosActuales, correo] });
          }
        }
        console.log(`Cuenta eliminada por completo: ${nombre || "(sin nombre)"} (${uid})`);
      } catch (e) {
        console.error(`No se pudo eliminar la cuenta ${uid}:`, e.message);
        pendientes.push(solicitud); // se reintenta en la proxima corrida
      }
    }
    await ref.set({ value: pendientes });
  } catch (e) {
    console.error("Error procesando solicitudes de eliminación:", e.message);
  }
}

async function procesarSolicitudesBloqueo() {
  try {
    const ref = db.collection("usuarios").doc(ADMIN_UID).collection("admin").doc("solicitudesBloqueo");
    const doc = await ref.get();
    const solicitudes = doc.exists ? (doc.data().value || []) : [];
    if (solicitudes.length === 0) return;

    const pendientes = [];
    for (const solicitud of solicitudes) {
      const { uid, bloquear, nombre } = solicitud || {};
      if (!uid || uid === ADMIN_UID) continue; // nunca te bloquees a ti mismo por accidente
      try {
        await admin.auth().updateUser(uid, { disabled: !!bloquear });
        console.log(`${bloquear ? "Bloqueada" : "Desbloqueada"} la cuenta: ${nombre || "(sin nombre)"} (${uid})`);
      } catch (e) {
        console.error(`No se pudo ${bloquear ? "bloquear" : "desbloquear"} la cuenta ${uid}:`, e.message);
        pendientes.push(solicitud); // se reintenta en la proxima corrida
      }
    }
    await ref.set({ value: pendientes });
  } catch (e) {
    console.error("Error procesando solicitudes de bloqueo:", e.message);
  }
}

/* ---------------------------------------------------------
   Portal de clientes: conecta las solicitudes de vinculación (cuando un
   cliente ingresa el código que le compartió su técnico) y mantiene
   actualizada la vista de solo lectura de cada cliente ya conectado.
----------------------------------------------------------*/
async function procesarSolicitudesVinculacion() {
  try {
    const usuariosSnap = await db.collection("usuarios").get();
    let totalVinculadas = 0;

    for (const doc of usuariosSnap.docs) {
      const ownerUid = doc.id;
      const solicitudesSnap = await db.collection("usuarios").doc(ownerUid).collection("solicitudesVinculacion").get();
      if (solicitudesSnap.empty) continue;

      const data = doc.data();
      let clientes = [];
      try {
        clientes = data.clientes ? JSON.parse(data.clientes) : [];
      } catch (e) {
        continue;
      }
      let perfilTecnico = {};
      try {
        perfilTecnico = data.perfil ? JSON.parse(data.perfil) : {};
      } catch (e) {
        perfilTecnico = {};
      }

      let clientesCambiaron = false;

      for (const solicitudDoc of solicitudesSnap.docs) {
        const clienteUid = solicitudDoc.id;
        const solicitud = solicitudDoc.data();
        const cliente = clientes.find((c) => c.codigoAcceso === solicitud.codigo);

        if (cliente) {
          cliente.clienteUid = clienteUid;
          clientesCambiaron = true;

          await db.collection("usuarios").doc(ownerUid).collection("clientesVinculados").doc(clienteUid).set({
            clienteId: cliente.id,
            creado: admin.firestore.FieldValue.serverTimestamp(),
          });

          await db.collection("usuarios").doc(clienteUid).set(
            {
              tipoCuenta: "cliente",
              vinculacionPendiente: false,
              vinculacionError: false,
              vinculadoA: {
                ownerUid,
                clienteId: cliente.id,
                negocioNombre: perfilTecnico.negocioNombre || "AiresCare",
              },
            },
            { merge: true }
          );

          await db.collection("usuarios").doc(clienteUid).collection("vistaCliente").doc("datos").set({
            negocioNombre: perfilTecnico.negocioNombre || "AiresCare",
            negocioLogo: perfilTecnico.negocioLogo || "",
            negocioTelefono: perfilTecnico.telefono || "",
            cliente: { nombre: cliente.nombre || "", telefono: cliente.telefono || "", direccion: cliente.direccion || "" },
            equipos: cliente.equipos || [],
            actualizadoEn: Date.now(),
          });

          await solicitudDoc.ref.delete();
          totalVinculadas++;
          console.log(`Cliente vinculado: ${cliente.nombre || clienteUid} -> cuenta de ${ownerUid}`);
        } else {
          // Codigo invalido o vencido. Si la solicitud ya lleva mas de una
          // hora esperando, se avisa el error y se descarta -- para no
          // dejar al cliente esperando para siempre por un codigo mal
          // escrito.
          const creadoMs = solicitud.creado && solicitud.creado.toMillis ? solicitud.creado.toMillis() : 0;
          if (creadoMs && Date.now() - creadoMs > 60 * 60 * 1000) {
            await db.collection("usuarios").doc(clienteUid).set(
              { vinculacionPendiente: false, vinculacionError: true },
              { merge: true }
            );
            await solicitudDoc.ref.delete();
            console.log(`Solicitud de vinculación descartada (código inválido): ${clienteUid}`);
          }
        }
      }

      if (clientesCambiaron) {
        await db.collection("usuarios").doc(ownerUid).update({ clientes: JSON.stringify(clientes) });
      }
    }

    if (totalVinculadas > 0) console.log(`Total de clientes vinculados en esta corrida: ${totalVinculadas}`);
  } catch (e) {
    console.error("Error procesando solicitudes de vinculación:", e.message);
  }
}

async function actualizarVistasClientes() {
  try {
    const usuariosSnap = await db.collection("usuarios").get();
    let actualizadas = 0;

    for (const doc of usuariosSnap.docs) {
      const ownerUid = doc.id;
      const data = doc.data();
      let clientes = [];
      try {
        clientes = data.clientes ? JSON.parse(data.clientes) : [];
      } catch (e) {
        continue;
      }
      const vinculados = clientes.filter((c) => c.clienteUid);
      if (vinculados.length === 0) continue;

      let perfilTecnico = {};
      try {
        perfilTecnico = data.perfil ? JSON.parse(data.perfil) : {};
      } catch (e) {
        perfilTecnico = {};
      }

      for (const cliente of vinculados) {
        try {
          await db.collection("usuarios").doc(cliente.clienteUid).collection("vistaCliente").doc("datos").set({
            negocioNombre: perfilTecnico.negocioNombre || "AiresCare",
            negocioLogo: perfilTecnico.negocioLogo || "",
            negocioTelefono: perfilTecnico.telefono || "",
            cliente: { nombre: cliente.nombre || "", telefono: cliente.telefono || "", direccion: cliente.direccion || "" },
            equipos: cliente.equipos || [],
            actualizadoEn: Date.now(),
          });
          actualizadas++;
        } catch (e) {
          console.error(`No se pudo actualizar la vista del cliente ${cliente.clienteUid}:`, e.message);
        }
      }
    }

    if (actualizadas > 0) console.log(`Vistas de clientes actualizadas: ${actualizadas}`);
  } catch (e) {
    console.error("Error actualizando vistas de clientes:", e.message);
  }
}

async function actualizarPanelAdmin() {
  try {
    const usuarios = await db.collection("usuarios").listDocuments();
    const cuentas = [];

    for (const usuarioRef of usuarios) {
      if (usuarioRef.id === ADMIN_UID) continue; // tu propia cuenta no cuenta

      const snap = await usuarioRef.get();
      if (!snap.exists) continue;
      const data = snap.data();

      let perfil = {};
      try {
        perfil = data.perfil ? JSON.parse(data.perfil) : {};
      } catch (e) {
        perfil = {};
      }

      let correo = "";
      let bloqueado = false;
      let fechaCreacionAuth = null;
      try {
        const authUser = await admin.auth().getUser(usuarioRef.id);
        correo = authUser.email || "";
        bloqueado = !!authUser.disabled;
        fechaCreacionAuth = authUser.metadata && authUser.metadata.creationTime
          ? new Date(authUser.metadata.creationTime).getTime()
          : null;
      } catch (e) {
        correo = "";
      }

      let ultimaConexion = null;
      try {
        const conexionDoc = await usuarioRef.collection("meta").doc("conexion").get();
        if (conexionDoc.exists && conexionDoc.data().ultima && conexionDoc.data().ultima.toMillis) {
          ultimaConexion = conexionDoc.data().ultima.toMillis();
        }
      } catch (e) {
        ultimaConexion = null;
      }

      cuentas.push({
        uid: usuarioRef.id,
        correo,
        bloqueado,
        tipoCuenta: data.tipoCuenta === "cliente" ? "cliente" : "negocio",
        vinculadoA: data.vinculadoA ? (data.vinculadoA.negocioNombre || "") : "",
        negocioNombre: perfil.negocioNombre || "",
        nombre: perfil.nombre || "",
        logo: perfil.negocioLogo || perfil.foto || "",
        fechaRegistro: fechaCreacionAuth,
        ultimaConexion,
      });
    }

    cuentas.sort((a, b) => (b.fechaRegistro || 0) - (a.fechaRegistro || 0));

    const panelRef = db.collection("usuarios").doc(ADMIN_UID).collection("admin").doc("panel");
    const panelAnteriorDoc = await panelRef.get();
    const panelAnterior = panelAnteriorDoc.exists ? panelAnteriorDoc.data() : null;
    const uidsConocidos = new Set(((panelAnterior && panelAnterior.cuentas) || []).map((c) => c.uid));
    const cuentasNuevas = panelAnterior ? cuentas.filter((c) => !uidsConocidos.has(c.uid)) : [];

    const resumen = {
      actualizadoEn: Date.now(),
      totalCuentas: cuentas.length,
      cuentas,
    };
    await panelRef.set(resumen);
    console.log(`Panel de administración actualizado: ${cuentas.length} cuenta(s).`);

    if (cuentasNuevas.length > 0) {
      const tokensSnap = await db.collection("usuarios").doc(ADMIN_UID).collection("tokens").get();
      const tokens = tokensSnap.docs.map((t) => t.id);
      if (tokens.length > 0) {
        for (const cuenta of cuentasNuevas) {
          try {
            await admin.messaging().sendEachForMulticast({
              tokens,
              data: {
                title: "Nueva cuenta registrada",
                body: `${cuenta.negocioNombre || cuenta.nombre || cuenta.correo || "Alguien"} se acaba de registrar.`,
                tag: `nueva_cuenta_${cuenta.uid}`,
                url: "./",
              },
            });
          } catch (e) {
            console.error("No se pudo notificar cuenta nueva:", e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error("No se pudo actualizar el panel de administración:", e.message);
  }
}

// Arma la lista de avisos (mantenimiento y filtro) para una lista de
// equipos. Se usa tanto para el tecnico (todos sus equipos) como para cada
// cliente vinculado (solo los equipos de ESE cliente).
function construirAvisos(equipos, ctx) {
  const { hoyISO, mananaISO, en5DiasISO, minutosAhora } = ctx;
  const avisos = [];
  equipos.forEach((eq) => {
    (eq.historial || []).forEach((h) => {
      if (h.realizado || !h.fecha) return;
      const iso = fechaDMYaISO(h.fecha);

      if (iso === en5DiasISO) {
        avisos.push({
          eq,
          clave: `${h.id}_${iso}_5dias`,
          titulo: `En 5 días: mantenimiento de ${eq.nombre}`,
          hora: h.hora,
        });
      }

      if (iso === mananaISO) {
        avisos.push({
          eq,
          clave: `${h.id}_${iso}_manana`,
          titulo: `Mañana: mantenimiento de ${eq.nombre}`,
          hora: h.hora,
        });
      }

      if (iso === hoyISO) {
        let dentroDe30Min = false;
        if (h.hora) {
          const minutosCita = minutosDeHora(h.hora);
          const diferencia = minutosCita - minutosAhora;
          if (diferencia >= 0 && diferencia <= 30) {
            dentroDe30Min = true;
            avisos.push({
              eq,
              clave: `${h.id}_${iso}_${h.hora}_30min`,
              titulo: `Tienes un mantenimiento en 30 minutos: ${eq.nombre}`,
              hora: h.hora,
            });
          }
        }
        if (!dentroDe30Min) {
          avisos.push({
            eq,
            clave: `${h.id}_${iso}_hoy`,
            titulo: `Hoy: mantenimiento de ${eq.nombre}`,
            hora: h.hora,
          });
        }
      }
    });

    if (eq.filtroLimpio) {
      const isoFiltro = fechaDMYaISO(eq.filtroLimpio);
      const diasFiltro = diasEntreISO(isoFiltro, hoyISO);
      if (diasFiltro === FILTRO_FRECUENCIA_DIAS - 1) {
        avisos.push({
          eq,
          clave: `${eq.id}_${isoFiltro}_filtro_manana`,
          titulo: `Mañana toca limpiar el filtro de ${eq.nombre}`,
          esFiltro: true,
          diasFiltro,
        });
      }
      if (diasFiltro >= FILTRO_FRECUENCIA_DIAS) {
        avisos.push({
          eq,
          clave: `${eq.id}_${isoFiltro}_filtro`,
          titulo: `Toca limpiar el filtro de ${eq.nombre}`,
          esFiltro: true,
          diasFiltro,
        });
      }
    }
  });
  return avisos;
}

// Manda los avisos y los guarda en la coleccion "notificaciones" de la
// cuenta indicada (tecnico o cliente vinculado), evitando repetir los que
// ya se mandaron antes.
async function enviarAvisos(uid, avisos) {
  if (avisos.length === 0) return 0;

  const tokensSnap = await db.collection("usuarios").doc(uid).collection("tokens").get();
  const tokens = tokensSnap.docs.map((t) => t.id);

  const notifRef = db.collection("usuarios").doc(uid).collection("notificaciones");
  const notifSnap = await notifRef.get();
  const registrados = new Map(notifSnap.docs.map((d) => [d.id, d.data()]));

  let enviadas = 0;
  for (const { eq, clave, titulo, esFiltro, diasFiltro, hora } of avisos) {
    const existente = registrados.get(clave);
    // Si ya se le mando el push con exito antes, no hay nada mas que hacer.
    if (existente && existente.pushEnviado) continue;

    const cuerpo = esFiltro
      ? (diasFiltro >= FILTRO_FRECUENCIA_DIAS
        ? `Han pasado ${diasFiltro} días desde la última limpieza${eq.cliente ? " · Cliente: " + eq.cliente : ""}`
        : `Se cumplen ${FILTRO_FRECUENCIA_DIAS} días desde la última limpieza${eq.cliente ? " · Cliente: " + eq.cliente : ""}`)
      : (eq.cliente
        ? `Cliente: ${eq.cliente}${eq.marca ? " · " + eq.marca : ""}${hora ? " · " + hora : ""}`
        : (eq.marca || "Revisa el detalle en la app"));

    // Ojo: sendEachForMulticast no lanza error si un token individual
    // esta vencido/invalido -- eso viene reportado dentro de la respuesta,
    // no como excepcion. Por eso se revisa successCount en vez de asumir
    // que "no hubo error" significa "se entrego".
    let pushEnviado = false;
    if (tokens.length > 0) {
      try {
        const respuesta = await admin.messaging().sendEachForMulticast({
          tokens,
          data: { title: titulo, body: cuerpo, tag: clave, url: "./" },
        });
        pushEnviado = respuesta.successCount > 0;
      } catch (e) {
        console.error(`Error enviando push a ${uid}:`, e.message);
      }
    }

    if (existente) {
      // Ya estaba guardada para verse en el historial de la app; solo
      // faltaba lograr entregar el push, asi que no se duplica el registro.
      if (pushEnviado) {
        try { await notifRef.doc(clave).update({ pushEnviado: true }); } catch (e) {}
      }
      continue;
    }

    try {
      await notifRef.doc(clave).set({
        titulo,
        cuerpo,
        equipoId: eq.id,
        creada: admin.firestore.FieldValue.serverTimestamp(),
        leida: false,
        pushEnviado,
      });
      enviadas++;
    } catch (e) {
      console.error(`Error guardando notificacion para ${uid}:`, e.message);
    }
  }
  return enviadas;
}

async function main() {
  const ahora = ahoraEcuador();
  const hoyISO = isoDeFecha(ahora);
  const mananaISO = sumarDias(hoyISO, 1);
  const en5DiasISO = sumarDias(hoyISO, 5);
  const minutosAhora = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
  const ctx = { hoyISO, mananaISO, en5DiasISO, minutosAhora };

  console.log(`Hora Ecuador: ${hoyISO} ${String(ahora.getUTCHours()).padStart(2,"0")}:${String(ahora.getUTCMinutes()).padStart(2,"0")}`);
  console.log(`Revisando mantenimientos para hoy (${hoyISO}) y mañana (${mananaISO})...`);

  const usuariosSnap = await db.collection("usuarios").get();
  console.log(`Usuarios encontrados: ${usuariosSnap.size}`);

  let totalEnviadas = 0;

  for (const doc of usuariosSnap.docs) {
    const uid = doc.id;
    const data = doc.data();
    if (!data.clientes && !data.equipos) continue;

    let clientes = [];
    let equipos;
    try {
      if (data.clientes) {
        // Formato nuevo: clientes con equipos adentro. Se aplana a una
        // lista simple de equipos (cada uno con los datos de su cliente
        // pegados), igual que hace la app en el navegador.
        clientes = JSON.parse(data.clientes);
        equipos = [];
        (clientes || []).forEach((cli) => {
          (cli.equipos || []).forEach((eq) => {
            equipos.push({
              ...eq,
              cliente: cli.nombre || "",
              telefono: cli.telefono || "",
              direccion: cli.direccion || "",
            });
          });
        });
      } else {
        // Formato viejo (cuentas que no han abierto la app desde la
        // actualización): equipos sueltos, cada uno con su cliente ya
        // pegado directamente.
        equipos = JSON.parse(data.equipos);
      }
    } catch (e) {
      console.warn(`No se pudo leer los equipos del usuario ${uid}`);
      continue;
    }

    // Avisos para el tecnico (todos sus equipos, de todos sus clientes)
    const avisosTecnico = construirAvisos(equipos, ctx);
    const enviadasTecnico = await enviarAvisos(uid, avisosTecnico);
    if (enviadasTecnico > 0) {
      totalEnviadas += enviadasTecnico;
      console.log(`Enviadas ${enviadasTecnico} notificacion(es) al tecnico ${uid}`);
    }

    // Avisos para cada CLIENTE vinculado (solo sus propios equipos)
    let perfilTecnico = {};
    try { perfilTecnico = data.perfil ? JSON.parse(data.perfil) : {}; } catch (e) { perfilTecnico = {}; }

    for (const cli of clientes) {
      if (!cli.clienteUid) continue;
      const avisosCliente = construirAvisos(cli.equipos || [], ctx);
      const enviadasCliente = await enviarAvisos(cli.clienteUid, avisosCliente);
      if (enviadasCliente > 0) {
        totalEnviadas += enviadasCliente;
        console.log(`Enviadas ${enviadasCliente} notificacion(es) al cliente ${cli.nombre} (${cli.clienteUid})`);
      }
    }
  }

  console.log(`Listo. Notificaciones enviadas: ${totalEnviadas}`);

  // Panel de administración: primero se procesan las solicitudes
  // pendientes (bloquear/eliminar), y AL FINAL se arma el resumen — así
  // el panel ya refleja los cambios de esta misma corrida.
  await procesarSolicitudesBloqueo();
  await procesarSolicitudesEliminacion();
  await actualizarPanelAdmin();

  // Portal de clientes: primero se conectan las solicitudes nuevas, y
  // despues se actualiza la vista de TODOS los clientes ya vinculados
  // (para que reflejen cualquier cambio reciente hecho por el tecnico).
  await procesarSolicitudesVinculacion();
  await actualizarVistasClientes();
}

main().catch((err) => {
  console.error("Error general:", err);
  process.exit(1);
});
