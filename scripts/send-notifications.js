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
      if (!eq.proximo) return;
      const iso = fechaDMYaISO(eq.proximo);

      if (iso === mananaISO) {
        avisos.push({
          eq,
          clave: `${eq.id}_${iso}_manana`,
          titulo: `Mañana: mantenimiento de ${eq.nombre}`,
        });
      }

      if (iso === hoyISO) {
        avisos.push({
          eq,
          clave: `${eq.id}_${iso}_hoy`,
          titulo: `Hoy: mantenimiento de ${eq.nombre}`,
        });

        // Recordatorio 30 minutos antes, solo si tiene hora puesta
        if (eq.hora) {
          const minutosCita = minutosDeHora(eq.hora);
          const diferencia = minutosCita - minutosAhora;
          if (diferencia >= 0 && diferencia <= 30) {
            avisos.push({
              eq,
              clave: `${eq.id}_${iso}_${eq.hora}_30min`,
              titulo: `En 30 minutos: mantenimiento de ${eq.nombre}`,
            });
          }
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

    for (const { eq, clave, titulo } of avisos) {
      if (yaNotificado.has(clave)) continue;

      const cuerpo = eq.cliente
        ? `Cliente: ${eq.cliente}${eq.marca ? " · " + eq.marca : ""}${eq.hora ? " · " + eq.hora : ""}`
        : (eq.marca || "Revisa el detalle en la app");

      if (tokens.length > 0) {
        try {
          await admin.messaging().sendEachForMulticast({
            tokens,
            notification: { title: titulo, body: cuerpo },
            data: { tag: clave, url: "./" },
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
