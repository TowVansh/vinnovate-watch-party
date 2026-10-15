# Couch Sync: a real-time watch party

Couch Sync lets a group watch the same video together, with playback kept in sync across everyone. You can create a room, share the link, and watch with chat, emoji reactions, a voted playlist, group polls and a movie discovery panel. The catalog has 42 public-domain films and cartoons from the Internet Archive, and you can also paste any `.mp4`/`.webm` URL.

```
npm install
npm start          # http://localhost:3000
npm test           # protocol checks + 10-user propagation latency
npm test -- --drift   # also drift with 3 real headless Chrome viewers (needs Chrome + internet)
```

To try it on a LAN, open `http://<your-ip>:3000` on other devices. Click **Create a room**, then **Copy invite link**. A friend who opens `/r/CODE` joins directly.

## Features

| Requirement | How |
|---|---|
| Create/join via invite link or code | 6-character room codes. Invite links are `/r/CODE`. A returning user with a saved name auto-joins. |
| Sync play / pause / seek | The server holds the playback **clock** `{pos, at, playing, seq}`. Every action freezes the clock and broadcasts it, and each client computes `expected = pos + (serverNow - at)` itself. |
| Movie recommendations with categories, filters, fuzzy search | Genre chips, length (shorts/features), decade, and sort (for this room / popular / oldest / newest). The fuzzy search tolerates typos (Levenshtein ≤1–2, e.g. "chapln", "hauntd") and subsequences, and weights title > genre/decade > description. **"For this room"** ranks by the genres the room has watched (×2) and queued (×1), and explains each pick ("Because you watched Elephants Dream (Animation, Short)"). |
| Emoji reactions | They float over the video with the sender's name. They are also pinned to the **video timestamp** and drawn on the seek bar, giving a reaction timeline that late joiners see too. |
| Live chat | Includes system messages for joins, leaves, host changes and polls. The last 50 messages are replayed to anyone who joins. |
| Shared playlist | Anyone can add an item. Votes reorder it (most-wanted plays next). When a video ends the top item starts for everyone, and it advances once even though every client reports the end. |
| Group polls | You can make a free-form poll, or tick 2–4 movies in Discover and start a **"what next?"** poll. Closing it queues the winning movie at the top of the playlist. |
| Host transfer | The host can hand the 👑 to anyone. If the host disconnects, they keep it for 30 s (in case it is just a reload), then it passes to the longest-present member. The host can **lock controls** so only the host can play/pause/seek. |
| Drift detection + correction | See below. Every viewer's live drift and buffering state appears in **People**. |
| Late joins, reconnections, concurrent actions | See *Failure handling*. |

## How sync works

1. **Clock sync (NTP style):** each client pings the server 5 times on connect and every 10 s after that. It keeps the offset from the lowest-RTT sample of the last 10, and `serverNow() = Date.now() + offset`.
2. **Authoritative clock:** a control message goes to the server, which sets `pos = position at now`, applies the change, sets `at = now`, increments `seq` and broadcasts. The server does no video work, so nothing on the server can drift.
3. **Correction loop (every 250 ms on each client):** `drift = video.currentTime - expected`.
   - |drift| > 400 ms, or paused and > 150 ms: **hard seek** to the expected position.
   - 50–400 ms while playing: **nudge** `playbackRate` within 0.85–1.15 to converge smoothly, with no visible jump.
   - Under 50 ms: rate 1.0.
   - Each client reports its drift and buffering state every second, and the room shows them.

## Latency measurements

**Test conditions:** Windows 10 laptop, Node 24, headless Chrome 155.0.8059.40, server and clients on the same machine (localhost). Video: *Popeye for President* (6 min, 512 kb/s MP4) streamed from archive.org over campus Wi-Fi.

| Metric | Constraint | Measured |
|---|---|---|
| Play/pause/seek propagation to **all 10 users** in one room, 2000 deliveries | p95 ≤ 250 ms | **p50 0.65 ms, p95 1.63 ms, max 3.4 ms** |
| Playback drift after correction, 3 real Chrome viewers, seeks + pause/play during the run, sampled 2.5 s after each action | ≤ 500 ms | **p50 40 ms, p95 88 ms, max 154 ms** (an earlier run with the old 1 s seek threshold gave p95 604 ms, which is why the threshold is 400 ms) |
| Concurrent users | ≥ 10 per room | tested with 10. The hard limit is 50 per room (`MAX_MEMBERS`). |

Notes:
- Localhost numbers leave out Wi-Fi time. On a LAN, add the network RTT, typically 2–20 ms, which is still far under 250 ms. The header pill **"control N ms"** shows the real one-way time for each action (`serverNow - state.at`), so you can check it on any network.
- Drift is measured when the viewer is not buffering. While buffering, the pill says "buffering…" and the seek is redone as soon as data arrives.

## Failure handling

- **Late join:** the welcome message carries the full snapshot: clock, playlist, polls, people, last 50 chat messages and reactions. The client seeks itself to the live position.
- **Reconnects:** both sides use exponential backoff (0.3 s up to 5 s). A stable per-browser id means a reconnect is the same member: same host status, same votes, no duplicate. Opening the room in a second tab cleanly replaces the first (close code 4000).
- **Concurrent actions:** each control carries the `seq` the user saw. If someone else already changed the state, the action is **rejected** and the user gets a toast ("someone changed playback first") plus the current state. Last valid write wins, and nobody's player fights another's.
- **Dead connections:** a 2 s ping/pong heartbeat terminates silent sockets, so people show as offline quickly.
- **Host disappears:** 30 s grace, then automatic host transfer. Empty rooms expire after 10 minutes.
- **Autoplay blocked by the browser:** a "▶ Join playback" overlay appears, and one click resyncs.
- **Abuse and validation:** a token bucket rate limit (10 msg/s, burst 20) per socket. Lengths are capped on names, chat and titles. Only `http(s)` URLs are accepted (no `javascript:`). All user text is HTML-escaped on render.

## Structure

```
server.js            rooms, playback clock, chat/reactions/playlist/polls/host, heartbeat, rate limit
public/index.html    UI (lobby + room), responsive down to phone width
public/app.js        clock sync, drift loop, discovery (fuzzy search, filters, recommendations), all panels
public/catalog.json  42 public-domain films/cartoons (Internet Archive), with genres, year, length and popularity rank
test.js              protocol tests + latency/drift measurements
```

Tech stack: Node.js with `ws` (the only dependency), plain HTML/JS, and the HTML5 `<video>` element, which gives the precise `currentTime` and `playbackRate` control needed for drift correction.
