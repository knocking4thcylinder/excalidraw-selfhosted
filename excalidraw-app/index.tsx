import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Service worker registration intentionally removed (Workbox conflicts; see
// vite.config.mts comment). This means no offline-cached app shell — acceptable
// for this self-hosted deployment.
// import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
