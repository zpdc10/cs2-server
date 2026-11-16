// Small progressive enhancements (no framework).
(function () {
  'use strict';
  // Confirm dangerous actions.
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
  // Click-to-copy connect string.
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('.copy');
    if (!el || !navigator.clipboard) return;
    navigator.clipboard.writeText(el.textContent.trim()).then(function () {
      el.classList.add('copied');
      setTimeout(function () { el.classList.remove('copied'); }, 1200);
    });
  });
  // Scrim form: show the map picker only for single-map scrims.
  var format = document.getElementById('format');
  var mapField = document.getElementById('map-field');
  if (format && mapField) {
    var sync = function () { mapField.classList.toggle('hidden', format.value !== 'map'); };
    format.addEventListener('change', sync);
    sync();
  }
  // Coach fields follow the "coaches allowed" checkbox.
  var coaches = document.querySelector('input[type=checkbox][name=coaches]');
  if (coaches) {
    var syncCoaches = function () {
      document.querySelectorAll('.coach-field').forEach(function (f) { f.classList.toggle('hidden', !coaches.checked); });
    };
    coaches.addEventListener('change', syncCoaches);
    syncCoaches();
  }
  // Live status refresh on the home page.
  var card = document.querySelector('[data-refresh]');
  if (card) {
    var pretty = function (m) {
      if (!m) return '?';
      var s = String(m).replace(/^(de|cs|ar|wm)_/, '').replace(/_/g, ' ');
      return s.charAt(0).toUpperCase() + s.slice(1);
    };
    var set = function (k, v) { var el = card.querySelector('[data-k=' + k + ']'); if (el) el.textContent = v; };
    var tick = function () {
      fetch(card.getAttribute('data-refresh'), { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          var dot = card.querySelector('[data-k=dot]');
          if (dot) dot.className = 'dot ' + (s.online ? 'on' : 'off');
          set('name', s.online ? s.name : 'Server offline');
          set('map', s.online ? pretty(s.map) : '—');
          set('players', s.online ? s.players + '/' + s.maxPlayers : '—');
          set('mode', s.mode || '—');
        })
        .catch(function () {});
    };
    setInterval(tick, 15000);
  }
})();
