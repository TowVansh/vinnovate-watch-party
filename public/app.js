// Couch Sync client: clock sync, drift correction, chat, reactions, discovery, playlist, polls, people.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { s = Math.max(0, s | 0); const h = s / 3600 | 0, m = (s % 3600) / 60 | 0, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
function toast(t) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => el.style.display = 'none', 2500); }

let myId = localStorage.getItem('wpId');
if (!myId) { myId = Math.random().toString(36).slice(2, 12); localStorage.setItem('wpId', myId); }
$('nameIn').value = new URLSearchParams(location.search).get('name') || localStorage.getItem('wpName') || '';
const inviteCode = (location.pathname.match(/^\/r\/([A-Za-z0-9]{6})/) || [])[1];
if (inviteCode) $('codeIn').value = inviteCode.toUpperCase();

// ------------------------------------------------------------ state
const S = { code: null, state: null, members: [], playlist: [], polls: [], locked: false, watched: [], reactions: [], catalog: [], picks: new Set(), genre: null };
const video = $('video');
const me = () => S.members.find(m => m.id === myId) || {};
const canControl = () => me().host || !S.locked;

// ------------------------------------------------------------ clock sync (NTP style: keep the lowest-RTT sample)
let offset = 0, samples = [];
const serverNow = () => Date.now() + offset;
function ping() { send({ t: 'ping', ts: Date.now() }); }
function onPong(m) {
  const t1 = Date.now(), rtt = t1 - m.ts;
  samples.push({ rtt, off: m.server - (m.ts + t1) / 2 });
  samples = samples.slice(-10);
  offset = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
}

// ------------------------------------------------------------ socket with auto-reconnect
let ws, retry = 300, wanted = null;
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  conn('connecting', 'var(--warn)');
  ws.onopen = () => {
    retry = 300; samples = [];
    send({ t: 'join', code: wanted, id: myId, name: localStorage.getItem('wpName') || 'Guest' });
    for (let i = 0; i < 5; i++) setTimeout(ping, i * 120);
  };
  ws.onclose = e => {
    conn('reconnecting…', 'var(--bad)');
    if (e.code === 4000) return conn('opened in another tab', 'var(--bad)');
    setTimeout(connect, retry); retry = Math.min(retry * 2, 5000);
  };
  ws.onmessage = e => handle(JSON.parse(e.data));
}
function conn(text, color) { $('connText').textContent = text; $('connDot').style.background = color; }
setInterval(ping, 10000);

function handle(m) {
  switch (m.t) {
    case 'pong': return onPong(m);
    case 'error':
      if (!S.code) { $('lobbyErr').textContent = m.msg; wanted = null; ws.onclose = null; ws.close(); ws = null; return; }
      return toast(m.msg);
    case 'welcome':
      Object.assign(S, { code: m.code, members: m.members, playlist: m.playlist, polls: m.polls, locked: m.locked, watched: m.watched, reactions: m.reactions });
      wanted = m.code;
      history.replaceState(null, '', '/r/' + m.code);
      $('lobby').classList.add('hidden'); $('room').classList.remove('hidden');
      $('roomCode').textContent = m.code;
      conn('connected', 'var(--ok)');
      $('chatLog').innerHTML = ''; m.chat.forEach(addChat);
      applyState(m.state); renderAll();
      return;
    case 'state':
      if (m.rejected) toast('Someone changed playback first — synced to their action');
      $('latPill').textContent = `control ${Math.max(0, Math.round(serverNow() - m.state.at))} ms`;
      if (m.state.by && S.state && m.state.seq > S.state.seq && m.state.by !== me().name) toast(describe(m.state, S.state));
      return applyState(m.state);
    case 'members': S.members = m.members; S.locked = m.locked; return renderPeople();
    case 'playlist': S.playlist = m.playlist; return renderPlaylist();
    case 'polls': S.polls = m.polls; return renderPolls();
    case 'chat': return addChat(m);
    case 'react': S.reactions.push(m); floatEmoji(m.emoji, m.from); return renderMarks();
  }
}
function describe(n, o) {
  if (n.src !== o.src) return `${n.by} started “${n.title}”`;
  if (n.playing !== o.playing) return `${n.by} ${n.playing ? 'played' : 'paused'}`;
  return `${n.by} jumped to ${fmt(n.pos)}`;
}

