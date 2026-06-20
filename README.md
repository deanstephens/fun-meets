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

## Status

🚧 Early development. Milestones 1–17 complete: movable webcams, an N-peer WebRTC mesh, real-time position sync, connection-status indicators with optional animated stick-figure bodies, chat (speech bubbles + side panel), a developer console, avatar customisation (with an image-based clothing wardrobe), emoji effects, a configurable room background, user-chosen display names, face auto-framing, a slash-command actions menu with shared cards, proximity-based spatial audio, huddle/breakout zones, a talking indicator, and screen sharing.

## Getting Started

Because this is a static app, just serve the project directory with any static file server and open it in a WebRTC-capable browser:

```bash
# any static server works; e.g. with Python:
python3 -m http.server 8000
# then open http://localhost:8000
```

Click **Enable camera & join**, then share the URL (it contains a `?room=...` link, also available via the **Copy invite link** button) with others to bring them into the same room. Note that browsers require a **secure context** for camera access — `localhost` is treated as secure, but a hosted deployment must be served over **HTTPS**.

> **Known limitation:** the public PeerJS broker provides STUN but no TURN server, so peers behind strict (symmetric) NATs may fail to connect directly. Adding a TURN server would resolve this but requires infrastructure.
