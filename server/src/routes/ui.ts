/**
 * Built-in read-only memory viewer.
 *
 * The page itself is static (no data embedded); it reads the API key from
 * `?key=` (or localStorage) and calls the authenticated /api/* endpoints.
 * Same-origin, so no CORS or extra auth scheme is needed.
 */

export const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>opencode-mem · memory viewer</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1f232c; --text: #e6e8ee;
    --muted: #8b93a7; --line: #2a2f3a; --accent: #6ea8fe; --ok: #3ddc97; --warn: #f5b759; --bad: #ff6b6b;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7f9; --panel: #ffffff; --panel2: #f0f2f5; --text: #1c2028;
      --muted: #5f6878; --line: #e2e5ea; --accent: #2563eb; --ok: #0f9d6e; --warn: #b7791f; --bad: #d64545;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 60px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
  h1 { font-size: 18px; margin: 0; font-weight: 650; letter-spacing: .2px; }
  .sub { color: var(--muted); font-size: 12px; }
  .spacer { flex: 1; }
  .badge { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
  .badge.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card .n { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .card .l { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  .tab {
    background: transparent; color: var(--muted); border: 1px solid var(--line);
    padding: 7px 14px; border-radius: 999px; cursor: pointer; font-size: 13px;
  }
  .tab.active { background: var(--panel); color: var(--text); border-color: var(--accent); }
  section.page { display: none; }
  section.page.active { display: block; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  select, input, button.btn {
    background: var(--panel2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px;
  }
  select { min-width: 280px; max-width: 100%; }
  input { flex: 1; min-width: 200px; }
  button.btn { cursor: pointer; }
  button.btn:hover { border-color: var(--accent); }
  .mem { border-top: 1px solid var(--line); padding: 12px 0; }
  .mem:first-child { border-top: 0; padding-top: 0; }
  .mem .t { font-weight: 600; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .tag { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); padding: 1px 6px; border-radius: 5px; }
  .tag.manual { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
  .mem .c { color: var(--muted); margin-top: 3px; white-space: pre-wrap; }
  .mem .m { color: var(--muted); font-size: 11px; margin-top: 4px; opacity: .8; }
  .empty { color: var(--muted); padding: 18px 0; text-align: center; }
  pre.profile { white-space: pre-wrap; font: inherit; margin: 0; }
  .focus-item { display: flex; gap: 10px; align-items: baseline; padding: 9px 0; border-top: 1px solid var(--line); }
  .focus-item:first-child { border-top: 0; }
  .focus-item .w { color: var(--muted); font-size: 12px; }
  .err { color: var(--bad); font-size: 13px; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 8px; }
  #gate { max-width: 420px; margin: 80px auto; }
  #gate .panel { padding: 22px; }
  code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <div id="gate" style="display:none">
    <div class="panel">
      <h1>opencode-mem</h1>
      <p class="sub" style="margin:10px 0 16px">输入你的 Worker API key 以查看记忆。</p>
      <div class="row"><input id="keyInput" type="password" placeholder="user key" /><button class="btn" id="keySave">进入</button></div>
      <p class="hint">也可直接访问 <code>/ui?key=&lt;api_key&gt;</code>。Key 仅保存在本机浏览器。</p>
    </div>
  </div>

  <div id="app" style="display:none">
    <header>
      <h1>opencode-mem</h1>
      <span class="sub" id="serverInfo"></span>
      <span class="spacer"></span>
      <span class="badge" id="pipeBadge">pipeline …</span>
      <button class="btn" id="refresh">刷新</button>
    </header>

    <div class="cards" id="cards"></div>

    <div class="tabs">
      <button class="tab active" data-page="workspace">工作区</button>
      <button class="tab" data-page="hard">硬性记忆</button>
      <button class="tab" data-page="profile">用户画像</button>
      <button class="tab" data-page="focus">最近关注</button>
    </div>

    <section class="page active" id="page-workspace">
      <div class="panel">
        <div class="row">
          <select id="wsSelect"></select>
          <span class="sub" id="wsMeta"></span>
        </div>
      </div>
      <div class="panel">
        <div class="row" style="margin-bottom:10px"><strong>工作区记忆</strong><span class="sub" id="wsCount"></span></div>
        <div id="wsList"></div>
      </div>
      <div class="panel">
        <div class="row" style="margin-bottom:10px"><strong>该工作区的最近关注</strong></div>
        <div id="wsFocus"></div>
      </div>
    </section>

    <section class="page" id="page-hard">
      <div class="panel">
        <div class="row">
          <input id="hardSearch" placeholder="搜索硬性记忆（留空显示最近 100 条）" />
          <button class="btn" id="hardSearchBtn">搜索</button>
        </div>
      </div>
      <div class="panel"><div id="hardList"></div></div>
    </section>

    <section class="page" id="page-profile">
      <div class="panel"><pre class="profile" id="profileText"></pre></div>
    </section>

    <section class="page" id="page-focus">
      <div class="panel">
        <div class="row" style="margin-bottom:10px">
          <strong>最近关注</strong>
          <label class="sub"><input type="checkbox" id="focusAll" style="vertical-align:middle" /> 包含其他工作区</label>
        </div>
        <div id="focusList"></div>
      </div>
    </section>
  </div>
</div>

<script>
(function () {
  var KEY = new URLSearchParams(location.search).get('key') || localStorage.getItem('memkey') || '';
  var state = { workspaces: [], ws: '' };

  var $ = function (s) { return document.querySelector(s); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function showGate() { $('#gate').style.display = 'block'; $('#app').style.display = 'none'; }
  function showApp() { $('#gate').style.display = 'none'; $('#app').style.display = 'block'; }

  async function api(path) {
    var r = await fetch(path, { headers: { Authorization: 'Bearer ' + KEY } });
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
    return r.json();
  }

  function fail(container, e) {
    container.textContent = '';
    container.appendChild(el('div', 'err', String(e && e.message ? e.message : e)));
  }

  function shortWs(ws) {
    if (!ws) return 'global';
    var parts = ws.split('/').filter(Boolean);
    return parts.length <= 3 ? ws : '…/' + parts.slice(-2).join('/');
  }

  function renderMemoryList(container, items) {
    container.textContent = '';
    if (!items || items.length === 0) {
      container.appendChild(el('div', 'empty', '暂无记忆'));
      return;
    }
    items.forEach(function (m) {
      var box = el('div', 'mem');
      var t = el('div', 't');
      t.appendChild(el('span', 'tag ' + (m.source === 'manual' ? 'manual' : ''), m.type));
      t.appendChild(el('span', null, m.title));
      box.appendChild(t);
      if (m.content) box.appendChild(el('div', 'c', m.content));
      var meta = [];
      if (m.source) meta.push('source: ' + m.source);
      if (m.priority) meta.push('priority: ' + m.priority);
      if (m.workspace) meta.push('ws: ' + shortWs(m.workspace));
      if (m.usage_count) meta.push('used ' + m.usage_count + '×');
      if (m.timestamp) meta.push(m.timestamp.slice(0, 10));
      box.appendChild(el('div', 'm', meta.join(' · ')));
      container.appendChild(box);
    });
  }

  function renderFocus(container, items) {
    container.textContent = '';
    if (!items || items.length === 0) {
      container.appendChild(el('div', 'empty', '暂无关注话题（每日摘要生成后出现）'));
      return;
    }
    items.forEach(function (f) {
      var row = el('div', 'focus-item');
      row.appendChild(el('strong', null, f.topic));
      row.appendChild(el('span', 'w', (f.workspace ? shortWs(f.workspace) : 'global') + ' · 最近 ' + f.last_seen + (f.weight > 1 ? ' · ×' + Math.round(f.weight) : '')));
      container.appendChild(row);
    });
  }

  async function loadStats() {
    try {
      var s = await api('/api/memory/stats');
      var cards = [
        [s.raw_total, '原始对话'],
        [s.hard_active, '硬性记忆'],
        [s.workspace_memories, '工作区记忆'],
        [s.workspaces, '工作区'],
        [s.focus_topics, '关注话题'],
        [s.profile_version == null ? '—' : 'v' + s.profile_version, '画像版本']
      ];
      var box = $('#cards');
      box.textContent = '';
      cards.forEach(function (c) {
        var card = el('div', 'card');
        card.appendChild(el('div', 'n', String(c[0])));
        card.appendChild(el('div', 'l', c[1]));
        box.appendChild(card);
      });
    } catch (e) { /* leave cards empty */ }
  }

  async function loadHealth() {
    try {
      var r = await fetch('/health');
      var h = await r.json();
      var badge = $('#pipeBadge');
      badge.textContent = 'pipeline ' + h.pipeline_status;
      badge.className = 'badge ' + (h.pipeline_status === 'ok' ? 'ok' : 'bad');
      $('#serverInfo').textContent = 'LLM ' + (h.pipeline && h.pipeline.llm_ok_at ? 'ok @ ' + h.pipeline.llm_ok_at.slice(0, 16).replace('T', ' ') : 'unknown');
    } catch (e) {
      $('#pipeBadge').textContent = 'pipeline unreachable';
      $('#pipeBadge').className = 'badge bad';
    }
  }

  async function loadWorkspaces() {
    var data = await api('/api/workspace/list');
    state.workspaces = data.items || [];
    var sel = $('#wsSelect');
    sel.textContent = '';
    if (state.workspaces.length === 0) {
      sel.appendChild(el('option', null, '（还没有工作区数据）'));
      return;
    }
    state.workspaces.forEach(function (w) {
      var opt = el('option', null, shortWs(w.workspace) + '  ·  ' + w.memories + ' 记忆 / ' + w.raws + ' 对话');
      opt.value = w.workspace;
      sel.appendChild(opt);
    });
    if (!state.ws) state.ws = state.workspaces[0].workspace;
    sel.value = state.ws;
    await loadWorkspaceDetail();
  }

  async function loadWorkspaceDetail() {
    if (!state.ws) return;
    $('#wsMeta').textContent = state.ws;
    try {
      var mem = await api('/api/workspace/memory?workspace=' + encodeURIComponent(state.ws) + '&limit=100');
      $('#wsCount').textContent = mem.total + ' 条';
      renderMemoryList($('#wsList'), mem.items);
    } catch (e) { fail($('#wsList'), e); }
    try {
      var f = await api('/api/workspace/focus?workspace=' + encodeURIComponent(state.ws) + '&days=14&limit=10');
      renderFocus($('#wsFocus'), f.items);
    } catch (e) { fail($('#wsFocus'), e); }
  }

  async function loadHard(q) {
    try {
      var path = q
        ? '/api/memory/search?q=' + encodeURIComponent(q) + '&limit=50&scope=global'
        : '/api/memory?limit=100';
      var data = await api(path);
      renderMemoryList($('#hardList'), data.items);
    } catch (e) { fail($('#hardList'), e); }
  }

  async function loadProfile() {
    var box = $('#profileText');
    if (!box.textContent) box.textContent = '加载中…';
    try {
      var p = await api('/api/profile');
      box.textContent = p.content || '暂无画像';
    } catch (e) { box.textContent = String(e.message || e); }
  }

  async function loadFocus(all) {
    try {
      var path = '/api/workspace/focus?days=14&limit=20' + (all ? '' : (state.ws ? '&workspace=' + encodeURIComponent(state.ws) : ''));
      var data = await api(path);
      renderFocus($('#focusList'), data.items);
    } catch (e) { fail($('#focusList'), e); }
  }

  function bind() {
    document.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('section.page').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        $('#page-' + btn.dataset.page).classList.add('active');
        if (btn.dataset.page === 'hard') loadHard($('#hardSearch').value.trim());
        if (btn.dataset.page === 'profile') loadProfile();
        if (btn.dataset.page === 'focus') loadFocus($('#focusAll').checked);
      });
    });

    $('#wsSelect').addEventListener('change', function (e) {
      state.ws = e.target.value;
      loadWorkspaceDetail();
    });

    $('#hardSearchBtn').addEventListener('click', function () { loadHard($('#hardSearch').value.trim()); });
    $('#hardSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadHard($('#hardSearch').value.trim()); });
    $('#focusAll').addEventListener('change', function (e) { loadFocus(e.target.checked); });
    $('#refresh').addEventListener('click', function () { boot(); });

    $('#keySave').addEventListener('click', function () {
      var v = $('#keyInput').value.trim();
      if (!v) return;
      localStorage.setItem('memkey', v);
      KEY = v;
      boot();
    });
    $('#keyInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#keySave').click();
    });
  }

  async function boot() {
    if (!KEY) { showGate(); return; }
    try {
      await api('/api/whoami');
    } catch (e) {
      localStorage.removeItem('memkey');
      KEY = '';
      showGate();
      return;
    }
    showApp();
    loadHealth();
    await loadStats();
    await loadWorkspaces();
  }

  bind();
  boot();
})();
</script>
</body>
</html>`;