// ------------------------------------------------------------ playback sync
function expected() {
  const st = S.state;
  return st.playing ? st.pos + (serverNow() - st.at) / 1000 : st.pos;
}
function applyState(st) {
  const srcChanged = !S.state || S.state.src !== st.src;
  S.state = st;
  if (srcChanged) {
    if (st.src) { video.src = st.src; S.watched = st.movieId ? [...S.watched, st.movieId] : S.watched; }
    else video.removeAttribute('src');
    renderMarks(); renderMovies();
  }
  $('empty').classList.toggle('hidden', !!st.src);
  $('nowTitle').textContent = st.title || '—';
  ['playBtn', 'seek'].forEach(id => $(id).disabled = !st.src);
  syncTick(true);
}

let lastReport = 0, buffering = false;
function syncTick(force) {
  const st = S.state;
  if (!st || !st.src || video.readyState < 1) return;
  const exp = expected();
  const drift = (video.currentTime - exp) * 1000; // + means we are ahead
  if (st.playing && video.paused) video.play().then(() => $('tapToPlay').classList.add('hidden')).catch(() => $('tapToPlay').classList.remove('hidden'));
  if (!st.playing && !video.paused) video.pause();
  if (Math.abs(drift) > 400 || (!st.playing && Math.abs(drift) > 150)) {
    video.currentTime = Math.max(0, exp);   // big jump: hard seek
    video.playbackRate = 1;
  } else if (st.playing && Math.abs(drift) > 50) {
    video.playbackRate = 1 - Math.max(-0.15, Math.min(0.15, drift / 1000)); // small drift: catch up / fall back smoothly
  } else video.playbackRate = 1;
  const d = Math.round(drift);
  const pill = $('syncPill');
  pill.textContent = buffering ? 'buffering…' : `sync ${d > 0 ? '+' : ''}${d} ms`;
  pill.style.color = buffering || Math.abs(d) > 500 ? 'var(--bad)' : Math.abs(d) > 150 ? 'var(--warn)' : 'var(--ok)';
  if (performance.now() - lastReport > 1000) { lastReport = performance.now(); send({ t: 'report', drift: d, buffering }); }
}
setInterval(syncTick, 250);
video.addEventListener('loadedmetadata', () => { syncTick(true); renderMarks(); });
video.addEventListener('waiting', () => { buffering = true; });
video.addEventListener('playing', () => { buffering = false; });
video.addEventListener('ended', () => send({ t: 'ended', src: S.state.src }));
video.addEventListener('timeupdate', () => {
  if (!seeking) $('seek').value = video.duration ? (video.currentTime / video.duration) * 1000 : 0;
  $('time').textContent = `${fmt(video.currentTime)} / ${fmt(video.duration || 0)}`;
});
$('tapBtn').onclick = () => video.play().then(() => $('tapToPlay').classList.add('hidden'));

function control(action, extra = {}) {
  if (!canControl()) return toast('The host has locked playback controls');
  send({ t: 'control', action, seq: S.state.seq, ...extra });
}
$('playBtn').onclick = () => control(S.state.playing ? 'pause' : 'play', { pos: S.state.playing ? video.currentTime : expected() });
let seeking = false;
$('seek').oninput = () => { seeking = true; };
$('seek').onchange = () => { seeking = false; if (video.duration) control('seek', { pos: $('seek').value / 1000 * video.duration }); };
$('muteBtn').onclick = () => { video.muted = !video.muted; $('muteBtn').textContent = video.muted ? '🔇' : '🔊'; };
$('fsBtn').onclick = () => $('videoWrap').requestFullscreen?.();
addEventListener('keydown', e => { if (e.target.tagName !== 'INPUT' && e.code === 'Space' && S.state?.src) { e.preventDefault(); $('playBtn').click(); } });
setInterval(() => { if (S.state) $('playBtn').textContent = S.state.playing ? '⏸' : '▶'; $('lockPill').classList.toggle('hidden', !S.locked); }, 200);

// ------------------------------------------------------------ reactions
document.querySelectorAll('#reacts [data-e]').forEach(b => b.onclick = () => send({ t: 'react', emoji: b.dataset.e, at: video.currentTime }));
function floatEmoji(e, from) {
  const el = document.createElement('div');
  el.className = 'float';
  el.style.left = 10 + Math.random() * 80 + '%';
  el.innerHTML = `${esc(e)}<span>${esc(from)}</span>`;
  $('videoWrap').appendChild(el);
  setTimeout(() => el.remove(), 2700);
}
function renderMarks() { // reaction timeline on the seek bar: see where the room laughed
  const d = video.duration, list = S.reactions.filter(r => r.src === S.state?.src);
  $('marks').innerHTML = d ? list.slice(-80).map(r => `<i style="left:${(r.at / d) * 100}%">${esc(r.emoji)}</i>`).join('') : '';
}

