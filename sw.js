// Ledger service worker: shows Web Push notifications for reminders and opens the right reminder when
// one is tapped. No caching and no fetch handler: the app always loads fresh from the network.
// Offline changes (entries and swipe-deletes) are queued by the app; on browsers with Background Sync
// (Chrome / Android) the "sync" event below tells an open app to send them as soon as the connection is
// back. iOS has no Background Sync: there the app sends the queue when it is opened or comes back online.
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch { d = { body: event.data ? event.data.text() : "" }; }
  // iOS revokes push permission if a push doesn't show a notification, so one is always shown.
  event.waitUntil(self.registration.showNotification(d.title || "Ledger", {
    body: d.body || "You have a reminder.",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: "icon-512.png",
    badge: "icon-512.png",
    timestamp: Date.now(),
    data: { url: d.url || "./?tab=reminders", reminderId: d.reminderId ?? null },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || "./?tab=reminders", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (win) {
      // app already open: bring it forward and let it open the reminder in place
      try { await win.focus(); } catch { /* focus not allowed: the message still opens it */ }
      win.postMessage({ type: "open-reminder", id: data.reminderId, url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener("sync", (event) => {
  if (event.tag !== "ledger-queue") return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: "flush-queue" });
  })());
});
