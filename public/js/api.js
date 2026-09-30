const API = {
  token: sessionStorage.getItem('admin_token') || null,
  async req(method, url, body, isForm) {
    const h = {};
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    let payload = body;
    if (body && !isForm) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(url, { method, headers: h, body: payload });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error(typeof data === 'string' ? data : data.error || ('HTTP ' + r.status));
    return data;
  },
  get(u) { return this.req('GET', u); },
  post(u, b) { return this.req('POST', u, b); },
  adminPost(u, b) { return this.req('POST', u, b); },
  upload(u, form) { return this.req('POST', u, form, true); },
  login(u, p) {
    return this.post('/api/admin/login', { username: u, password: p }).then((d) => {
      this.token = d.token; sessionStorage.setItem('admin_token', d.token);
    });
  },
  logout() { this.token = null; sessionStorage.removeItem('admin_token'); },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}
function fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; }
function fmtDT(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—'; }
