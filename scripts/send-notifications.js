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

async function main() {
  const ahora = ahoraEcuador();
  const hoyISO = isoDeFecha(ahora);
  const mananaISO = sumarDias(hoyISO, 1);
  const minutosAhora = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();

  console.log(`Hora Ecuador: ${hoyISO} ${String(ahora.getUTCHours()).padStart(2,"0")}:${String(ahora.getUTCMinutes()).padStart(2,"0")}`);
  console.log(`Revisando mantenimientos para hoy (${hoyISO}) y mañana (${mananaISO})...`);

  const usuariosSnap = await db.collection("usuarios").get();
  console.log(`Usuarios encontrados: ${usuariosSnap.size}`);

  let totalEnviadas = 0;

  for (const doc of usuariosSnap.docs) {
    const uid = doc.id;
    const data = doc.data();
    if (!data.equipos) continue;

    let equipos;
    try {
      equipos = JSON.parse(data.equipos);
    } catch (e) {
      console.warn(`No se pudo leer equipos del usuario ${uid}`);
      continue;
    }

    // Armar la lista de avisos que le tocan a este usuario en esta corrida
    const avisos = [];
    equipos.forEach((eq) => {
      // Revisamos cada registro PENDIENTE del historial (ahí es donde vive
      // la fecha y la hora real de cada mantenimiento programado), no solo
      // el resumen "proximo" del equipo.
      (eq.historial || []).forEach((h) => {
        if (h.realizado || !h.fecha) return;
        const iso = fechaDMYaISO(h.fecha);

        if (iso === mananaISO) {
          avisos.push({
            eq,
            clave: `${h.id}_${iso}_manana`,
            titulo: `Mañana: mantenimiento de ${eq.nombre}`,
            hora: h.hora,
          });
        }

        if (iso === hoyISO) {
          // Si tiene hora puesta y ya estamos dentro de los 30 minutos previos,
          // mandamos SOLO el aviso de "30 minutos" (mas especifico) y nos
          // saltamos el de "Hoy" para no repetir el mismo aviso dos veces.
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

      // Aviso de filtro sucio (independiente de si hay mantenimiento programado)
      if (eq.filtroLimpio) {
        const isoFiltro = fechaDMYaISO(eq.filtroLimpio);
        const diasFiltro = diasEntreISO(isoFiltro, hoyISO);
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
    if (avisos.length === 0) continue;

    // Tokens de notificacion push registrados por este usuario
    const tokensSnap = await db.collection("usuarios").doc(uid).collection("tokens").get();
    const tokens = tokensSnap.docs.map((t) => t.id);

    // Notificaciones ya registradas antes, para no repetir el mismo aviso
    // (esta misma coleccion es la que la app muestra en la campanita)
    const notifSnap = await db.collection("usuarios").doc(uid).collection("notificaciones").get();
    const yaNotificado = new Set(notifSnap.docs.map((d) => d.id));

    for (const { eq, clave, titulo, esFiltro, diasFiltro, hora } of avisos) {
      if (yaNotificado.has(clave)) continue;

      const cuerpo = esFiltro
        ? `Han pasado ${diasFiltro} días desde la última limpieza${eq.cliente ? " · Cliente: " + eq.cliente : ""}`
        : (eq.cliente
          ? `Cliente: ${eq.cliente}${eq.marca ? " · " + eq.marca : ""}${hora ? " · " + hora : ""}`
          : (eq.marca || "Revisa el detalle en la app"));

      if (tokens.length > 0) {
        try {
          await admin.messaging().sendEachForMulticast({
            tokens,
            // Solo "data" (sin "notification"): asi el navegador NO la muestra
            // el solo, y evitamos que salga duplicada junto con la que
            // mostramos nosotros mismos en sw.js.
            data: { title: titulo, body: cuerpo, tag: clave, url: "./" },
          });
          console.log(`Push enviado a ${uid}: ${titulo}`);
        } catch (e) {
          console.error(`Error enviando push a ${uid}:`, e.message);
        }
      }

      try {
        await db.collection("usuarios").doc(uid).collection("notificaciones").doc(clave).set({
          titulo,
          cuerpo,
          equipoId: eq.id,
          creada: admin.firestore.FieldValue.serverTimestamp(),
          leida: false,
        });
        totalEnviadas++;
      } catch (e) {
        console.error(`Error guardando notificacion para ${uid}:`, e.message);
      }
    }
  }

  console.log(`Listo. Notificaciones enviadas: ${totalEnviadas}`);
}

main().catch((err) => {
  console.error("Error general:", err);
  process.exit(1);
});
