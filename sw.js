const CACHE_NAME = "airescare-cache-v34";

// Los scripts de Firebase se cargan desde el servidor de Google
// (gstatic.com), no desde este mismo sitio — por eso hay que guardarlos
// aparte a propósito. Sin ellos guardados, sin internet la librería de
// Firebase nunca llega a cargar, y la app se queda pegada para siempre
// esperándola (nunca llega ni a mostrar el login de verdad ni los datos
// guardados).
const ASSETS_FIREBASE = [
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js"
];

const ASSETS_PROPIOS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./consejo-filtro.png",
  "./consejo-temp.png",
  "./consejo-mantenimiento.png",
  "./consejo-eco.png",
  "./ac-hero.png",
  "./ac-unit.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // El resto del sitio (archivos propios) se cachea junto, todo o
      // nada — si alguno falla es señal de un problema real.
      await cache.addAll(ASSETS_PROPIOS).catch(() => {});
      // Los scripts de Firebase se guardan APARTE, uno por uno: si alguno
      // fallara al guardarse (por ejemplo, por un problema pasajero de
      // CORS con el servidor de Google), no debe tumbar el guardado de
      // TODO lo demás — mejor guardar los que sí se puedan.
      await Promise.all(ASSETS_FIREBASE.map((url) => cache.add(url).catch(() => {})));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estrategia: primero red, y si falla (sin conexión), usa lo que haya en
// caché. Así siempre se ve la versión más reciente cuando hay internet, y
// la app sigue abriendo aunque no haya conexión.
// "cache: no-store": evita que el propio navegador (no solo este Service
// Worker) devuelva una copia intermedia guardada por su cuenta — así,
// cada vez que hay internet, se pide SIEMPRE la versión más nueva al
// servidor, sin atajos por el camino.
// Con conexiones "raras" (planes de datos que solo dejan pasar
// WhatsApp y bloquean todo lo demás en silencio, sin rechazar la
// conexión de una vez), el fetch de abajo puede quedarse esperando una
// respuesta que nunca llega — y como nunca "falla", tampoco cae nunca al
// catch que usa la copia guardada. Por eso se le pone un límite de
// tiempo: si a los 4 segundos no hay respuesta, se da por vencido y usa
// la caché de una vez, en vez de dejar la app cargando sin abrir.
function fetchConLimiteDeTiempo(request, milisegundos) {
  return new Promise((resolve, reject) => {
    const vencido = setTimeout(() => reject(new Error("tiempo de espera agotado")), milisegundos);
    fetch(request, { cache: "no-store" }).then(
      (respuesta) => {
        clearTimeout(vencido);
        resolve(respuesta);
      },
      (error) => {
        clearTimeout(vencido);
        reject(error);
      }
    );
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const esDelPropioSitio = event.request.url.startsWith(self.location.origin);
  const esScriptDeFirebase = ASSETS_FIREBASE.includes(event.request.url);
  if (!esDelPropioSitio && !esScriptDeFirebase) return;

  event.respondWith(
    fetchConLimiteDeTiempo(event.request, 4000)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(async () => {
        // Primero se busca una coincidencia exacta con lo que se pidió
        // (ignorando "?parámetros" en la URL, que no cambian qué archivo
        // es).
        const exacto = await caches.match(event.request, { ignoreSearch: true });
        if (exacto) return exacto;
        // Si de todos modos no hay coincidencia exacta y esto es abrir la
        // app (no pedir una imagen o un archivo suelto) — por ejemplo, en
        // iPhone, abrir la app "Agregada a pantalla de inicio" a veces
        // hace la petición con una URL que no es idéntica, letra por
        // letra, a la guardada — se usa la página principal guardada de
        // todos modos. Es mejor mostrar la app (aunque tenga que volver a
        // pedir esa URL exacta después) que una pantalla en blanco.
        if (event.request.mode === "navigate") {
          const indice = (await caches.match("./index.html")) || (await caches.match("./"));
          if (indice) return indice;
        }
        return new Response(
          "Sin conexión y todavía no hay una copia guardada de esto. Abre la app una vez con internet primero.",
          { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      })
  );
});

/* ---------------------------------------------------------
   Notificaciones push (Firebase Cloud Messaging)
   Se agrega en el mismo service worker que ya controla el sitio (en vez
   de un archivo separado), para evitar que dos service workers distintos
   compitan por controlar la misma página — eso puede hacer que las
   notificaciones no lleguen de forma confiable.
----------------------------------------------------------*/
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyClrv-TpgdZCdFVGYvBGSjEeBEXoxCM5_U",
  authDomain: "airescare-20bf4.firebaseapp.com",
  projectId: "airescare-20bf4",
  storageBucket: "airescare-20bf4.firebasestorage.app",
  messagingSenderId: "441921693356",
  appId: "1:441921693356:web:b1f8584ea98b729b3ce109"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const titulo = (payload.data && payload.data.title) || "AiresCare";
  const opciones = {
    body: (payload.data && payload.data.body) || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: (payload.data && payload.data.tag) || undefined
  };
  self.registration.showNotification(titulo, opciones);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const scopeUrl = self.registration.scope;
      for (const client of clientsArr) {
        if (client.url.startsWith(scopeUrl) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(scopeUrl);
      }
    })
  );
});
