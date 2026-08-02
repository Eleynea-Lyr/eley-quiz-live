import { useEffect } from "react";
import Head from "next/head";
import "../lib/responsive-tokens.css";

export default function MyApp({ Component, pageProps }) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const host = window.location.hostname;
    const isLocalhost =
      host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    // Secure context requis pour une vraie install PWA (pas d'IP type 192.168.x.x).
    const isSecure =
      window.isSecureContext || isLocalhost;
    const isProd = process.env.NODE_ENV === "production";

    // Install standalone = SW actif. En `next dev` on laisse le SW OFF (HMR).
    // En prod (Vercel) ou `npm start` local → SW ON.
    if (isProd && isSecure) {
      const register = () => {
        navigator.serviceWorker
          .register("/sw.js?v=3")
          .catch((err) =>
            console.error("[PWA] Service worker registration failed:", err)
          );
      };
      if (document.readyState === "complete") {
        register();
      } else {
        window.addEventListener("load", register);
        return () => window.removeEventListener("load", register);
      }
    } else {
      // Dev / contexte non sécurisé : retirer un éventuel vieux SW
      navigator.serviceWorker.getRegistrations?.().then((regs) => {
        regs.forEach((reg) => reg.unregister());
      }).catch(() => {});
      if (typeof caches !== "undefined" && caches.keys) {
        caches.keys()
          .then((keys) => keys.forEach((k) => caches.delete(k)))
          .catch(() => {});
      }
    }
  }, []);

  return (
    <>
      <Head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
