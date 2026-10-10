// 预览器界面：编辑器 ⇄ 编译 ⇄ 3D 视图 ⇄ 对象树 / 空间事实；工程模式下还有选中面板、工程栏、提议（src/collab.js）
import { compile, FACT_EPS } from './s3d.js';
import { Viewer } from './render.js';
import { createCollab, detectApi, esc } from './collab.js';

const $ = (s) => document.querySelector(s);
const src = $('#src'), gutter = $('#gutter'), errorsEl = $('#errors'), statusEl = $('#status');
const objList = $('#objects'), factList = $('#facts'), semEl = $('#sem'), tip = $('#tip');
const viewer = new Viewer($('#view'));
const EXAMPLES = {
  semantics: '变量 · 集合 · 语义', spaceport: '航天基地', spaceport_edit: '航天基地 · 修改层', spaceport_blueprint: '航天基地 · 蓝图风格',
  curves: '曲线 · 镜像 · 旋转', rotation: '三维旋转', basics: '基础关系',
};
let current = 'semantics', last = null, errLines = new Set();

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 隐私模式等 */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// 行数：数换行符（不 split，大文件每次按键也不分配上千个字符串）
const countLines = (t) => { let n = 1; for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) n++; return n; };

// ── 编辑器 ──
// 行号栏只在行数或出错的行变了时重建（大文件里每次按键都重建几千个 div 会卡）
let gutterKey = '';
function renderGutter() {
  errLines = new Set((last?.errors ?? []).filter((e) => (e.file || rootFile()) === active).map((e) => e.line).filter(Boolean));
  const n = countLines(src.value), key = `${active}|${n}|${[...errLines].join(',')}`;
  if (key !== gutterKey) {
    gutterKey = key;
    const parts = new Array(n);
    for (let i = 1; i <= n; i++) parts[i - 1] = errLines.has(i) ? `<div class="err">${i}</div>` : `<div>${i}</div>`;
    gutter.innerHTML = parts.join('');
  }
  gutter.scrollTop = src.scrollTop;
}
src.addEventListener('scroll', () => { gutter.scrollTop = src.scrollTop; });
src.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !src.readOnly) {
    e.preventDefault();
    const s = src.selectionStart;
    src.setRangeText('  ', s, src.selectionEnd, 'end');
    src.dispatchEvent(new Event('input'));
  }
});
function gotoLine(line) {
  if (!line) return;
  const t = src.value;
  let pos = 0;
  for (let i = 0; i < line - 1 && pos >= 0; i++) { const k = t.indexOf('\n', pos); pos = k < 0 ? t.length : k + 1; }
  const end = t.indexOf('\n', pos);
  src.focus({ preventScroll: true });
  src.setSelectionRange(pos, end < 0 ? t.length : end);
  const lh = parseFloat(getComputedStyle(src).lineHeight);
  src.scrollTop = Math.max(0, (line - 6) * lh);
}

// ── 编译 ──
// 停止输入多久之后重新编译：大场景编译一次要几百毫秒，按上一次的耗时放宽，免得连续打字时每停一下就卡一次
let timer = 0, lastCost = 0;
function schedule() { clearTimeout(timer); timer = setTimeout(run, Math.max(350, Math.min(2000, lastCost * 1.5))); renderGutter(); }
src.addEventListener('input', () => {
  if (src.readOnly) return;
  setFile(active, src.value);
  const wasDirty = dirty.has(active);
  if (fileParam) dirty.add(active); else if (active === rootFile()) store.set('s3d:' + current, src.value);
  // 文件列表只在“未保存”标记或行数变了时重建
  const n = lineCounts.get(active);
  if (!wasDirty || n !== shownCounts.get(active)) renderFileList();
  schedule();
});

