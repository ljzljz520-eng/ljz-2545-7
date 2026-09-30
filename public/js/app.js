const routes = [
  [/^\/?$/, homePage],
  [/^\/origin\/(.+)$/, originPage],
  [/^\/process\/(.+)$/, processPage],
  [/^\/products$/, productsPage],
  [/^\/product\/(\d+)$/, productPage],
  [/^\/batch\/(\d+)$/, batchPage],
  [/^\/compare$/, comparePage],
  [/^\/events$/, eventsPage],
  [/^\/event\/(\d+)$/, eventPage],
  [/^\/glossary$/, glossaryPage],
  [/^\/design$/, designPage],
  [/^\/admin\/?(.*)$/, adminPage],
];

async function router() {
  const hash = location.hash.slice(1) || '/';
  const section = '/' + (hash.split('/')[1] || '');
  document.querySelectorAll('.mainnav a').forEach((a) => {
    const href = a.getAttribute('href').slice(1);
    const on =
      (href === '/' && (hash === '/' || section === '/origin' || section === '/process')) ||
      (href === '/products' && (hash === '/products' || section === '/product' || section === '/batch')) ||
      (href !== '/' && href !== '/products' && (hash === href || hash.startsWith(href + '/')));
    a.classList.toggle('active', !!on);
  });

  const view = document.getElementById('view');
  view.innerHTML = '<div class="loading">烘焙中…</div>';
  for (const [re, handler] of routes) {
    const m = hash.match(re);
    if (m) {
      window.scrollTo(0, 0);
      try { await handler(view, ...m.slice(1)); }
      catch (e) { view.innerHTML = `<div class="callout bad">加载失败：${esc(e.message)}</div>`; }
      return;
    }
  }
  view.innerHTML = '<div class="callout bad">页面不存在</div>';
}
addEventListener('hashchange', router);
router();
