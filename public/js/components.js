const H = (strings, ...vals) =>
  strings.reduce((acc, s, i) => acc + s + (i < vals.length ? vals[i] : ''), '');

function card(inner, href) {
  return href ? `<a class="card link" href="${href}">${inner}</a>` : `<div class="card">${inner}</div>`;
}
function tags(list, cls = '') {
  return (list || []).map((t) => `<span class="tag ${cls}">${esc(t)}</span>`).join('');
}
function statusTag(status) {
  const map = {
    draft: '草稿', published: '已发布', withdrawn: '已撤回/下架',
    pending: '待验收', accepted: '已验收', rejected: '已拒收', needs_fix: '待修正',
    registered: '已确认', pending_confirmation: '待确认', cancelled: '已取消',
  };
  return `<span class="status-${esc(status)}">${map[status] || esc(status)}</span>`;
}
function kv(rows) {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}
function tzLabel(tz) {
  return { roast_start: '烘焙开始 Start', turning_point: '回温点 TP', first_crack: '一爆 FC', charge: '下豆 Charge' }[tz] || tz;
}
function backLink(hash) {
  return `<p class="meta">← <a href="${hash}">返回</a></p>`;
}
