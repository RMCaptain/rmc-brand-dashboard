/**
 * Mobile nav — injects a hamburger toggle on phone widths.
 * Shared across every page (the nav markup is duplicated per-page, so doing
 * this in JS keeps one source of truth instead of editing eight <nav>s).
 * No-ops on desktop: the button is display:none above 640px (see style.css).
 */
(function () {
  function init() {
    const nav = document.querySelector('.rmc-nav');
    if (!nav || nav.dataset.mnav) return;
    const inner = nav.querySelector(':scope > div');
    const firstLink = nav.querySelector('.nav-link');
    const linkRow = firstLink ? firstLink.parentElement : null;
    if (!inner || !linkRow) return;
    nav.dataset.mnav = '1';
    linkRow.classList.add('nav-menu');

    const btn = document.createElement('button');
    btn.className = 'nav-hamburger';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle navigation menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span><span></span><span></span>';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const open = nav.classList.toggle('nav-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Sit at the far-right of the top bar, in the actions group.
    (inner.lastElementChild || inner).appendChild(btn);

    // Close on link tap or tap-outside.
    linkRow.addEventListener('click', function (e) {
      if (e.target.closest('a')) close();
    });
    document.addEventListener('click', function (e) {
      if (nav.classList.contains('nav-open') && !nav.contains(e.target)) close();
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
    function close() {
      nav.classList.remove('nav-open');
      btn.setAttribute('aria-expanded', 'false');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