// 打开任意文件：index.html?file=work/xxx/scene.s3d（路径相对于服务根目录；工程的组合根会顺带加载各层）；?project=work/xxx 等价于打开它的 scene.s3d
const params = new URLSearchParams(location.search);
const fileParam = params.get('file') ?? (params.get('project') ? params.get('project').replace(/\/*$/, '/scene.s3d') : null);
const rootFile = () => fileParam ?? `examples/${current}.s3d`;
// 多文件：总是编译组合根；编辑器显示其中一个文件（active），被 import 的文件也能看、能改
const files = new Map(), dirty = new Set(), etags = new Map(), lineCounts = new Map(), shownCounts = new Map();
let active = null;
const setFile = (path, text) => { files.set(path, text); lineCounts.set(path, countLines(text)); };

// 工程模式：组合根所在目录有 project.json（docs/PLAN2.md 2.2）。按场景单位换算空间事实的容差，基础层只读
let project = null, api = false;
const isReadonly = (path) => !!project && (path === project.dir + 'base.s3d' || path.startsWith(project.dir + 'base/'));

// 取文件并记下版本（ETag）：保存时带 If-Match，磁盘上的文件被别处改过就会冲突，而不是悄悄覆盖
async function fetchText(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  const t = await r.text();
  etags.set(path, r.headers.get('ETag'));
  return t;
}

// import 的文件要先取回来（编译本身是同步的纯函数）
const importsOf = (text, file) => [...text.matchAll(/^\s*import\s+"([^"]+)"/gm)].map((m) => new URL(m[1], new URL(file, location.href)).pathname.replace(/^\//, ''));
async function preload(text, file) {
  for (const path of importsOf(text, file)) {
    if (files.has(path)) continue;
    try { const t = await fetchText(path); setFile(path, t); await preload(t, path); } catch { /* 编译时会报“找不到文件” */ }
  }
}
// 组合根及其 import 的文件，按 import 顺序深度优先
function fileTree() {
  const out = [], seen = new Set();
  const walk = (path, depth) => {
    if (seen.has(path) || !files.has(path)) return;
    seen.add(path); out.push({ path, depth });
    for (const p of importsOf(files.get(path), path)) walk(p, depth + 1);
  };
  walk(rootFile(), 0);
  return out;
}
const fileSel = $('#file');
function renderFileList() {
  const tree = fileTree(), base = rootFile().replace(/[^/]*$/, '');
  $('#filebar').hidden = tree.length < 2;
  fileSel.innerHTML = tree.map(({ path, depth }) => {
    const n = lineCounts.get(path) ?? countLines(files.get(path));
    shownCounts.set(path, n);
    const ro = isReadonly(path);
    return `<option value="${esc(path)}"${ro ? ' style="color:#7d8694"' : ''}>${'　'.repeat(depth)}${esc(path.startsWith(base) ? path.slice(base.length) : path)}${dirty.has(path) ? ' ●' : ''} · ${n} 行${ro ? ' · 只读' : ''}</option>`;
  }).join('');
  fileSel.value = active;
  $('#save').hidden = !fileParam || !dirty.size;
}
// 切到某个文件并定位到某一行（点击物体、报错、概念时用）
function openFile(path, line) {
  path ||= rootFile();
  if (path !== active && files.has(path)) {
    active = path;
    src.value = files.get(path);
    fileSel.value = path;
    const ro = isReadonly(path);
    src.readOnly = ro;
    $('.editor').classList.toggle('ro', ro);
    renderGutter();
  }
  if (line) gotoLine(line);
}
fileSel.addEventListener('change', () => { openFile(fileSel.value); src.scrollTop = 0; });

// ── 保存（B3：冲突检测） ──
// 带上读取时的 ETag（If-Match）；服务端发现磁盘上的版本不同返回 409，这里提示“重新加载 / 覆盖”
const conflictEl = $('#conflict');
let conflicts = [];
async function save({ force = false, only = null } = {}) {
  if (!fileParam || !dirty.size) return;
  const bad = [], clash = [];
  for (const p of only ?? [...dirty]) {
    if (isReadonly(p)) { bad.push(`${p}：基础层只读`); continue; }
    try {
      const tag = etags.get(p);
      const r = await fetch(p, { method: 'PUT', body: files.get(p), headers: { 'Content-Type': 'text/plain; charset=utf-8', ...(tag && !force ? { 'If-Match': tag } : {}) } });
      if (r.status === 409) { clash.push(p); continue; }
      if (!r.ok) throw new Error(await r.text());
      etags.set(p, r.headers.get('ETag'));
      dirty.delete(p);
    } catch (e) { bad.push(`${p}：${e.message}`); }
  }
  renderFileList();
  showConflicts(clash);
  statusEl.textContent = bad.length ? `保存失败 ${bad.join('；')}` : clash.length ? '有文件已被别处修改，没有保存' : '已保存';
  if (!bad.length && !clash.length) collab?.markStale();
}
function showConflicts(list) {
  conflicts = list;
  conflictEl.hidden = !list.length;
  if (!list.length) return;
  const base = rootFile().replace(/[^/]*$/, '');
  conflictEl.innerHTML = `<span><b>${list.map((p) => esc(p.startsWith(base) ? p.slice(base.length) : p)).join('、')}</b> 已被别处修改（工具、AI 或另一个窗口）：</span>
    <button data-c="reload" title="丢掉这里没保存的修改，读取磁盘上的版本">重新加载</button>
    <button data-c="overwrite" title="用这里的版本覆盖磁盘上的">覆盖</button>
    <button data-c="cancel">先不管</button>`;
}
conflictEl.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-c]')?.dataset.c;
  if (!c) return;
  const list = conflicts;
  showConflicts([]);
  if (c === 'overwrite') await save({ force: true, only: list });
  else if (c === 'reload') {
    for (const p of list) { dirty.delete(p); try { setFile(p, await fetchText(p)); } catch { /* 文件没了 */ } }
    if (list.includes(active)) { const keep = src.scrollTop; src.value = files.get(active); src.scrollTop = keep; }
    renderFileList();
    run();
  }
});
$('#save').addEventListener('click', () => save());
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's' && fileParam) { e.preventDefault(); save(); } });

