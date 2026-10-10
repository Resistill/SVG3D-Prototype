// 预览器界面：编辑器 ⇄ 编译 ⇄ 3D 视图 ⇄ 对象树 / 空间事实
import { compile } from './s3d.js';
import { Viewer } from './render.js';

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

// ── 编辑器 ──
function renderGutter() {
  errLines = new Set((last?.errors ?? []).filter((e) => (e.file || rootFile()) === active).map((e) => e.line).filter(Boolean));
  const n = src.value.split('\n').length;
  let html = '';
  for (let i = 1; i <= n; i++) html += `<div class="${errLines.has(i) ? 'err' : ''}">${i}</div>`;
  gutter.innerHTML = html;
  gutter.scrollTop = src.scrollTop;
}
src.addEventListener('scroll', () => { gutter.scrollTop = src.scrollTop; });
src.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = src.selectionStart;
    src.setRangeText('  ', s, src.selectionEnd, 'end');
    schedule();
  }
});
function gotoLine(line) {
  if (!line) return;
  const lines = src.value.split('\n');
  let pos = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  src.focus({ preventScroll: true });
  src.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
  const lh = parseFloat(getComputedStyle(src).lineHeight);
  src.scrollTop = Math.max(0, (line - 6) * lh);
}

// ── 编译 ──
let timer = 0;
function schedule() { clearTimeout(timer); timer = setTimeout(run, 350); renderGutter(); }
src.addEventListener('input', () => {
  files.set(active, src.value);
  if (fileParam) dirty.add(active); else if (active === rootFile()) store.set('s3d:' + current, src.value);
  renderFileList();
  schedule();
});

// 打开任意文件：index.html?file=work/xxx/scene.s3d（路径相对于服务根目录；工程的组合根会顺带加载各层）
const fileParam = new URLSearchParams(location.search).get('file');
const rootFile = () => fileParam ?? `examples/${current}.s3d`;
// 多文件：总是编译组合根；编辑器显示其中一个文件（active），被 import 的文件也能看、能改
const files = new Map(), dirty = new Set();
let active = null;

// import 的文件要先取回来（编译本身是同步的纯函数）
const importsOf = (text, file) => [...text.matchAll(/^\s*import\s+"([^"]+)"/gm)].map((m) => new URL(m[1], new URL(file, location.href)).pathname.replace(/^\//, ''));
async function preload(text, file) {
  for (const path of importsOf(text, file)) {
    if (files.has(path)) continue;
    try { const t = await (await fetch(path)).text(); files.set(path, t); await preload(t, path); } catch { /* 编译时会报“找不到文件” */ }
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
  const count = (p) => { const t = files.get(p); let n = 1; for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) n++; return n; };
  fileSel.innerHTML = tree.map(({ path, depth }) => `<option value="${esc(path)}">${'\u3000'.repeat(depth)}${esc(path.startsWith(base) ? path.slice(base.length) : path)}${dirty.has(path) ? ' ●' : ''} · ${count(path)} 行</option>`).join('');
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
    renderGutter();
  }
  if (line) gotoLine(line);
}
fileSel.addEventListener('change', () => { openFile(fileSel.value); src.scrollTop = 0; });
async function save() {
  if (!fileParam || !dirty.size) return;
  const bad = [];
  for (const p of [...dirty]) {
    try {
      const r = await fetch(p, { method: 'PUT', body: files.get(p), headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      if (!r.ok) throw new Error(await r.text());
      dirty.delete(p);
    } catch (e) { bad.push(`${p}：${e.message}`); }
  }
  renderFileList();
  statusEl.textContent = bad.length ? `保存失败 ${bad.join('；')}` : '已保存';
}
$('#save').addEventListener('click', save);
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's' && fileParam) { e.preventDefault(); save(); } });

async function run() {
  await preload(files.get(rootFile()), rootFile());
  renderFileList();
  const t0 = performance.now();
  const r = compile(files.get(rootFile()), { file: rootFile(), resolve: (p) => files.get(p) });
  const t1 = performance.now();
  // 网格引用的 src 相对组合根所在的目录（工程目录；与工具的约定一致）
  viewer.srcBase = new URL(rootFile(), location.href).href;
  const warn = viewer.setScene(r);
  const t2 = performance.now();
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
}
errorsEl.addEventListener('click', (e) => { const d = e.target.closest('[data-line]'); if (d) openFile(d.dataset.file, +d.dataset.line); });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
let selected = null;
function select(paths, { line, file, focus } = {}) {
  selected = paths;
  const box = viewer.highlight(paths);
  if (focus && box) viewer.frame(box);
  if (line) openFile(file, line);
  markSelected();
}
function markSelected() {
  const set = new Set(selected ? [].concat(selected) : []);
  for (const li of objList.children) li.classList.toggle('sel', set.has(li.dataset.path));
  const el = [...objList.children].find((li) => set.has(li.dataset.path));
  if (el) el.scrollIntoView({ block: 'nearest' });
}
objList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) select(li.dataset.path, { line: +li.dataset.line, file: li.dataset.file });
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
  if (!hit) return select(null);
  const n = locate(hit.path, e && e.altKey);
  select(hit.path, { line: n && n.line, file: n && n.file });
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
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.id !== b.dataset.pane; });
  });
}

// ── 示例与按钮 ──
const sel = $('#example');
sel.innerHTML = Object.entries(EXAMPLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
async function load(name, { reset } = {}) {
  current = name;
  sel.value = name;
  if (reset) store.del('s3d:' + name);
  const saved = fileParam ? null : store.get('s3d:' + name);
  // ?file= 打开的文件总是从磁盘读（它可能刚被工具改过），不用浏览器里的缓存
  files.clear(); dirty.clear();
  files.set(rootFile(), saved ?? await (await fetch(rootFile())).text());
  active = null;
  openFile(rootFile());
  $('#reset').hidden = saved == null;
  viewer.firstFrame = true;
  select(null);
  run();
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

if (fileParam) {
  // 文件模式：示例下拉框藏起来（文件列表在编辑器上方），编辑不写进浏览器缓存，Ctrl/⌘+S 写回磁盘
  sel.hidden = true;
  $('#reset').title = '丢弃没保存的修改，从磁盘重新读取';
  current = 'file:' + fileParam;
}
window.addEventListener('beforeunload', (e) => { if (dirty.size) e.preventDefault(); });
load(current);

// 调试入口：在控制台里用 s3d.viewer / s3d.last / s3d.compile(源码)
window.s3d = { viewer, compile, get last() { return last; } };
