// Watch party server: rooms, server-authoritative playback clock, chat, reactions, playlist, polls, host transfer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
const HOST_GRACE_MS = 30000;  // host who drops keeps the crown this long before it passes on
const MAX_MEMBERS = 50;

const server = http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/' || p.startsWith('/r/')) p = '/index.html'; // invite links: /r/CODE
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const rooms = new Map();
const now = () => Date.now();
const uid = () => crypto.randomBytes(4).toString('hex');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const okUrl = s => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };

function newRoom() {
  let code;
  do code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('');
  while (rooms.has(code));
  const room = {
    code, hostId: null, members: new Map(), chat: [], playlist: [], polls: [], locked: false,
    // playback is a clock: position `pos` at server time `at`, advancing while playing
    state: { src: null, title: null, movieId: null, playing: false, pos: 0, at: now(), seq: 0, by: null },
  };
  rooms.set(code, room);
  return room;
}

const send = (ws, m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
const bcast = (room, m) => { const s = JSON.stringify(m); for (const mem of room.members.values()) if (mem.ws && mem.ws.readyState === 1) mem.ws.send(s); };
const memberList = room => [...room.members.values()].map(m => ({ id: m.id, name: m.name, online: !!m.ws, drift: m.drift, buffering: m.buffering, host: m.id === room.hostId }));
const playlistView = room => room.playlist.map(i => ({ ...i, votes: [...i.votes] }));
const pollView = room => room.polls.map(p => ({ ...p, votes: Object.fromEntries(p.votes) }));
const pushMembers = room => bcast(room, { t: 'members', members: memberList(room), locked: room.locked });
const pushPlaylist = room => bcast(room, { t: 'playlist', playlist: playlistView(room) });
const pushPolls = room => bcast(room, { t: 'polls', polls: pollView(room) });
const system = (room, text) => { const m = { t: 'chat', id: uid(), sys: true, text, ts: now() }; room.chat.push(m); room.chat = room.chat.slice(-100); bcast(room, m); };

function position(st, at = now()) { return st.playing ? st.pos + (at - st.at) / 1000 : st.pos; }

function setState(room, patch, by) {
  const st = room.state;
  st.pos = position(st);           // freeze the clock at "now" before changing it
  Object.assign(st, patch, { at: now(), seq: st.seq + 1, by });
  bcast(room, { t: 'state', state: st, serverTime: now() });
}

function loadItem(room, item, by) {
  setState(room, { src: item.src, title: item.title, movieId: item.movieId || null, playing: true, pos: 0 }, by);
  if (item.movieId) room.watched = [...(room.watched || []), item.movieId].slice(-20);
}

function pickNewHost(room) {
  const online = [...room.members.values()].filter(m => m.ws).sort((a, b) => a.joinedAt - b.joinedAt);
  if (!online.length) return;
  room.hostId = online[0].id;
  system(room, `${online[0].name} is now the host`);
  pushMembers(room);
}

const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  let room = null, me = null;
  let tokens = 20, lastRefill = now(); // token bucket: 20 burst, 10 msg/s, protects the room from floods

  ws.on('message', raw => {
    const t = now();
    tokens = Math.min(20, tokens + (t - lastRefill) / 100); lastRefill = t;
    if (tokens < 1) return; tokens--;
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'ping') return send(ws, { t: 'pong', ts: m.ts, server: now() }); // clock sync

    if (m.t === 'join') {
      const id = clean(m.id, 40) || uid();
      room = m.code ? rooms.get(clean(m.code, 6).toUpperCase()) : newRoom();
      if (!room) return send(ws, { t: 'error', msg: 'Room not found. Check the code or create a new room.' });
      me = room.members.get(id);
      if (!me && room.members.size >= MAX_MEMBERS) { room = null; return send(ws, { t: 'error', msg: 'Room is full' }); }
      const rejoin = !!me;
      if (me && me.ws && me.ws !== ws) me.ws.close(4000, 'replaced');
      if (!me) me = { id, joinedAt: now(), drift: null, buffering: false };
      me.name = clean(m.name, 24) || 'Guest';
      me.ws = ws;
      clearTimeout(me.hostTimer);
      room.members.set(id, me);
      if (!room.hostId || !room.members.get(room.hostId)) room.hostId = id;
      // late join / reconnect: full snapshot, the client seeks itself to the live position
      send(ws, { t: 'welcome', you: id, code: room.code, state: room.state, serverTime: now(), chat: room.chat.slice(-50),
        playlist: playlistView(room), polls: pollView(room), members: memberList(room), locked: room.locked, watched: room.watched || [], reactions: room.reactions || [] });
      system(room, `${me.name} ${rejoin ? 'reconnected' : 'joined'}`);
      return pushMembers(room);
    }
    if (!room || !me) return;
    const isHost = me.id === room.hostId;
    const canControl = isHost || !room.locked;

    switch (m.t) {
      case 'control': {
        if (!canControl) return send(ws, { t: 'error', msg: 'The host has locked playback controls' });
        // stale action (user acted on an older state while someone else already changed it): reject, client resyncs
        if (typeof m.seq === 'number' && m.seq < room.state.seq) return send(ws, { t: 'state', state: room.state, serverTime: now(), rejected: true });
        const pos = Math.max(0, Number(m.pos) || 0);
        if (m.action === 'play') setState(room, { playing: true, pos }, me.name);
        else if (m.action === 'pause') setState(room, { playing: false, pos }, me.name);
        else if (m.action === 'seek') setState(room, { pos }, me.name);
        else if (m.action === 'load' && okUrl(m.src)) loadItem(room, { src: m.src, title: clean(m.title, 120) || m.src, movieId: clean(m.movieId, 80) }, me.name);
        return;
      }
      case 'ended': // first client to finish advances the playlist; later reports for the same item are ignored
        if (m.src !== room.state.src || !room.state.playing) return;
        if (room.playlist.length) { loadItem(room, room.playlist.shift(), 'playlist'); pushPlaylist(room); }
        else setState(room, { playing: false, pos: position(room.state) }, 'end');
        return;
      case 'chat': {
        const text = clean(m.text, 500);
        if (!text) return;
        const msg = { t: 'chat', id: uid(), from: me.name, uid: me.id, text, ts: now() };
        room.chat.push(msg); room.chat = room.chat.slice(-100);
        return bcast(room, msg);
      }
      case 'react': {
        const emoji = clean(m.emoji, 8);
        if (!emoji || !room.state.src) return;
        const r = { t: 'react', emoji, from: me.name, at: Number(m.at) || position(room.state), src: room.state.src };
        room.reactions = [...(room.reactions || []), r].slice(-300); // kept so late joiners see the reaction timeline
        return bcast(room, r);
      }
      case 'pl_add':
        if (!okUrl(m.src) || room.playlist.length >= 100) return;
        room.playlist.push({ id: uid(), src: m.src, title: clean(m.title, 120) || m.src, movieId: clean(m.movieId, 80), by: me.name, votes: new Set([me.id]) });
        return pushPlaylist(room);
      case 'pl_vote': {
        const item = room.playlist.find(i => i.id === m.itemId);
        if (!item) return;
        item.votes.has(me.id) ? item.votes.delete(me.id) : item.votes.add(me.id);
        room.playlist.sort((a, b) => b.votes.size - a.votes.size); // most wanted plays next
        return pushPlaylist(room);
      }
      case 'pl_remove':
        if (!canControl) return;
        room.playlist = room.playlist.filter(i => i.id !== m.itemId);
        return pushPlaylist(room);
      case 'pl_play': {
        if (!canControl) return;
        const i = room.playlist.findIndex(x => x.id === m.itemId);
        if (i < 0) return;
        loadItem(room, room.playlist.splice(i, 1)[0], me.name);
        return pushPlaylist(room);
      }
      case 'poll_create': {
        const options = (Array.isArray(m.options) ? m.options : []).map(o => clean(o, 80)).filter(Boolean).slice(0, 6);
        if (options.length < 2) return send(ws, { t: 'error', msg: 'A poll needs at least 2 options' });
        room.polls.unshift({ id: uid(), q: clean(m.q, 140) || 'Quick poll', options, srcs: Array.isArray(m.srcs) ? m.srcs.slice(0, 6) : [], by: me.name, open: true, votes: new Map() });
        room.polls = room.polls.slice(0, 10);
        system(room, `${me.name} started a poll: ${room.polls[0].q}`);
        return pushPolls(room);
      }
      case 'poll_vote': {
        const p = room.polls.find(x => x.id === m.pollId);
        if (!p || !p.open || !(m.idx >= 0 && m.idx < p.options.length)) return;
        p.votes.set(me.id, m.idx);
        return pushPolls(room);
      }
      case 'poll_close': {
        const p = room.polls.find(x => x.id === m.pollId);
        if (!p || !p.open || !(isHost || p.by === me.name)) return;
        p.open = false;
        const counts = p.options.map((_, i) => [...p.votes.values()].filter(v => v === i).length);
        const win = counts.indexOf(Math.max(...counts));
        system(room, `Poll closed: "${p.q}". Winner: ${p.options[win]} (${counts[win]} votes)`);
        if (p.srcs[win] && okUrl(p.srcs[win].src)) { room.playlist.unshift({ id: uid(), ...p.srcs[win], by: 'poll', votes: new Set() }); pushPlaylist(room); }
        return pushPolls(room);
      }
      case 'host_transfer': {
        const to = room.members.get(m.to);
        if (!isHost || !to || !to.ws) return;
        room.hostId = to.id;
        system(room, `${me.name} handed host to ${to.name}`);
        return pushMembers(room);
      }
      case 'lock':
        if (!isHost) return;
        room.locked = !!m.on;
        system(room, `Playback controls ${room.locked ? 'locked to host' : 'open to everyone'}`);
        return pushMembers(room);
      case 'report': // each client's measured drift, shown to everyone
        me.drift = Number.isFinite(m.drift) ? Math.round(m.drift) : null;
        me.buffering = !!m.buffering;
        return;
    }
  });

  ws.on('close', () => {
    if (!room || !me || me.ws !== ws) return;
    me.ws = null;
    system(room, `${me.name} left`);
    pushMembers(room);
    if (me.id === room.hostId) me.hostTimer = setTimeout(() => { if (!me.ws && room.hostId === me.id) pickNewHost(room); }, HOST_GRACE_MS);
    const r = room;
    setTimeout(() => { if (![...r.members.values()].some(x => x.ws)) rooms.delete(r.code); }, 10 * 60000); // empty room expires
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
  for (const room of rooms.values()) pushMembers(room); // refresh drift/buffering badges
}, 2000);

server.listen(PORT, () => console.log(`watch party on http://localhost:${PORT}`));
module.exports = { server, rooms };
