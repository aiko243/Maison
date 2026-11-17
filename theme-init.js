// Applique le thème choisi avant l'affichage, pour éviter un flash blanc en mode sombre.
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* stockage indisponible : on suit le téléphone */ }
})();
