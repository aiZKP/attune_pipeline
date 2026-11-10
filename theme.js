// Apply the viewer's saved theme before first paint (a separate file so the CSP needs no inline script).
(function () {
  try {
    var t = localStorage.getItem("attune.theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* storage unavailable: follow the OS */ }
})();
