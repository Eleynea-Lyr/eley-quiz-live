import { useEffect } from "react";

export default function MyApp({ Component, pageProps }) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const isProd = process.env.NODE_ENV === "production";

    if (isProd) {
      // En production uniquement : activer la PWA (cache hors-ligne / installable).
      const register = () => {
        navigator.serviceWorker
          .register("/sw.js")
          .catch((err) => console.error("[PWA] Service worker registration failed:", err));
      };
      if (document.readyState === "complete") {
        register();
      } else {
        window.addEventListener("load", register);
        return () => window.removeEventListener("load", register);
      }
    } else {
      // En développement : NE PAS utiliser de service worker (évite tout cache
      // parasite avec le hot-reload). On nettoie aussi un éventuel SW déjà
      // enregistré lors d'une session précédente, ainsi que ses caches.
      navigator.serviceWorker.getRegistrations?.().then((regs) => {
        regs.forEach((reg) => reg.unregister());
      }).catch(() => {});
      if (typeof caches !== "undefined" && caches.keys) {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
      }
    }
  }, []);

  return <Component {...pageProps} />;
}
