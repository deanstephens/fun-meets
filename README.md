# Fun Meets

A serverless, peer-to-peer video meeting application that turns online meetings into an interactive, game-like experience.

## Vision

Most video meeting tools (Google Meet, Zoom, etc.) are static grids of faces. **Fun Meets** reimagines the online meeting as a shared, playful space. Participants don't just sit in boxes — they inhabit a canvas they can move around in, interact with, and (over time) play in.

The long-term direction is to grow the meeting from "a call you can move your webcam around in" into a rich, game-like environment with mechanics, interactions, and shared activities layered on top of real-time video.

## Core Principles

- **Static web application** — the entire app is served as static files (HTML/CSS/JS). It can be hosted anywhere static files can live (GitHub Pages, Netlify, S3, etc.).
- **No backend server** — there is no application server handling meeting logic, media, or state. Media flows directly between peers.
- **WebRTC peer-to-peer** — audio/video is exchanged directly between participants' browsers using [WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API).
- **Game-like and interactive** — the meeting surface is a playable space, not a fixed grid. This is the feature that will be developed and expanded over time.

> **Note on signaling:** WebRTC requires a signaling step to exchange connection metadata (SDP offers/answers and ICE candidates) before a peer connection is established. Because there is no application server we operate, signaling runs over the **public [PeerJS](https://peerjs.com/) cloud broker** — a free third-party service used only to introduce peers. Once connected, all audio/video flows directly peer-to-peer with no relay. This keeps the app fully static (served as plain files) with no backend of our own.

## How it works

- Each participant joins a **room** (identified by a `?room=<name>` URL parameter; one is generated and added to the URL if absent — share that link to invite others).
- The first participant in a room claims a well-known id derived from the room name and acts as the **entry point**; everyone else bootstraps off it.
- Peers then exchange rosters and dial each other to form a **full mesh** — every participant holds a direct WebRTC connection to every other participant. This supports **N participants**, not just two.
- A direct connection per pair carries both audio and video. Peers that drop (leave, crash, or lose the network) are detected via ICE connection state and removed.

## Roadmap

### Milestone 1 — Movable webcams ✅
- Each participant sees their own webcam feed on a shared stage.
- Each participant can **move their own webcam around the screen using the WASD keys**.

### Milestone 2 — N-peer WebRTC mesh ✅
- Participants join a shared room and connect over WebRTC.
- Full mesh supporting an arbitrary number of participants (not just 2).
- Live audio + video between all peers; automatic cleanup when a peer leaves.

### Milestone 3 — Position sync ✅
- Each peer broadcasts its tile position over the data channels, so everyone
  sees where everyone else's webcam is on the stage in real time.
- Positions are sent as normalized (0–1) coordinates, so they map correctly
  between participants whose windows are different sizes.
- New joiners are sent everyone's current position immediately on connect.

### Milestone 4 — Connection status + animated bodies ✅
- A per-peer status dot (connecting / connected / failed) on every remote tile,
  so a connection that can't be established (e.g. a NAT/firewall failure) is
  shown rather than silently missing.
- An optional stick-figure body under each webcam that animates a walking gait
  as that participant moves around the stage — driven by their position
  updates, so you see everyone else walking too. Toggle with **Hide/Show bodies**.

### Milestone 5 — Chat: speech bubbles + side panel ✅
- Press **Enter** to type a message and Enter again to send it; it appears as a
  speech bubble floating above your head and is broadcast to everyone.
- Messages from other participants pop up as bubbles above their tiles, and
  fade after a few seconds.
- A **persistent, collapsible chat panel** on the right keeps the full message
  history. Collapse it to a tab (with an unread badge); press Enter to reopen
  and focus it.
- Typing into the chat box never drives your avatar, and movement resumes the
  moment you send (or press Escape).

### Milestone 6 — Developer console ✅
- A toggleable developer console in the right sidebar, sharing the space with
  chat but collapsed independently. Shows your connection id and role, the
  room, the live list of connected peers with their status, and a stream of
  the mesh log — making connection issues easy to inspect.

### Milestone 7 — Avatar customisation ✅
- Customise your avatar from a toggleable sidebar section, with independent
  slots for **hat**, **body**, **legs** and **feet** (e.g. a pirate hat, cat
  ears, a round non-stick body, shoes).
- Your look is broadcast to everyone and shown on your tile for all peers; new
  joiners receive it on connect. Choices persist across reloads.

### Milestone 8 — Emojis ✅
- Three ways to throw emoji around, all visible to everyone:
  - **Shower** — press number keys **1–9** to burst the bound emoji around you.
  - **Throw** — **click** the stage to launch your selected emoji toward the cursor.
  - **Trail** — toggle it on to leave a stream of emoji behind you as you move.
- Pick the throw/trail emoji from a palette in a toggleable Emojis sidebar
  section; choices persist across reloads.

### Milestone 9 — Room background ✅
- Change the shared room background from a toggleable Background sidebar
  section: preset **colours**, **patterns** (dots/grid/stripes/checker), an
  **image URL**, or an **uploaded image** (downscaled in-browser).
- The background is room-shared — changes broadcast to everyone, and the host
  hands the current background to new joiners so they match.

### Milestone 10 — Image-based avatar wardrobe ✅
- The avatar's clothing now uses pre-made PNG art overlaid on the stick figure:
  **7 hats**, **13 tops** (casual + fantasy armor), **4 leg styles**, **4 shoes**.
- Hats are large PNGs (the pirate hat spans most of the head). Tops keep the
  arms separate so they still swing, and each trouser is split into a left and
  right leg so the legs swing in the walk cycle. Looks sync to all peers.

### Milestone 11 — Usernames ✅
- Pick a display name on the join screen (pre-filled with a random friendly
  name, remembered across reloads). It shows on your tile to others, in chat,
  speech bubbles, and the dev console peer list.
- The name is shared with the room and sent to new joiners; names are
  sanitised and length-capped, and treated as untrusted when received.

### Milestone 12 — Face auto-framing ✅
- Optionally centre and zoom the camera on your face so it fills the circular
  head. Face detection runs in-browser (MediaPipe, loaded from a CDN); the
  framed video is rendered to a canvas and that stream is what's shown and sent
  to peers, so everyone sees your centred face. Toggleable, smoothed, and falls
  back to a plain centre-crop if no face is found or the model can't load.

### Milestone 13 — Actions menu + cards ✅
- Press <kbd>/</kbd> to open an **actions menu**; type to filter the actions by
  prefix, then run one with Enter or a click. Built on a small action registry
  so more actions can be added easily.
- First action **create-card**: drops an editable sticky **card on the board
  where you're standing**. Cards (and their text) are shared with everyone and
  sent to new joiners.

### Milestone 14 — Proximity-based spatial audio ✅
- Each remote participant's volume scales with the distance between your avatars
  on the board — walk up to someone to hear them, drift away and they fade out.
  Pure client-side WebAudio (a gain node per peer driven by the synced
  positions); toggleable, with a graceful fallback to full volume.

### Milestone 15 — Huddle / breakout zones ✅
- Drop a **huddle zone** (an action): people inside a zone hear each other
  clearly while everyone outside is muffled — serverless breakout rooms layered
  on the spatial audio. The zone you're in is highlighted, zones sync to all
  peers and to new joiners, and a clear-zones action removes them.

### Milestone 16 — Talking indicator ✅
- A green ring lights up around whoever is speaking — for you and every remote
  participant. Each audio stream is analysed locally with a WebAudio analyser
  (no extra bandwidth), with a threshold + hold so it doesn't flicker between
  words.

### Milestone 17 — Screen sharing ✅
- Share a screen or window (**Share screen** in the topbar); it appears as a
  large screen panel at the top of the board that everyone can gather around,
  labelled with the sharer. Sent over a separate WebRTC media call (so it's
  independent of the webcam), reaches late joiners, and clears for everyone when
  you stop.

### Milestone 18 — Avatar calibration mode (dev tooling) ✅
- A developer-only calibration mode (`?calibrate=1`) to fine-tune the per-outfit
  offset/scale of each avatar part with live preview — and, for tops, the
  **shoulder (arm pivot) position** so the arms come out of each top's
  armholes. **Export** the adjustments to JSON and apply them back into the repo
  with `node scripts/apply-avatar-positions.js <file>` (writing
  `avatar-positions.js`, the committed source of truth that `avatar.js` reads at
  runtime). Hidden and no-op for normal users.

### Milestone 19 — Articulated arms (elbow joint) ✅
- Each arm is now two segments — an **upper arm** and a **forearm** hinged at an
  **elbow** — so the elbows bend as the arms pump during the walk cycle. Standing
  still looks exactly as before (straight arms). The elbow position and resting
  angle are calibratable per-top alongside the shoulders (see the calibration
  mode).

### Milestone 20 — Save & restore the board ✅
- The shared board (background, cards, huddle zones) is snapshotted to
  `localStorage` per room, so a room **survives everyone leaving** — when the
  host returns to that room it restores automatically. Still fully serverless.
- Two actions (the `/` menu): **Save board to file** downloads a JSON snapshot,
  and **Load board from file** restores one and shares it with everyone in the
  room.

### Milestone 21 — Host re-election ✅
- The well-known "host" id is now a pure **introducer** decoupled from mesh
  identity, so when the host leaves a remaining peer takes it over (the lowest-id
  survivor) and becomes the new entry point and state distributor — **new
  participants can still join and receive the current board** after the original
  host is gone. A lightweight host heartbeat detects departures without waiting
  on the slow WebRTC ICE timeout. Existing peers keep their direct connections
  throughout (no identity migration, no reconnect).

### Milestone 22 — Reconnection after transient drops ✅
- A brief media-connection blip (ICE `disconnected`/`failed`) no longer removes a
  peer. The tile shows a **reconnecting** state (dimmed, amber dot) while ICE is
  given a grace window to self-heal — and on an outright failure we **re-dial**
  with backoff — recovering the peer if the network comes back. Only if it can't
  recover within the window is the peer finally dropped. (A clean leave still
  removes the peer immediately.)

### Milestone 23 — Settings moved to a side panel ✅
- The configuration toggles (**Hide bodies**, **Auto-frame**, **Spatial audio**)
  moved off the crowded top bar into a dedicated **Settings** section in the
  right sidebar. The top bar keeps room status, the invite link, and **Share
  screen** (an action rather than a setting).

### Milestone 24 — Card upgrades (move, delete, recolour, author) ✅
- Cards now have a header that doubles as a **drag handle** — drag them around
  the board — plus a **delete** button, a row of **colour** swatches (sticky-note
  yellow / pink / green / blue / purple), and the **author**'s name. Every op
  (move / delete / recolour) syncs to all peers and to late joiners over the
  existing card channel, and is saved with the board.

### Milestone 25 — Carry a card with your avatar ✅
- Stand next to a card and press **E** to pick it up; it's held **out to the
  side you're facing**, and the avatar's **arms reach out to grip it** (the arm
  swing stops while carrying). Move around (WASD) and the card travels with you,
  flipping sides as you turn. Press **E** again to drop it where you are.
- The held state — position, the shrunk "hand-held" card, and the holding arm
  pose — syncs to everyone and late joiners; dropped position is saved with the
  board.

### Milestone 26 — Emotes ✅
- Three one-shot avatar animations from the `/` actions menu — **Wave**, **Jump**
  and **Dance** — broadcast so everyone sees your avatar play them. The head
  always animates (so they read even with bodies hidden), with arm/body motion
  when the stick figure is shown. Rate-limited on send and receive; unknown
  emotes are ignored.

### Milestone 27 — Dice & random picker ✅
- Two actions in the `/` menu: **Roll a die** (1–6, shown as the die face) and
  **Pick someone** (randomly picks a connected participant — "who's next?"). The
  person who triggers it computes the single result and broadcasts it, so
  **everyone sees the same outcome** as a shared toast banner. Rate-limited;
  invalid results ignored on receive.

### Milestone 28 — Shared countdown timer ✅
- Start a shared countdown from the `/` menu (**Timer: 1 / 2 / 5 min**, plus
  **Stop timer**) — a pill at the top counts down the same for **everyone**.
  Late joiners pick up the remaining time, and it ends with a flashing
  **"Time's up!"** cue and a short chime. Broadcasts the remaining seconds (not
  an absolute time) so it works without synchronised clocks.

### Milestone 29 — Polls ✅
- **Create poll** (a `/` action) opens a form for a question + 2–4 options;
  everyone gets a live results panel with vote bars. Click an option to vote
  (one vote each — re-voting moves it); counts update for everyone in real time.
  Late joiners receive the current question and tally; **Close poll** ends it for
  all.

### Future milestones
- More actions; move/delete cards. Mini-games, emotes, and more (see the open issues).
- Game mechanics and shared activities layered onto the meeting space.
- Resilience: host re-election if the entry-point peer leaves, and reconnection after transient network drops.

## Tech Stack

- Static HTML / CSS / JavaScript ES modules (no build step)
- WebRTC for peer-to-peer audio/video, via [PeerJS](https://peerjs.com/) (loaded from a CDN)
- Public PeerJS cloud broker for signaling only (no backend we operate)
- Browser `getUserMedia` for webcam + mic capture
- Keyboard input (WASD) for moving webcams around the canvas
- Optional Node dev scripts to serve over HTTPS and run a local PeerJS broker on your LAN (see _Running locally over HTTPS_)

## Status

🚧 Early development. Milestones 1–29 complete: movable webcams, an N-peer WebRTC mesh, real-time position sync, connection-status indicators with optional animated stick-figure bodies (with articulated arms/elbows), chat (speech bubbles + side panel), a developer console, avatar customisation (with an image-based clothing wardrobe and a dev calibration mode), emoji effects, a configurable room background, user-chosen display names, face auto-framing, a slash-command actions menu with shared cards, proximity-based spatial audio, huddle/breakout zones, a talking indicator, screen sharing, a board that survives everyone leaving (saved per room + file export/import), host re-election when the entry-point peer leaves, and reconnection that rides out transient network blips.

## Getting Started

Because this is a static app, just serve the project directory with any static file server and open it in a WebRTC-capable browser:

```bash
# any static server works; e.g. with Python:
python3 -m http.server 8000
# then open http://localhost:8000
```

Click **Enable camera & join**, then share the URL (it contains a `?room=...` link, also available via the **Copy invite link** button) with others to bring them into the same room. Note that browsers require a **secure context** for camera access — `localhost` is treated as secure, but a hosted deployment must be served over **HTTPS**.

> **Known limitation:** the public PeerJS broker provides STUN but no TURN server, so peers behind strict (symmetric) NATs may fail to connect directly. Adding a TURN server would resolve this but requires infrastructure.

### Running locally over HTTPS on your LAN (optional)

The app itself is just static files and uses the **public PeerJS cloud broker** by
default — none of the below is needed to use it. But to test from other devices
on your network (phones, other laptops) you need **HTTPS** (camera, screen share
and `wss://` all require a secure context), and you can optionally run your own
signaling broker so nothing touches the cloud. Bundled dev scripts handle both
(they require Node + a one-time `npm install`):

```bash
npm install        # one-time: installs the dev-only tooling (peer, selfsigned)
npm run certs      # generate a self-signed cert into .certs/
                   #   (SAN covers localhost, 127.0.0.1, and your LAN IP)
npm run dev        # start the HTTPS app server (:8443) + a local PeerJS broker (:9100)
```

(Or run them separately: `npm run serve` and `npm run broker`. `PORT`,
`BROKER_PORT` and `BROKER_PATH` env vars override the defaults.)

Then, on each device:

1. Open **`https://<your-lan-ip>:8443/`** and **accept the self-signed cert
   warning** (Chrome: type `thisisunsafe` on the warning page; Safari: *Show
   Details → visit this website*). This is a one-time step per device.
2. **To also use your local broker** (instead of the public cloud one) add
   **`?broker=local`** to the URL — e.g. `https://<your-lan-ip>:8443/?room=demo&broker=local`.
   The first time, also visit **`https://<your-lan-ip>:9100/myapp`** once and
   accept that cert too, otherwise the browser silently blocks the `wss://`
   connection. `?broker=local` points the app at a broker on the same host,
   port `9100`, path `/myapp` — matching `npm run broker`.

> These scripts are **development-only** (the `.certs/` directory is gitignored).
> A real deployment just hosts the static files (e.g. GitHub Pages) and uses the
> public broker — no server of ours, consistent with the project's principles.
