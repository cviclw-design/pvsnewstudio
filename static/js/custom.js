// static/js/custom.js — Global UI Interactivity Helpers

document.addEventListener('DOMContentLoaded', function () {
  // 1. Password visibility toggles
  document.querySelectorAll('[data-password-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.querySelector(btn.getAttribute('data-password-toggle'));
      if (!target) return;
      var isPwd = target.getAttribute('type') === 'password';
      target.setAttribute('type', isPwd ? 'text' : 'password');
      var icon = btn.querySelector('i');
      if (icon) {
        icon.className = isPwd ? 'bi bi-eye-slash' : 'bi bi-eye';
      }
      btn.setAttribute('aria-label', isPwd ? 'Hide password' : 'Show password');
    });
  });

  // 2. Live client-side table search filtering
  document.querySelectorAll('[data-table-filter]').forEach(function (input) {
    var tableSel = input.getAttribute('data-table-filter');
    var table = document.querySelector(tableSel);
    if (!table) return;
    var tbody = table.querySelector('tbody');
    if (!tbody) return;

    input.addEventListener('input', function () {
      var q = (input.value || '').trim().toLowerCase();
      var rows = tbody.querySelectorAll('tr');
      rows.forEach(function (tr) {
        var txt = (tr.textContent || '').toLowerCase();
        tr.style.display = !q || txt.indexOf(q) !== -1 ? '' : 'none';
      });
    });
  });

  // 3. Sortable table headers
  document.querySelectorAll('table th[data-sort]').forEach(function (th) {
    th.classList.add('pvc-sortable-th');
    th.setAttribute('title', 'Click to sort');
    th.addEventListener('click', function () {
      var table = th.closest('table');
      var tbody = table && table.querySelector('tbody');
      if (!tbody) return;
      var colIdx = Array.from(th.parentElement.children).indexOf(th);
      var type = th.getAttribute('data-sort') || 'text';
      var currentDir = th.getAttribute('data-sort-dir') === 'asc' ? 'desc' : 'asc';

      th.parentElement.querySelectorAll('th[data-sort]').forEach(function (other) {
        other.removeAttribute('data-sort-dir');
      });
      th.setAttribute('data-sort-dir', currentDir);

      var rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort(function (a, b) {
        var aTxt = (a.children[colIdx] && a.children[colIdx].textContent || '').trim();
        var bTxt = (b.children[colIdx] && b.children[colIdx].textContent || '').trim();
        if (type === 'num') {
          var aNum = parseFloat(aTxt.replace(/[^0-9.\-]/g, '')) || 0;
          var bNum = parseFloat(bTxt.replace(/[^0-9.\-]/g, '')) || 0;
          return currentDir === 'asc' ? aNum - bNum : bNum - aNum;
        }
        return currentDir === 'asc'
          ? aTxt.localeCompare(bTxt, undefined, { numeric: true, sensitivity: 'base' })
          : bTxt.localeCompare(aTxt, undefined, { numeric: true, sensitivity: 'base' });
      });

      rows.forEach(function (r) { tbody.appendChild(r); });
    });
  });

  // 4. Clickable table rows (e.g., Dashboard Recent Calculations -> open report)
  document.querySelectorAll('tr[data-row-href]').forEach(function (tr) {
    function navigate() {
      var href = tr.getAttribute('data-row-href');
      if (!href) return;
      try {
        var tok = sessionStorage.getItem('pvc_fallback_token') || '';
        if (tok && document.cookie.indexOf('pvc_ck=1') === -1) {
          var sep = href.indexOf('?') === -1 ? '?' : '&';
          href = href + sep + '_t=' + encodeURIComponent(tok);
        }
      } catch (e) {}
      window.location.href = href;
    }
    tr.addEventListener('click', navigate);
    tr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigate();
      }
    });
  });

  // 5. Subtle KPI count-up animation (respects reduced motion)
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) {
    document.querySelectorAll('[data-countup]').forEach(function (el) {
      var target = parseInt(el.getAttribute('data-countup'), 10);
      if (!Number.isFinite(target) || target <= 1) return;
      var duration = 360;
      var start = performance.now();
      function step(now) {
        var p = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = String(Math.round(target * eased));
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }
});