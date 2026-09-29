// Applies the saved theme before the app renders, so the page never flashes the wrong one
// (a file, not an inline script: the CSP allows only same-origin scripts).
try {
  var mode = localStorage.getItem("rowrow.theme") || "dark";
  var dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
} catch {
  document.documentElement.classList.add("dark");
}
