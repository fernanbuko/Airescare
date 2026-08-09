// Script liviano que SOLO conecta las solicitudes de vinculación de
// clientes (cuando alguien ingresa el código que le compartió su técnico).
// Se corre por separado del script de notificaciones (send-notifications.js)
// y con mucha más frecuencia (cada 1-2 minutos en vez de cada 30), para que
// el paso de "vincular mi cuenta" se sienta casi instantáneo.

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

async function procesarSolicitudesVinculacion() {
  const usuariosSnap = await db.collection("usuarios").get();
  let totalVinculadas = 0;
  let totalRevisadas = 0;

  for (const doc of usuariosSnap.docs) {
    const ownerUid = doc.id;
    const solicitudesSnap = await db.collection("usuarios").doc(ownerUid).collection("solicitudesVinculacion").get();
    if (solicitudesSnap.empty) continue;
    totalRevisadas += solicitudesSnap.size;

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
          cliente: { nombre: cliente.nombre || "", telefono: cliente.telefono || "", direccion: cliente.direccion || "" },
          equipos: cliente.equipos || [],
          actualizadoEn: Date.now(),
        });

        await solicitudDoc.ref.delete();
        totalVinculadas++;
        console.log(`Cliente vinculado: ${cliente.nombre || clienteUid} -> cuenta de ${ownerUid}`);
      } else {
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

  console.log(`Solicitudes revisadas: ${totalRevisadas}. Vinculadas: ${totalVinculadas}.`);
}

procesarSolicitudesVinculacion().catch((err) => {
  console.error("Error general:", err);
  process.exit(1);
});
