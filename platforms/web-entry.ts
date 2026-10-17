import { beginStartupLoading, finishStartupLoading } from "../src/renderer/loading";

beginStartupLoading();

// Prism's CommonJS browser build checks this before its first import.
Object.assign(globalThis, { Prism: { manual: true } });

void import("./web").then(platform => platform.initializePlatform()).then(() => import("../src/renderer/main")).catch(error => {
  finishStartupLoading();
  console.error("Browser startup failed:", error);
  const message = document.createElement("pre"); message.textContent = String(error);
  document.getElementById("root")?.append(message);
});
