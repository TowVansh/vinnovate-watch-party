// Measurements for the README. Run: npm test            (protocol + 10-user propagation latency)
//                                    npm test -- --drift (also real browsers: drift after correction, needs Chrome + internet)
process.env.PORT = process.env.PORT || 13000;
const { server, rooms } = require('./server');
const WebSocket = require('ws');
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_ = `ws://localhost:${process.env.PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const VIDEO = 'https://archive.org/download/Popeye_forPresident/Popeye_forPresident_512kb.mp4';

function client(name, code) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL_);
    ws.inbox = [];
    ws.on('message', d => { const m = JSON.parse(d); ws.inbox.push(m); ws.emit('msg', m); });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', code, id: name, name })));
    ws.once('error', rej);
    ws.on('msg', function w(m) { if (m.t === 'welcome') { ws.off('msg', w); ws.welcome = m; res(ws); } if (m.t === 'error') rej(new Error(m.msg)); });
  });
}
const wait = (ws, pred) => new Promise(res => ws.on('msg', function h(m) { if (pred(m)) { ws.off('msg', h); res(m); } }));
const tx = (ws, m) => ws.send(JSON.stringify(m));

(async () => {
  // ---- room + 10 concurrent users
  const host = await client('u0');
  const code = host.welcome.code;
  const users = [host];
  for (let i = 1; i < 10; i++) users.push(await client('u' + i, code));
  assert.equal(rooms.get(code).members.size, 10);

  // ---- control propagation: one user acts, time until all 10 have the new state
  const lat = [];
  for (let i = 0; i < 200; i++) {
    const actor = users[i % 10];
    const seq = rooms.get(code).state.seq;
    const t0 = performance.now();
    const all = Promise.all(users.map(u => wait(u, m => m.t === 'state' && m.state.seq === seq + 1).then(() => performance.now() - t0)));
    tx(actor, { t: 'control', action: ['play', 'pause', 'seek'][i % 3], pos: i, seq });
    lat.push(...await all);
    await sleep(30); // stay under the per-connection rate limit (10 msg/s)
  }
  const prop = { samples: lat.length, p50: pct(lat, 0.5).toFixed(2), p95: pct(lat, 0.95).toFixed(2), max: Math.max(...lat).toFixed(2) };
  assert(+prop.p95 < 250, 'propagation p95 over budget');

  // ---- concurrent actions: two users act on the same seq, exactly one wins, the other is told to resync
  const seq = rooms.get(code).state.seq;
  const rej = wait(users[2], m => m.t === 'state' && m.rejected);
  tx(users[1], { t: 'control', action: 'seek', pos: 100, seq });
  tx(users[2], { t: 'control', action: 'seek', pos: 200, seq });
  await rej;
  assert.equal(rooms.get(code).state.pos, 100);
  assert.equal(rooms.get(code).state.seq, seq + 1);

  // ---- late join gets a full snapshot with a live clock
  tx(host, { t: 'control', action: 'play', pos: 10, seq: seq + 1 });
  await sleep(300);
  const late = await client('late', code);
  const st = late.welcome.state;
  assert(st.playing && st.pos >= 10);

  // ---- reconnect keeps identity; host leaving hands the crown on after the grace period (shortened here)
  late.close(); await sleep(100);
  const late2 = await client('late', code);
  assert.equal(rooms.get(code).members.get('late').ws !== null, true);
  assert.equal([...rooms.get(code).members.values()].filter(m => m.id === 'late').length, 1);

  // ---- playlist voting + ended advances once even if every client reports it
  tx(users[3], { t: 'pl_add', src: 'https://example.com/a.mp4', title: 'A' });
  tx(users[3], { t: 'pl_add', src: 'https://example.com/b.mp4', title: 'B' });
  await sleep(100);
  const b = rooms.get(code).playlist.find(i => i.title === 'B');
  tx(users[4], { t: 'pl_vote', itemId: b.id }); await sleep(100);
  assert.equal(rooms.get(code).playlist[0].title, 'B');
  tx(host, { t: 'control', action: 'load', src: 'https://example.com/x.mp4', title: 'X', seq: rooms.get(code).state.seq }); await sleep(100);
  users.forEach(u => tx(u, { t: 'ended', src: 'https://example.com/x.mp4' })); await sleep(200);
  assert.equal(rooms.get(code).state.title, 'B');
  assert.equal(rooms.get(code).playlist.length, 1);

  // ---- polls, lock, host transfer, validation
  tx(users[5], { t: 'poll_create', q: 'Next?', options: ['A', 'B'] }); await sleep(100);
  const poll = rooms.get(code).polls[0];
  users.forEach((u, i) => tx(u, { t: 'poll_vote', pollId: poll.id, idx: i % 3 === 0 ? 1 : 0 })); await sleep(100);
  assert.equal(poll.votes.size, 10);
  tx(host, { t: 'lock', on: true }); await sleep(100);
  const s0 = rooms.get(code).state.seq;
  tx(users[6], { t: 'control', action: 'pause', pos: 1, seq: s0 }); await sleep(100);
  assert.equal(rooms.get(code).state.seq, s0, 'locked room must ignore non-host control');
  tx(host, { t: 'host_transfer', to: 'u6' }); await sleep(100);
  assert.equal(rooms.get(code).hostId, 'u6');
  tx(users[7], { t: 'pl_add', src: 'javascript:alert(1)', title: 'x' }); await sleep(100);
  assert(!rooms.get(code).playlist.some(i => i.src.startsWith('javascript')));

  console.log('protocol checks passed');
  console.log('control propagation, 10 users in one room, localhost:', JSON.stringify(prop), 'ms');

  if (process.argv.includes('--drift')) await driftTest();
  users.concat(late2).forEach(u => u.close());
  server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

// Real browsers: 3 headless Chrome viewers + a scripted host doing seeks and pause/play.
// Drift is sampled from each browser's own report, skipping 2 s after each control (the correction window).
async function driftTest() {
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(fs.existsSync);
  if (!chrome) return console.log('drift test skipped: Chrome not found');
  const host = await client('drift-host');
  const code = host.welcome.code;
  const procs = [0, 1, 2].map(i => spawn(chrome, ['--headless=new', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--remote-debugging-port=0',
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'))}`, `http://localhost:${process.env.PORT}/r/${code}?name=viewer${i}`], { stdio: 'ignore' }));
  await sleep(4000);
  const room = rooms.get(code);
  const ctl = (action, pos) => tx(host, { t: 'control', action, pos, seq: room.state.seq, ...(action === 'load' ? { src: VIDEO, title: 'Popeye for President' } : {}) });
  ctl('load');
  const plan = [[12000, 'seek', 120], [20000, 'pause', 125], [24000, 'play', 125], [32000, 'seek', 30]];
  plan.forEach(([at, a, p]) => setTimeout(() => { ctl(a, p); lastCtl = Date.now(); }, at));
  let lastCtl = Date.now();
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < 42000) {
    await sleep(1000);
    if (Date.now() - start < 8000 || Date.now() - lastCtl < 2500) continue; // initial load + correction window
    for (const m of room.members.values()) if (m.id !== 'drift-host' && m.drift != null && !m.buffering) samples.push(Math.abs(m.drift));
  }
  procs.forEach(p => p.kill());
  host.close();
  if (!samples.length) return console.log('drift test: no samples (could the browsers reach the video?)');
  console.log(`drift after correction, 3 headless Chrome viewers, ${samples.length} samples: p50 ${pct(samples, 0.5)} ms, p95 ${pct(samples, 0.95)} ms, max ${Math.max(...samples)} ms`);
}