// 磁盘上的文件被工具改过（接受了提议、细化、重跑逆向）：没改动的文件直接换成新版本；有没保存修改的文件留到保存时按冲突处理
let refreshing = null;
function refreshFromDisk() {
  if (!fileParam) return Promise.resolve(false);
  return (refreshing ??= (async () => {
    let changed = false;
    for (const p of [...files.keys()]) {
      if (dirty.has(p)) continue;
      try {
        const r = await fetch(p, { method: 'HEAD', cache: 'no-store' });
        const tag = r.headers.get('ETag');
        if (r.ok && tag && tag === etags.get(p)) continue;
        const t = await fetchText(p);
        if (t === files.get(p)) continue;
        setFile(p, t);
        changed = true;
        if (p === active) { const keep = src.scrollTop; src.value = t; src.scrollTop = keep; }
      } catch { /* 文件没了：编译时会报错 */ }
    }
    if (changed) { collab?.markStale(); renderFileList(); await run(); }
    await collab?.loadScore();
    return changed;
  })().finally(() => { refreshing = null; }));
}
// 切回这个窗口时看一眼磁盘（AI 可能刚改过文件、评过分、提交了提议）
let lastFocus = 0;
window.addEventListener('focus', () => {
  if (!fileParam || Date.now() - lastFocus < 1500) return;
  lastFocus = Date.now();
  refreshFromDisk();
  if (!$('#prop-pane').hidden) { collab?.loadProposals(); collab?.loadInbox(); }
});

async function run() {
  await preload(files.get(rootFile()), rootFile());
  renderFileList();
  const t0 = performance.now();
  // 工程的场景单位不是米时，空间事实的容差（FACT_EPS，按米）换算成场景单位——与工具（tools/project.mjs）一致
  const r = compile(files.get(rootFile()), { file: rootFile(), resolve: (p) => files.get(p), ...(project ? { factEps: FACT_EPS / project.unit } : {}) });
  const t1 = performance.now();
  // 网格引用的 src 相对组合根所在的目录（工程目录；与工具的约定一致）
  viewer.srcBase = new URL(rootFile(), location.href).href;
  const warn = viewer.setScene(r);
  const t2 = performance.now();
  lastCost = t2 - t0;
  last = r;
  renderGutter();
  errorsEl.innerHTML = [...r.errors.map((e) => `<div class="e" data-file="${esc(e.file ?? '')}" data-line="${e.line ?? ''}"><b>${e.file && e.file !== rootFile() ? esc(e.file) + ' ' : ''}第 ${e.line ?? '?'} 行</b>${esc(e.message)}</div>`),
    ...warn.map((w) => `<div class="e w">${esc(w)}</div>`)].join('');
  errorsEl.hidden = !r.errors.length && !warn.length;
  const failed = r.checks.filter((c) => !c.ok).length;
  statusEl.textContent = `${r.nodes.length} 个对象 · ${r.items.length} 个实体 · ${r.concepts.length} 个概念 · ${r.facts.length} 条空间事实${failed ? ` · ${failed} 项检查未通过` : ''} · 求解 ${(t1 - t0).toFixed(0)}ms · 建模 ${(t2 - t1).toFixed(0)}ms`;
  statusEl.classList.toggle('bad', r.errors.length > 0);
  $('#sem-badge').textContent = failed ? `✗${failed}` : '';
  renderObjects(r);
  renderSemantics(r);
  renderFacts(r);
  // 热力图按路径上色：场景重建之后重新套一遍（setScene 里的 paint 已经按当前模式上色，这里只刷新图例与叠加层）
  collab?.applyMode();
}
errorsEl.addEventListener('click', (e) => { const d = e.target.closest('[data-line]'); if (d) openFile(d.dataset.file, +d.dataset.line); });