// ------------------------------------------------------------ chat
function addChat(m) {
  const el = document.createElement('div');
  el.className = 'msg' + (m.sys ? ' sys' : '');
  el.innerHTML = m.sys ? esc(m.text) : `<b>${esc(m.from)}</b> ${esc(m.text)}`;
  const log = $('chatLog'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(el);
  if (atBottom) log.scrollTop = log.scrollHeight;
}
$('chatForm').onsubmit = e => { e.preventDefault(); const t = $('chatIn').value.trim(); if (t) send({ t: 'chat', text: t }); $('chatIn').value = ''; };

// ------------------------------------------------------------ discovery: fuzzy search, filters, room-aware recommendations
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function subseq(q, s) { let i = 0; for (const c of s) if (c === q[i]) i++; return i === q.length; }
// score each query token against title (x3), genres/decade (x2), description (x1); every token must match somewhere
function fuzzy(query, m) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  const fields = [[m.title.toLowerCase(), 3], [(m.genres.join(' ') + ' ' + (m.year ? Math.floor(m.year / 10) * 10 + 's ' + String(m.year).slice(2, 3) + '0s ' + m.year : '')).toLowerCase(), 2], [m.desc.toLowerCase(), 1]];
  let total = 0;
  for (const tk of tokens) {
    let best = 0;
    for (const [text, w] of fields) {
      if (text.includes(tk)) best = Math.max(best, 3 * w);
      else for (const word of text.split(/[^a-z0-9]+/)) {
        if (tk.length >= 4 && lev(tk, word) <= (tk.length > 6 ? 2 : 1)) best = Math.max(best, 2 * w);
        else if (tk.length >= 3 && w === 3 && subseq(tk, word)) best = Math.max(best, 1.5 * w);
      }
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}
function affinity() { // genres the room watched (x2) or queued (x1)
  const byId = Object.fromEntries(S.catalog.map(m => [m.id, m])), a = {};
  S.watched.forEach(id => byId[id]?.genres.forEach(g => a[g] = (a[g] || 0) + 2));
  S.playlist.forEach(p => byId[p.movieId]?.genres.forEach(g => a[g] = (a[g] || 0) + 1));
  return a;
}
function renderMovies() {
  if (!S.catalog.length) return;
  const q = $('search').value, len = $('lenSel').value, dec = $('decSel').value, sort = $('sortSel').value, aff = affinity();
  const seen = new Set(S.watched), lastWatched = S.catalog.find(m => m.id === S.watched[S.watched.length - 1]);
  const why = m => { // explain with the genres it shares with the last thing the room watched
    const common = lastWatched && !seen.has(m.id) ? m.genres.filter(g => lastWatched.genres.includes(g)) : [];
    return common.length ? `Because you watched ${lastWatched.title} (${common.join(', ')})` : '';
  };
  let list = S.catalog.map(m => {
    const shared = m.genres.filter(g => aff[g]);
    const rec = shared.reduce((s, g) => s + aff[g], 0) - (seen.has(m.id) ? 50 : 0) + 3 / m.popularity;
    return { m, fz: fuzzy(q, m), rec, why: why(m) };
  }).filter(x => x.fz > 0
    && (!S.genre || x.m.genres.includes(S.genre))
    && (!len || (len === 'short' ? x.m.mins < 30 : x.m.mins >= 30))
    && (!dec || (x.m.year && Math.floor(x.m.year / 10) * 10 === +dec)));
  const by = { rec: (a, b) => q ? b.fz - a.fz || b.rec - a.rec : b.rec - a.rec, pop: (a, b) => a.m.popularity - b.m.popularity, old: (a, b) => (a.m.year || 9999) - (b.m.year || 9999), new: (a, b) => (b.m.year || 0) - (a.m.year || 0) }[sort];
  list.sort(by);
  $('movies').innerHTML = list.length ? list.map(({ m, why }) => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;gap:8px"><span class="title">${esc(m.title)}</span><label class="small muted"><input type="checkbox" data-pick="${esc(m.id)}" ${S.picks.has(m.id) ? 'checked' : ''}> poll</label></div>
      <div class="small muted">${m.year || '—'} · ${m.mins} min · ${m.genres.map(esc).join(', ')}${seen.has(m.id) ? ' · watched' : ''}</div>
      ${why ? `<div class="why">${esc(why)}</div>` : ''}
      <div class="small muted">${esc(m.desc)}</div>
      <div class="acts"><button data-play="${esc(m.id)}" ${canControl() ? '' : 'disabled'}>▶ Play now</button><button data-queue="${esc(m.id)}">+ Playlist</button></div>
    </div>`).join('') : '<div class="muted">No matches. Try fewer filters.</div>';
}
const movie = id => S.catalog.find(m => m.id === id);
$('movies').onclick = e => {
  const p = e.target.dataset.play, q = e.target.dataset.queue, pick = e.target.dataset.pick;
  if (p) { const m = movie(p); control('load', { src: m.src, title: m.title, movieId: m.id }); }
  if (q) { const m = movie(q); send({ t: 'pl_add', src: m.src, title: m.title, movieId: m.id }); toast(`Added “${m.title}”`); }
  if (pick) {
    e.target.checked ? S.picks.add(pick) : S.picks.delete(pick);
    if (S.picks.size > 4) { S.picks.delete(pick); e.target.checked = false; toast('Max 4 options'); }
    $('pollFromPicks').classList.toggle('hidden', S.picks.size < 2);
  }
};
$('pollFromPicks').onclick = () => {
  const ms = [...S.picks].map(movie);
  send({ t: 'poll_create', q: 'What should we watch next?', options: ms.map(m => m.title), srcs: ms.map(m => ({ src: m.src, title: m.title, movieId: m.id })) });
  S.picks.clear(); $('pollFromPicks').classList.add('hidden'); renderMovies(); showTab('polls');
};
['search', 'lenSel', 'decSel', 'sortSel'].forEach(id => $(id).addEventListener('input', renderMovies));
$('genres').onclick = e => { const g = e.target.dataset.g; if (g === undefined) return; S.genre = S.genre === g || !g ? null : g; renderGenres(); renderMovies(); };
function renderGenres() {
  const gs = [...new Set(S.catalog.flatMap(m => m.genres))].sort();
  $('genres').innerHTML = `<span class="chip ${S.genre ? '' : 'on'}" data-g="">All</span>` + gs.map(g => `<span class="chip ${S.genre === g ? 'on' : ''}" data-g="${esc(g)}">${esc(g)}</span>`).join('');
}
fetch('/catalog.json').then(r => r.json()).then(c => {
  S.catalog = c;
  [...new Set(c.filter(m => m.year).map(m => Math.floor(m.year / 10) * 10))].sort().forEach(d => $('decSel').insertAdjacentHTML('beforeend', `<option value="${d}">${d}s</option>`));
  renderGenres(); renderMovies();
});

// ------------------------------------------------------------ playlist
function renderPlaylist() {
  $('plist').innerHTML = S.playlist.length ? S.playlist.map((i, n) => `
    <div class="card"><div class="title">${n === 0 ? '⏭ ' : ''}${esc(i.title)}</div><div class="small muted">added by ${esc(i.by)}</div>
      <div class="acts"><button data-vote="${i.id}">${i.votes.includes(myId) ? '▲ voted' : '▲ vote'} · ${i.votes.length}</button>
      <button data-plplay="${i.id}" ${canControl() ? '' : 'disabled'}>▶ Play</button><button data-plrm="${i.id}" ${canControl() ? '' : 'disabled'}>✕</button></div></div>`).join('')
    : '<div class="muted">Playlist is empty.</div>';
}
$('plist').onclick = e => {
  const d = e.target.dataset;
  if (d.vote) send({ t: 'pl_vote', itemId: d.vote });
  if (d.plplay) send({ t: 'pl_play', itemId: d.plplay });
  if (d.plrm) send({ t: 'pl_remove', itemId: d.plrm });
};
$('urlForm').onsubmit = e => {
  e.preventDefault();
  const u = $('urlIn').value.trim();
  try { new URL(u); } catch { return toast('That is not a valid URL'); }
  send({ t: 'pl_add', src: u, title: decodeURIComponent(u.split('/').pop().split('?')[0]) || u });
  $('urlIn').value = '';
};

// ------------------------------------------------------------ polls
function renderPolls() {
  $('pollList').innerHTML = S.polls.map(p => {
    const counts = p.options.map((_, i) => Object.values(p.votes).filter(v => v === i).length), total = Object.keys(p.votes).length || 1, mine = p.votes[myId];
    return `<div class="card"><div class="title">${esc(p.q)} ${p.open ? '' : '<span class="small muted">(closed)</span>'}</div><div class="small muted">by ${esc(p.by)}</div>
      ${p.options.map((o, i) => `<div><div style="display:flex;justify-content:space-between"><button data-poll="${p.id}" data-idx="${i}" ${p.open ? '' : 'disabled'} style="padding:3px 8px">${mine === i ? '✔ ' : ''}${esc(o)}</button><span class="small">${counts[i]}</span></div>
        <div class="bar"><div style="width:${(counts[i] / total) * 100}%"></div></div></div>`).join('')}
      ${p.open && (me().host || p.by === me().name) ? `<button data-close="${p.id}">Close poll${p.srcs?.length ? ' & queue winner' : ''}</button>` : ''}</div>`;
  }).join('') || '<div class="muted">No polls yet.</div>';
}
$('pollList').onclick = e => {
  const d = e.target.dataset;
  if (d.poll) send({ t: 'poll_vote', pollId: d.poll, idx: +d.idx });
  if (d.close) send({ t: 'poll_close', pollId: d.close });
};
$('pollForm').onsubmit = e => {
  e.preventDefault();
  send({ t: 'poll_create', q: $('pollQ').value, options: $('pollO').value.split(',').map(s => s.trim()).filter(Boolean) });
  $('pollQ').value = $('pollO').value = '';
};

// ------------------------------------------------------------ people / host
function renderPeople() {
  $('people').innerHTML = S.members.map(m => {
    const dc = m.drift == null ? 'var(--muted)' : Math.abs(m.drift) > 500 ? 'var(--bad)' : Math.abs(m.drift) > 150 ? 'var(--warn)' : 'var(--ok)';
    return `<div class="person"><span><span class="dot" style="background:${m.online ? 'var(--ok)' : 'var(--muted)'}"></span> ${m.host ? '👑 ' : ''}${esc(m.name)}${m.id === myId ? ' (you)' : ''}</span>
      <span class="small" style="color:${dc}">${m.online ? (m.buffering ? 'buffering' : m.drift == null ? '' : `${m.drift > 0 ? '+' : ''}${m.drift} ms`) : 'offline'}</span>
      ${me().host && m.id !== myId && m.online ? `<button data-host="${m.id}" class="small">Make host</button>` : ''}</div>`;
  }).join('');
  $('lockRow').classList.toggle('hidden', !me().host);
  $('lockChk').checked = S.locked;
}
$('people').onclick = e => { if (e.target.dataset.host) send({ t: 'host_transfer', to: e.target.dataset.host }); };
$('lockChk').onchange = () => send({ t: 'lock', on: $('lockChk').checked });
function renderAll() { renderPeople(); renderPlaylist(); renderPolls(); renderMovies(); }

// ------------------------------------------------------------ tabs, lobby
function showTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + name));
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
if (/^#(chat|discover|playlist|polls|people)$/.test(location.hash)) showTab(location.hash.slice(1));
$('copyLink').onclick = () => { navigator.clipboard?.writeText(location.origin + '/r/' + S.code); toast('Invite link copied'); };

function enter(code) {
  const name = $('nameIn').value.trim();
  if (!name) return ($('lobbyErr').textContent = 'Enter your name first');
  localStorage.setItem('wpName', name);
  $('lobbyErr').textContent = '';
  wanted = code;
  if (!ws) connect(); else send({ t: 'join', code, id: myId, name });
}
$('createBtn').onclick = () => enter(null);
$('joinBtn').onclick = () => { const c = $('codeIn').value.trim().toUpperCase(); if (c.length !== 6) return ($('lobbyErr').textContent = 'Room codes are 6 characters'); enter(c); };
$('codeIn').onkeydown = e => { if (e.key === 'Enter') $('joinBtn').click(); };
// returning via invite link with a saved name: join straight away
if (inviteCode && $('nameIn').value) enter(inviteCode.toUpperCase());

window.__wp = { S, video, expected, serverNow }; // handle for the automated drift test
