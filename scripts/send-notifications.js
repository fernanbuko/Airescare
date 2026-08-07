// Script que corre GitHub Actions una vez al dia.
// Revisa TODOS los usuarios de AiresCare, busca equipos con mantenimiento
// programado para hoy o mañana (hora de Ecuador, UTC-5), y les manda una
// notificacion push a traves de Firebase Cloud Messaging.
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

// --- Fecha de "hoy" en Ecuador (UTC-5), sin depender de la zona horaria del runner ---
function hoyEcuadorISO() {
  const ahoraUTC = new Date();
  const ecuador = new Date(ahoraUTC.getTime() - 5 * 60 * 60 * 1000);
  const y = ecuador.getUTCFullYear();
  const m = String(ecuador.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ecuador.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sumarDias(iso, dias) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function fechaDMYaISO(dmy) {
  if (!dmy || dmy.indexOf("/") === -1) return "";
  const [d, m, y] = dmy.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

async function main() {
  const hoyISO = hoyEcuadorISO();
  const mananaISO = sumarDias(hoyISO, 1);
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

    // Equipos con mantenimiento pendiente para hoy o mañana
    const pendientesHoyManana = [];
    equipos.forEach((eq) => {
      if (!eq.proximo) return;
      const iso = fechaDMYaISO(eq.proximo);
      if (iso === hoyISO || iso === mananaISO) {
        pendientesHoyManana.push({ eq, iso, esHoy: iso === hoyISO });
      }
    });
    if (pendientesHoyManana.length === 0) continue;

    // Tokens de notificacion push registrados por este usuario
    const tokensSnap = await db.collection("usuarios").doc(uid).collection("tokens").get();
    const tokens = tokensSnap.docs.map((t) => t.id);
    if (tokens.length === 0) continue;

    // Registro de lo ya notificado, para no repetir el mismo aviso cada dia
    const logRef = db.collection("usuarios").doc(uid).collection("notifLog").doc("log");
    const logSnap = await logRef.get();
    const yaNotificado = logSnap.exists ? (logSnap.data().claves || []) : [];
    const nuevasClaves = [];

    for (const { eq, iso, esHoy } of pendientesHoyManana) {
      const clave = `${eq.id}_${iso}`;
      if (yaNotificado.includes(clave)) continue;

      const titulo = `${esHoy ? "Hoy" : "Mañana"}: mantenimiento de ${eq.nombre}`;
      const cuerpo = eq.cliente
        ? `Cliente: ${eq.cliente}${eq.marca ? " · " + eq.marca : ""}`
        : (eq.marca || "Revisa el detalle en la app");

      try {
        await admin.messaging().sendEachForMulticast({
          tokens,
          notification: { title: titulo, body: cuerpo },
          data: { tag: clave, url: "./" },
        });
        totalEnviadas++;
        nuevasClaves.push(clave);
        console.log(`Enviado a ${uid}: ${titulo}`);
      } catch (e) {
        console.error(`Error enviando a ${uid}:`, e.message);
      }
    }

    if (nuevasClaves.length > 0) {
      await logRef.set(
        { claves: admin.firestore.FieldValue.arrayUnion(...nuevasClaves) },
        { merge: true }
      );
    }
  }

  console.log(`Listo. Notificaciones enviadas: ${totalEnviadas}`);
}

main().catch((err) => {
  console.error("Error general:", err);
  process.exit(1);
});
