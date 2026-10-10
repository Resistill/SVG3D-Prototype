// 协作面板（docs/PLAN2.md 4.7）：工程模式下的选中面板、工程栏（分数、最差物体、误差热力 / 源模型叠加）、提议与留言。
// 有接口（bin/serve.mjs 的 /api/*）时调用工具的命令表——与命令行、MCP 是同一套函数，人和 AI 看到的是同一份内容；
// 没有接口（静态托管）时只用前端的编译结果与静态文件（project.json、score.json），提议与留言不可用
const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v) => v.map((x) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(2).replace(/\.?0+$/, '')).join(', ');
const MAX_INSPECT = 8; // 面板里逐个展开的物体数；更多的只列名字

// ── 接口 ──
export async function detectApi() {
  try { const r = await fetch('api/ping', { cache: 'no-store' }); return r.ok && (await r.json()).ok === true; } catch { return false; }
}
async function call(method, url, body) {
  const r = await fetch(url, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

// 与 tools/agent.mjs 的 inspect 同样的内容，只用前端的编译结果（没有接口、或有没保存的修改时用；也是有接口时的“先显示”）
const indexOf = new WeakMap();
function inspectLocal(r, paths, { files, rootFile, score }) {
  if (!indexOf.has(r)) indexOf.set(r, new Map(r.nodes.map((n) => [n.path, n])));
  const byPath = indexOf.get(r);
  const ctr = (b) => b && [0, 1, 2].map((k) => +((b.min[k] + b.max[k]) / 2).toFixed(4));
  const ext = (b) => b && [0, 1, 2].map((k) => +(b.max[k] - b.min[k]).toFixed(4));
  return paths.map((path) => {
    const n = byPath.get(path);
    if (!n) return { path, error: '没有这个物体（编译结果里找不到）' };
    const inside = (x) => x === path || x.startsWith(path + '.');
    const groups = [];
    for (let p = path; p.includes('.'); ) {
      p = p.slice(0, p.lastIndexOf('.'));
      const g = byPath.get(p);
      if (g && (g.kind === 'repeat' || g.kind === 'rotate' || g.kind === 'mirror' || /→/.test(g.kind))) groups.push({ path: p, kind: g.kind, members: r.nodes.filter((m) => m.path.startsWith(p + '.') && m.depth === g.depth + 1).length });
    }
    const sameType = n.types ? r.nodes.filter((m) => m.types?.[0] === n.types[0]).map((m) => m.path) : null;
    const text = files.get(n.file ?? rootFile);
    return {
      path, kind: n.kind, file: n.file ?? rootFile, line: n.line, statement: text?.split('\n')[n.line - 1]?.trim() ?? null, types: n.types, of: n.of, tags: n.tags, concepts: n.concepts, meta: n.meta,
      center: ctr(n.tight ?? n.box), size: ext(n.tight ?? n.box),
      facts: r.facts.filter((f) => inside(f.a) !== inside(f.b) && (inside(f.a) || inside(f.b))).map((f) => ({ rel: f.rel, a: f.a, b: f.b, gap: f.gap })).slice(0, 40),
      groups, sameType: sameType && { type: n.types[0], count: sameType.length, examples: sameType.slice(0, 8) },
      score: score?.objects?.filter((o) => inside(o.path)) ?? null,
    };
  });
}

const GROUP_NAME = { repeat: '阵列', rotate: '旋转', mirror: '镜像' };
const groupName = (k) => GROUP_NAME[k] ?? (/→/.test(k) ? '派生' : k);

// ctx：app.js 提供的状态与动作
//   project（{dir: 'work/x/', apiDir: 'work/x', cfg, unit, score}，没有工程时为 null）、api（有没有接口）
//   last()（最近的编译结果）、files / dirty / rootFile()、selected()、select(paths, opts)、highlightOnly(paths, opts)、locate(path)、openFile(file, line)
//   refreshFromDisk()、status(消息)
export function createCollab(ctx) {
  const P = () => ctx.project;
  const run = (cmd, args = {}) => call('POST', 'api/run', { dir: P().apiDir, cmd, args });
  const inspectEl = $('#inspect'), propEl = $('#proposals'), detEl = $('#pdetail'), inboxEl = $('#inbox');
  // inspect 返回的 file 相对工程目录；前端的文件表按服务根目录
  const fileKey = (f) => (!f ? ctx.rootFile() : ctx.files.has(f) || !P() ? f : P().dir + f);
  const short = (f) => (P() && f.startsWith(P().dir) ? f.slice(P().dir.length) : f);
  const chip = (p, cls = '', extra = '') => `<span class="chip ${cls}" data-sel="${esc(p)}" ${extra}>${esc(p)}</span>`;

  // ── 选中面板 ──
  let inspectSeq = 0, shown = [];
  function inspect(paths) {
    shown = paths = paths ? [].concat(paths) : [];
    $('#sel-badge').textContent = paths.length || '';
    $('#note-sel').textContent = paths.length ? `附上选中的 ${paths.length} 个物体` : '没有选中物体';
    const seq = ++inspectSeq;
    if (!paths.length) { inspectEl.innerHTML = '<p class="empty">点击物体查看：所属阵列 / 镜像 / 类型、关系、来源、分数（Shift+点击多选）</p>'; return; }
    const r = ctx.last();
    if (r) renderInspect(inspectLocal(r, paths.slice(0, MAX_INSPECT), { files: ctx.files, rootFile: ctx.rootFile(), score: P()?.score }), paths, '前端编译结果');
    // 有接口、没有没保存的修改时，换成工具的 inspect（与 AI 读到的完全一样）
    if (ctx.api && P() && !ctx.dirty.size) {
      run('inspect', { paths: paths.slice(0, MAX_INSPECT) }).then((list) => { if (seq === inspectSeq) renderInspect(list, paths, 'inspect（与 AI 读到的相同）'); }).catch(() => { /* 保留前端的结果 */ });
    }
  }
  function renderInspect(list, all, from) {
    const more = all.slice(MAX_INSPECT);
    inspectEl.innerHTML = list.map(item).join('')
      + (more.length ? `<div class="ins"><div class="row"><span class="k">还有 ${more.length} 个</span>${more.slice(0, 60).map((p) => chip(p)).join('')}</div></div>` : '')
      + `<p class="empty">来自 ${esc(from)}${P()?.score ? '' : ' · 没有 score.json（还没评分）'}</p>`;
  }
  const row = (k, html) => `<div class="row"><span class="k">${k}</span>${html}</div>`;
  function item(x) {
    if (x.error) return `<div class="ins"><div class="ih"><span class="nm">${esc(x.path)}</span><span class="bad">${esc(x.error)}</span></div></div>`;
    const file = fileKey(x.file);
    let h = `<div class="ins"><div class="ih"><span class="nm" data-sel="${esc(x.path)}" data-focus="1" title="选中并对准视角">${esc(x.path)}</span><span class="kd">${esc(x.kind)}</span>${(x.tags ?? []).map((t) => `<span class="tg">#${esc(t)}</span>`).join('')}${(x.concepts ?? []).map((c) => `<span class="cc">${esc(c)}</span>`).join('')}`
      + `<span class="loc" data-file="${esc(file)}" data-line="${x.line ?? ''}" title="打开源码">${esc(short(file))}:${x.line ?? '?'}</span></div>`;
    if (x.statement) h += `<code class="stmt">${esc(x.statement)}</code>`;
    if (x.size) h += row('尺寸', `<span class="sc">${fmt(x.size)}</span><span class="gap">中心 ${fmt(x.center)}</span>`);
    if (x.groups?.length) h += row('所属', x.groups.map((g) => `<span class="chip grp" data-hl="${esc(JSON.stringify([g.path]))}" title="点击高亮整个${groupName(g.kind)}">${groupName(g.kind)} ${esc(g.path)} · ${g.members} 个</span>`).join(''));
    if (x.sameType) h += row('类型', `<span class="chip typ" data-type="${esc(x.sameType.type)}" title="点击高亮全部同类">${esc(x.types.join(' : '))} · ${x.sameType.count} 个</span>`);
    if (x.of) h += row('来源', `<span class="chip" data-hl="${esc(JSON.stringify([x.of]))}" title="副本 / 派生自它；点击高亮">${esc(x.of)}</span>`);
    const meta = Object.entries(x.meta ?? {});
    if (meta.length) h += row('元数据', meta.map(([k, v]) => `<span class="sc">~${esc(k)}=${esc(typeof v === 'string' ? v : JSON.stringify(v))}</span>`).join(' '));
    h += scoreRow(x.score);
    if (x.facts?.length) h += row('关系', `<ul class="rel">${x.facts.map((f) => `<li data-a="${esc(f.a)}" data-b="${esc(f.b)}" title="点击高亮两者"><span class="ref">${esc(f.a)}</span> <span class="kw">${esc(f.rel)}</span> <span class="ref">${esc(f.b)}</span> <span class="gap">gap ${f.gap}</span></li>`).join('')}</ul>`);
    return h + '</div>';
  }
  function scoreRow(list) {
    if (!list) return '';
    if (!list.length) return row('分数', '<span class="gap">score.json 里没有它（新加的物体，或分数过期了）</span>');
    const sum = (k) => list.reduce((s, o) => s + (o[k] ?? 0), 0);
    const r1 = (v) => +v.toFixed(1);
    let h = row('分数', `<span class="sc">${r1(sum('total'))} = 描述 ${r1(sum('stmt'))} + 网格 ${r1(sum('mesh'))} + 残差 ${r1(sum('rSrc') + sum('rRecon'))}</span>`
      + (list.length === 1 ? `<span class="gap">平均误差 ${list[0].meanErr} m · 最大 ${list[0].maxErr} m</span>` : ''));
    if (list.length > 1) {
      const top = [...list].sort((a, b) => b.total - a.total).slice(0, 5);
      h += row('', top.map((o) => `<span class="chip" data-hl="${esc(JSON.stringify([o.path]))}" title="平均误差 ${o.meanErr} m">${esc(o.path.split('.').slice(-2).join('.'))} ${r1(o.total)}</span>`).join(''));
    }
    const src = [...new Set(list.flatMap((o) => o.src ?? []))];
    if (src.length) h += row('源部件', `<span class="gap" title="${esc(src.join('\n'))}">${esc(src.slice(0, 3).join('、'))}${src.length > 3 ? ` 等 ${src.length} 个` : ''}</span>`);
    return h;
  }
  inspectEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-sel],[data-hl],[data-type],[data-a],[data-file]');
    if (!t) return;
    if (t.dataset.file) return ctx.openFile(t.dataset.file, +t.dataset.line);
    if (t.dataset.a) return ctx.highlightOnly([t.dataset.a, t.dataset.b]);
    if (t.dataset.hl) return ctx.highlightOnly(JSON.parse(t.dataset.hl));
    if (t.dataset.type) return ctx.highlightOnly(ctx.last().nodes.filter((m) => m.types?.[0] === t.dataset.type).map((m) => m.path));
    if (t.dataset.sel) { const n = ctx.locate(t.dataset.sel); ctx.select(t.dataset.sel, { line: n?.line, file: n?.file, focus: !!t.dataset.focus }); }
  });

  // ── 工程栏：分数、最差物体、视图模式 ──
  let stale = false;
  function renderBar() {
    const p = P();
    $('#projbar').hidden = !p;
    if (!p) return;
    $('#pname').textContent = p.apiDir;
    $('#pmeta').textContent = `${p.cfg.fidelity ?? 'detail'} · 1 单位 = ${p.unit} m`;
    const s = p.score;
    $('#pscore').innerHTML = s
      ? `S <span class="num">${s.S}</span> · 解释率 <span class="num">${(s.explain * 100).toFixed(1)}%</span> <span class="bar"><i style="width:${Math.max(0, Math.min(100, s.explain * 100)).toFixed(1)}%"></i></span>${stale ? ' <span class="badge" title="层文件改过了，分数还是上一次的">已过期</span>' : ''}`
      : '<span class="mute">还没有 score.json</span>';
    $('#pworst').innerHTML = s?.worst?.length ? '<span class="mute">最差</span>' + s.worst.slice(0, 5).map((w) => `<span class="chip" data-sel="${esc(w.path)}" title="代价 ${w.cost} · 平均误差 ${w.meanErr} m${w.mesh ? ' · 网格引用' : ''}">${esc(w.path.length > 28 ? '…' + w.path.slice(-27) : w.path)}</span>`).join('') : '';
    $('#rescore').hidden = !ctx.api;
    const vm = $('#viewmode');
    vm.querySelector('[value=heat]').disabled = !s;
    vm.querySelector('[value=overlay]').disabled = !p.cfg.source;
  }
  $('#pworst').addEventListener('click', (e) => {
    const c = e.target.closest('[data-sel]');
    if (!c) return;
    const n = ctx.locate(c.dataset.sel);
    ctx.select(c.dataset.sel, { line: n?.line, file: n?.file, focus: true });
  });
  function setScore(s, { fresh = false } = {}) {
    if (!P()) return;
    P().score = s;
    if (fresh) stale = false;
    renderBar();
    applyMode();
    inspect(shown);
  }
  let scoreTag = null;
  // score.json 是静态文件，没有接口也能读；有 ETag 时先 HEAD 比一下，没变就不重新下载
  async function loadScore() {
    if (!P()) return;
    const url = P().dir + 'score.json';
    try {
      const h = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!h.ok) { if (P().score) setScore(null); return; }
      const tag = h.headers.get('ETag');
      if (tag && tag === scoreTag && P().score) return;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return;
      scoreTag = r.headers.get('ETag');
      setScore(await r.json(), { fresh: true });
    } catch { /* 没有分数 */ }
  }
  $('#rescore').addEventListener('click', async (e) => {
    const b = e.target;
    b.disabled = true; b.textContent = '评分中…';
    try {
      const s = await run('score', { objects: true });
      scoreTag = null;
      setScore(s, { fresh: true });
      ctx.status(`评分完成：S ${s.S} · 解释率 ${(s.explain * 100).toFixed(1)}%`);
    } catch (err) { ctx.status(`评分失败：${err.message}`); } finally { b.disabled = false; b.textContent = '评分'; }
  });

  let overlayUrl = null;
  function applyMode() {
    const m = $('#viewmode').value, p = P(), s = p?.score;
    if (m === 'heat' && s) {
      const full = 4 * (s.consts?.delta ?? 0.05); // meanErr 与 δ 都按米
      ctx.viewer.setHeat(new Map(s.objects.map((o) => [o.path, o.meanErr / full])));
      $('#heatmax').textContent = `4δ = ${+full.toFixed(4)} m`;
    } else if (ctx.viewer.heat) ctx.viewer.setHeat(null);
    $('#heatlegend').hidden = !(m === 'heat' && s);
    const url = m === 'overlay' && p?.cfg.source ? new URL(p.cfg.source, new URL(p.dir, location.href)).href : null;
    if (url !== overlayUrl) {
      overlayUrl = url;
      if (url) ctx.status('加载源模型…');
      ctx.viewer.setOverlay(url).then(() => { if (url) ctx.status('源模型叠加：蓝色半透明是源模型，实体是重建结果'); }).catch((err) => ctx.status(`源模型加载失败：${err.message}`));
    }
  }
  $('#viewmode').addEventListener('change', (e) => { e.target.blur(); applyMode(); });

  // ── 选中状态写进 state/selection.json（AI 用 inspect --selection、render --focus=selection 读） ──
  let selTimer = 0;
  function saveSelection(paths) {
    if (!ctx.api || !P()) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(() => call('PUT', `api/selection?dir=${encodeURIComponent(P().apiDir)}`, { paths, camera: ctx.viewer.cameraState() }).catch((e) => ctx.status(`选中状态没写进去：${e.message}`)), 250);
  }
  async function restoreSelection() {
    if (!ctx.api || !P()) return;
    try {
      const s = await call('GET', `api/selection?dir=${encodeURIComponent(P().apiDir)}`);
      const known = new Set(ctx.last()?.nodes.map((n) => n.path));
      const paths = (s.paths ?? []).filter((p) => known.has(p));
      if (paths.length) ctx.select(paths, { silent: true });
    } catch { /* 没有选中状态 */ }
  }

  // ── 提议与留言 ──
  let props = [], openId = null, lastPreview = null;
  async function loadProposals() {
    if (!ctx.api || !P()) return;
    try { props = await run('proposals'); } catch (e) { propEl.innerHTML = `<p class="empty">读取提议失败：${esc(e.message)}</p>`; return; }
    if (openId && !props.some((p) => p.id === openId)) { openId = null; detEl.innerHTML = ''; }
    renderProposals();
  }
  function renderProposals() {
    $('#prop-badge').textContent = props.length || '';
    propEl.innerHTML = props.length ? props.map((p) => `<div class="prop ${p.id === openId ? 'on' : ''}" data-id="${esc(p.id)}" title="点击预览"><span class="pid">#${esc(p.id)}</span><span class="ply">${esc(p.layer)}</span><span class="pwhy" title="${esc(p.why)}">${esc(p.why || '（没写理由）')}</span><span class="pn">${p.lines} 行</span></div>`).join('')
      : '<p class="empty">没有待处理的提议（AI 用 propose 提交，或者 refine 生成）</p>';
  }
  async function preview(id) {
    const p = props.find((x) => x.id === id);
    if (!p) return;
    openId = id; lastPreview = null;
    renderProposals();
    detEl.innerHTML = '<div class="box">预览中：叠加编译并评分（第一次评分是全量的，大场景要十几秒）…</div>';
    const text = await fetch(`${P().dir}proposals/${encodeURIComponent(p.file)}`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    try {
      const pv = await run('preview', { id });
      if (openId !== id) return;
      lastPreview = pv;
      renderPreview(p, pv, text);
      // 高亮改动的物体（新增的物体只在接受之后才存在）
      const hl = [...pv.changed.map((x) => x.path), ...pv.removed.map((x) => x.path)];
      if (hl.length) ctx.highlightOnly(hl, { focus: true });
    } catch (e) {
      if (openId === id) detEl.innerHTML = `<div class="box"><div class="err">预览失败：${esc(e.message)}</div><pre>${esc(text)}</pre>${actions(false)}</div>`;
    }
  }
  const actions = (errors) => `<div class="acts"><button data-act="accept" ${errors ? 'data-force="1" title="会引入编译错误"' : ''}>${errors ? '仍然接受' : '接受'}</button><input id="reject-why" placeholder="否决理由（写进收件箱，AI 下次读到）"><button data-act="reject">否决</button></div>`;
  function renderPreview(p, pv, text) {
    const d = pv.delta, cls = d < 0 ? 'good' : d > 0 ? 'bad' : '';
    const list = (title, xs, f) => (xs.length ? `<div class="row"><span class="k">${title}</span>${xs.map(f).join('')}</div>` : '');
    detEl.innerHTML = `<div class="box">
      <div><span class="pid">#${esc(p.id)}</span> → <span class="ply">${esc(pv.layer)}</span> ${esc(pv.why)}</div>
      <div class="delta ${cls}">ΔS ${d > 0 ? '+' : ''}${d}<span class="gap">（${pv.before} → ${pv.after} · 解释率 ${(pv.explain * 100).toFixed(1)}% · δ = ${pv.delta_unit} m）</span></div>
      ${pv.errors.length ? `<div class="err">新的编译错误：<br>${pv.errors.map((e) => esc(`${e.file ?? ''} 第 ${e.line ?? '?'} 行：${e.message}`)).join('<br>')}</div>` : ''}
      ${list('改动', pv.changed, (x) => `<span class="chip" data-hl="${esc(JSON.stringify([x.path]))}" title="${x.before} → ${x.after}">${esc(x.path)} <b class="${x.delta < 0 ? 'good' : 'bad'}">${x.delta > 0 ? '+' : ''}${x.delta}</b></span>`)}
      ${list('新增', pv.added, (x) => `<span class="chip" title="代价 ${x.cost}（接受之后才出现在场景里）">${esc(x.path)}</span>`)}
      ${list('删除', pv.removed, (x) => `<span class="chip" data-hl="${esc(JSON.stringify([x.path]))}" title="代价 ${x.cost}">${esc(x.path)}</span>`)}
      <pre>${esc(text)}</pre>
      ${actions(pv.errors.length > 0)}
    </div>`;
  }
  propEl.addEventListener('click', (e) => { const r = e.target.closest('.prop'); if (r) preview(r.dataset.id); });
  detEl.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-hl]');
    if (c) return ctx.highlightOnly(JSON.parse(c.dataset.hl));
    const b = e.target.closest('[data-act]');
    if (!b || !openId) return;
    const id = openId;
    if (b.dataset.act === 'reject') {
      const why = $('#reject-why').value.trim();
      if (!why) { $('#reject-why').focus(); ctx.status('否决要写理由（AI 会读到）'); return; }
      try { await run('reject', { id, why }); ctx.status(`已否决提议 #${id}`); } catch (err) { ctx.status(`否决失败：${err.message}`); return; }
    } else {
      if (b.dataset.force && !confirm(`提议 #${id} 会引入编译错误，仍然接受？`)) return;
      b.disabled = true; b.textContent = '接受中…';
      try {
        const r = await run('accept', { id, ...(b.dataset.force ? { force: true } : {}) });
        stale = true; renderBar();
        await ctx.refreshFromDisk(); // 重新读取改过的层并编译（之后再报结果，不被编译的状态行盖掉）
        ctx.status(`已接受提议 #${id}：写进 ${r.layer}，ΔS ${r.delta > 0 ? '+' : ''}${r.delta}（score.json 没有重新评，点「评分」刷新）`);
      } catch (err) { ctx.status(`接受失败：${err.message}`); b.disabled = false; b.textContent = '接受'; return; }
    }
    openId = null; detEl.innerHTML = '';
    loadProposals(); loadInbox();
  });
  $('#prop-refresh').addEventListener('click', () => { loadProposals(); loadInbox(); });

  async function loadInbox() {
    if (!ctx.api || !P()) return;
    let xs = [];
    try { xs = await run('inbox'); } catch (e) { inboxEl.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    const when = (t) => { const d = new Date(t); return isNaN(d) ? '' : `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    inboxEl.innerHTML = xs.length ? xs.slice(-20).reverse().map((x) => `<div class="inbox-item"><span class="t">${esc(when(x.t))}</span><span class="kind">${x.kind === 'reject' ? `否决 #${esc(x.id)}` : '留言'}</span>${esc(x.text ?? x.why ?? '')}${(x.paths ?? []).slice(0, 6).map((p) => ' ' + chip(p)).join('')}${(x.paths?.length ?? 0) > 6 ? ` …共 ${x.paths.length} 个` : ''}</div>`).join('')
      : '<p class="empty">收件箱是空的</p>';
  }
  inboxEl.addEventListener('click', (e) => { const c = e.target.closest('[data-sel]'); if (c) ctx.select(c.dataset.sel, { focus: true }); });
  $('#send-note').addEventListener('click', async () => {
    const text = $('#note').value.trim();
    if (!text) { $('#note').focus(); return; }
    try {
      const r = await run('note', { text, paths: ctx.selected() });
      $('#note').value = '';
      ctx.status(`已交给 AI（附 ${r.paths.length} 个物体）：写进 inbox.jsonl`);
      loadInbox();
    } catch (e) { ctx.status(`留言失败：${e.message}`); }
  });

  return {
    inspect, saveSelection, restoreSelection, renderBar, loadScore, applyMode, loadProposals, loadInbox,
    // 层文件在磁盘上变了（工具改过、接受了提议）：分数是旧的
    markStale() { if (P()?.score) { stale = true; renderBar(); } },
    get previewing() { return lastPreview; },
  };
}
