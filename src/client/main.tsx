import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

declare global {
  interface Window {
    __pageErrors: string[];
  }
}
// Collected for headless checks: a screenshot with an empty array means the page ran clean.
window.__pageErrors = [];
addEventListener("error", (e) => window.__pageErrors.push(String(e.error?.stack ?? e.message)));

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
