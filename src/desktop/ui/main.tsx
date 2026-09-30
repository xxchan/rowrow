import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

// The app's pages follow the system's appearance, as a Mac app does.
const media = matchMedia("(prefers-color-scheme: dark)");
const apply = (): void => {
  document.documentElement.classList.toggle("dark", media.matches);
};
media.addEventListener("change", apply);
apply();

const root = document.getElementById("root");
if (root === null) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
