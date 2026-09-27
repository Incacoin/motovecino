self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

// Aviso de viaje nuevo al chofer (ver backend/push.js). El mensaje llega sin
// contenido: el detalle del viaje lo ve al abrir la app. Si la app del chofer
// ya está en pantalla no se muestra (ahí ya le sonó la solicitud).
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = wins.some((c) => c.visibilityState === "visible" && new URL(c.url).pathname.endsWith("/chofer.html"));
    if (visible) return;
    // La app del chofer deja guardado si es taxi o mototaxi (ver chofer.html).
    let tipo = "moto";
    try {
      const saved = await (await caches.open("mv-chofer")).match("/__tipo");
      if (saved) tipo = await saved.text();
    } catch (e) {}
    const title = tipo === "taxi" ? "🚕 Nuevo viaje de taxi cerca de ti" : "🛵 Nuevo viaje cerca de ti";
    await self.registration.showNotification(title, {
      body: "Toca para verlo y aceptarlo antes que otro chofer.",
      icon: "icons/icon-192.png?v=2",
      badge: "icons/icon-192.png?v=2",
      tag: "nuevo-viaje",
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 120, 300, 120, 300],
      data: { url: "/chofer.html" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/chofer.html";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find((c) => new URL(c.url).pathname.endsWith("/chofer.html"));
    if (open) return open.focus();
    return self.clients.openWindow(target);
  })());
});