const fmt = (v) => v.map((x) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(1)).join(', ');

function renderObjects(r) {
  objList.innerHTML = r.nodes.map((n) => {
    const name = n.path.split('.').pop();
    const size = n.box ? fmt(n.box.max.map((x, k) => x - n.box.min[k])) : '';
    const pos = n.box ? fmt(n.box.min.map((x, k) => (k === 1 ? x : (x + n.box.max[k]) / 2))) : '';
    const title = n.ghost ? '副本：由镜像/旋转关系生成，跟随原物体' : n.hidden ? '已被变体替换：仍参与求解（外包络、关系不变），但不再渲染' : n.skin ? '变体：填充在原对象的外包络里' : '';
    return `<li data-path="${esc(n.path)}" data-line="${n.line}" data-file="${esc(n.file ?? '')}" style="--d:${n.depth}" class="${n.kind === 'instance' ? 'inst' : ''} ${n.ghost ? 'ghost' : ''} ${n.curve ? 'curve' : ''} ${n.hidden ? 'hid' : ''} ${n.skin ? 'skin' : ''}" title="${title}">
      <span class="nm">${esc(name)}</span><span class="kd">${esc(n.kind)}</span>${n.tags.map((t) => `<span class="tg">#${esc(t)}</span>`).join('')}${n.concepts.map((c) => `<span class="cc">${esc(c)}</span>`).join('')}
      ${n.late ? '<span class="late" title="引用了容器外部的对象，不参与容器尺寸计算">后置</span>' : ''}
      <span class="geo" title="底面中心 · 尺寸">@ ${pos} <i>⟂</i> ${size}</span></li>`;
  }).join('');
  markSelected();
}

function renderSemantics(r) {
  const chips = (paths) => `<div class="chips">${paths.slice(0, 60).map((p) => `<span class="chip" data-path="${esc(p)}">${esc(p)}</span>`).join('')}${paths.length > 60 ? `<span class="cnt">…还有 ${paths.length - 60} 个</span>` : ''}</div>`;
  let html = '';
  if (r.concepts.length) {
    html += '<h4>概念</h4>' + r.concepts.map((c) => `<div class="concept" data-line="${c.line}" data-file="${esc(c.file ?? '')}">
      <div class="head" data-paths="${esc(JSON.stringify(c.members))}"><span class="cn">${esc(c.name)}</span><span class="cnt">${c.error ? '出错' : c.members.length + ' 个'}</span><span class="def" title="${esc(c.src)}">= ${esc(c.src)}</span></div>
      ${c.members.length ? chips(c.members) : ''}</div>`).join('');
  }
  if (r.patterns.length) {
    html += '<h4>模式</h4>' + r.patterns.map((p) => `<div class="concept" data-line="${p.line}" data-file="${esc(p.file ?? '')}">
      <div class="head" data-paths="${esc(JSON.stringify(p.matches.flatMap((m) => Object.values(m).flat())))}"><span class="cn">${esc(p.name)}</span><span class="cnt">${p.error ? '出错' : p.matches.length + ' 处'}</span><span class="def">(${esc(p.roles.join(', '))})</span></div>
      ${p.error ? `<div class="bad">${esc(p.error)}</div>` : ''}
      ${p.matches.slice(0, 30).map((m, i) => `<div class="match" data-paths="${esc(JSON.stringify(Object.values(m).flat()))}"><span class="mi">#${i + 1}</span>${Object.entries(m).map(([role, v]) => `<span class="role">${esc(role)}</span>${[].concat(v).map((x) => `<span class="chip" data-path="${esc(x)}">${esc(x)}</span>`).join('')}`).join('')}</div>`).join('')}
    </div>`).join('');
  }
  if (r.variants.length) {
    html += '<h4>变体</h4>' + r.variants.map((v) => `<div class="concept" data-line="${v.line}" data-file="${esc(v.file ?? '')}">
      <div class="head" data-paths="${esc(JSON.stringify(v.members))}"><span class="cn">${esc(v.src)}</span><span class="cnt">→ ${esc(v.use)} · ${v.members.length} 个</span></div>
      ${v.members.length ? chips(v.members) : ''}</div>`).join('');
  }
  if (r.checks.length) {
    html += '<h4>检查</h4>' + r.checks.map((c) => `<div class="check" data-line="${c.line}" data-file="${esc(c.file ?? '')}">
      <span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span><span class="msg">${esc(c.message)}</span>
      ${c.error ? `<span class="bad">${esc(c.error)}</span>` : ''}${c.violators.length ? chips(c.violators) : ''}</div>`).join('');
  }
  semEl.innerHTML = html || '<p class="empty">还没有定义概念、模式或检查。试试：<code>concept pier = kind(cyl) &amp; on(ground)</code></p>';
}
semEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) return select(chip.dataset.path);
  const head = e.target.closest('[data-paths]');
  if (head) { const ps = JSON.parse(head.dataset.paths), at = head.closest('[data-line]'); if (ps.length) select(ps, { line: head.classList.contains('match') ? 0 : +at.dataset.line, file: at.dataset.file }); }
});

function renderFacts(r) {
  const groups = { on: '支撑 on', against: '贴面 against', inside: '包含 inside', touching: '接触 touching', intersects: '相交 intersects' };
  factList.innerHTML = Object.entries(groups).map(([k, title]) => {
    const fs = r.facts.filter((f) => f.rel === k);
    if (!fs.length) return '';
    return `<h4>${title} <small>${fs.length}</small></h4>` + fs.map((f) => {
      const parts = f.text.split(' ');
      return `<li data-a="${esc(f.a)}" data-b="${esc(f.b)}"><code><span class="ref">${esc(parts[0])}</span> <span class="kw">${esc(parts[1])}</span> <span class="ref">${esc(parts.slice(2).join(' '))}</span></code></li>`;
    }).join('');
  }).join('') || '<p class="empty">没有推导出空间事实</p>';
}

// ── 选择与高亮 ──
// selected：选中的物体（写进 state/selection.json，选中面板显示它们）；highlightOnly 只改 3D 视图里的高亮（看同类、看关系、看提议改了什么）
let selected = null;
function select(paths, { line, file, focus, silent } = {}) {
  selected = paths == null ? null : [].concat(paths);
  if (selected && !selected.length) selected = null;
  const box = viewer.highlight(selected);
  if (focus && box) viewer.frame(box);
  if (line) openFile(file, line);
  markSelected();
  collab?.inspect(selected);
  if (!silent) collab?.saveSelection(selected ?? []);
}
function highlightOnly(paths, { focus } = {}) {
  const box = viewer.highlight(paths);
  if (focus && box) viewer.frame(box);
  markSelected(paths);
}
// Shift+点击：加入 / 移出选中
function toggle(path, opts) {
  const cur = selected ? [...selected] : [];
  const i = cur.indexOf(path);
  if (i >= 0) cur.splice(i, 1); else cur.push(path);
  select(cur, opts);
}
function markSelected(paths = selected) {
  const set = new Set(paths ? [].concat(paths) : []);
  let first = null;
  for (const li of objList.children) { const on = set.has(li.dataset.path); li.classList.toggle('sel', on); if (on && !first) first = li; }
  if (first) first.scrollIntoView({ block: 'nearest' });
}
objList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  if (e.shiftKey) return toggle(li.dataset.path);
  select(li.dataset.path, { line: +li.dataset.line, file: li.dataset.file });
});
objList.addEventListener('dblclick', (e) => {
  const li = e.target.closest('li');
  if (li) select(li.dataset.path, { focus: true });
});
factList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) select([li.dataset.a, li.dataset.b]);
});
// 类型实例里的部件：定位到放置这个实例的语句（def 是共享的，改它会改所有实例）；按住 Alt 点击才跳到 def
function locate(path, toDef) {
  const byPath = (p) => last && last.nodes.find((x) => x.path === p);
  if (!toDef && last) {
    const segs = path.split('.'), defs = new Set(last.defs);
    for (let k = 1; k < segs.length; k++) { const a = byPath(segs.slice(0, k).join('.')); if (a && defs.has(a.kind)) return a; }
  }
  return byPath(path);
}
viewer.clickCb = (hit, e) => {
  if (!hit) return e?.shiftKey ? undefined : select(null);
  const n = locate(hit.path, e && e.altKey);
  if (e?.shiftKey) toggle(hit.path);
  else select(hit.path, { line: n && n.line, file: n && n.file });
  // 工程模式：点 3D 视图里的物体时切到“选中”面板
  if (project && $('#objects-pane').hidden === false) showPane('inspect-pane');
};
viewer.hoverCb = (hit, e) => {
  if (!hit) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.innerHTML = esc(hit.path) + (hit.tags && hit.tags.length ? ' ' + hit.tags.map((t) => '#' + esc(t)).join(' ') : '');
  const r = $('#view').getBoundingClientRect();
  tip.style.left = e.clientX - r.left + 14 + 'px';
  tip.style.top = e.clientY - r.top + 14 + 'px';
};

// ── 面板切换 ──
function showPane(id) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.pane === id));
  document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.id !== id; });
  if (id === 'prop-pane') { collab?.loadProposals(); collab?.loadInbox(); }
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showPane(b.dataset.pane));

// ── 示例与按钮 ──
const sel = $('#example');
sel.innerHTML = Object.entries(EXAMPLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
async function load(name, { reset } = {}) {
  current = name;
  sel.value = name;
  if (reset) store.del('s3d:' + name);
  const saved = fileParam ? null : store.get('s3d:' + name);
  // ?file= 打开的文件总是从磁盘读（它可能刚被工具改过），不用浏览器里的缓存
  files.clear(); dirty.clear(); etags.clear(); lineCounts.clear(); showConflicts([]);
  try { setFile(rootFile(), saved ?? await fetchText(rootFile())); } catch (e) { setFile(rootFile(), ''); statusEl.textContent = `读取失败：${e.message}`; }
  active = null;
  openFile(rootFile());
  $('#reset').hidden = saved == null;
  viewer.firstFrame = true;
  select(null, { silent: true });
  await run();
}
sel.addEventListener('change', () => load(sel.value));
$('#reset').addEventListener('click', () => load(current, { reset: true }));
src.addEventListener('input', () => { $('#reset').hidden = false; });
$('#fit').addEventListener('click', () => viewer.frame());
$('#fly').addEventListener('click', (e) => { e.target.blur(); viewer.toggleFly(); });
let statusSaved = '';
viewer.fly.onChange = (on) => {
  $('#fly').classList.toggle('on', on);
  if (on) { statusSaved = statusEl.textContent; statusEl.textContent = '漫游中：鼠标转视角 · WASD 移动 · Q/E 升降 · Shift 加速 · 滚轮调速 · Esc 退出（鼠标没锁住就点一下画面）'; }
  else statusEl.textContent = statusSaved;
};
$('#curves').addEventListener('click', (e) => {
  viewer.curveLayer.visible = !viewer.curveLayer.visible;
  e.target.classList.toggle('on', viewer.curveLayer.visible);
});
$('#export').addEventListener('click', () => viewer.exportGLB(current));

// 工程：project.json 是静态文件，没有接口也能读（单位、档位、源模型）；有接口时再取待处理提议数
async function openProjectFor(file) {
  const dir = file.replace(/[^/]*$/, '');
  try {
    const r = await fetch(dir + 'project.json', { cache: 'no-store' });
    if (!r.ok) return null;
    const cfg = await r.json();
    return { dir, apiDir: dir.replace(/\/$/, '') || '.', cfg, unit: cfg.unit ?? 1, score: null };
  } catch { return null; }
}

let collab = null;
if (fileParam) {
  // 文件模式：示例下拉框藏起来（文件列表在编辑器上方），编辑不写进浏览器缓存，Ctrl/⌘+S 写回磁盘
  sel.hidden = true;
  $('#reset').title = '丢弃没保存的修改，从磁盘重新读取';
  current = 'file:' + fileParam;
  [project, api] = await Promise.all([openProjectFor(fileParam), detectApi()]);
}
collab = createCollab({
  viewer, files, dirty, rootFile, locate, openFile, select, highlightOnly, refreshFromDisk,
  get project() { return project; }, get api() { return api; },
  last: () => last, selected: () => selected ?? [],
  status: (m) => { statusEl.textContent = m; },
});
if (project) {
  $('#prop-tab').hidden = !api;
  collab.renderBar();
  document.title = `${project.apiDir} · SVG3D`;
}
window.addEventListener('beforeunload', (e) => { if (dirty.size) e.preventDefault(); });
await load(current);
if (project) {
  await collab.loadScore();
  if (api) { collab.restoreSelection(); collab.loadProposals(); }
}

// 调试入口：在控制台里用 s3d.viewer / s3d.last / s3d.compile(源码)
window.s3d = { viewer, compile, get last() { return last; }, get project() { return project; } };
