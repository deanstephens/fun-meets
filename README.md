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

### Future milestones
- Interactive zones and objects on the canvas (e.g. proximity-based audio, breakout areas).
- Game mechanics and shared activities layered onto the meeting space.
- Resilience: host re-election if the entry-point peer leaves, and reconnection after transient network drops.

## Tech Stack

- Static HTML / CSS / JavaScript ES modules (no build step)
- WebRTC for peer-to-peer audio/video, via [PeerJS](https://peerjs.com/) (loaded from a CDN)
- Public PeerJS cloud broker for signaling only (no backend we operate)
- Browser `getUserMedia` for webcam + mic capture
- Keyboard input (WASD) for moving webcams around the canvas

## Status

🚧 Early development. Milestones 1–4 complete: movable webcams, an N-peer WebRTC mesh, real-time position sync, and connection-status indicators with optional animated stick-figure bodies.

## Getting Started

Because this is a static app, just serve the project directory with any static file server and open it in a WebRTC-capable browser:

```bash
# any static server works; e.g. with Python:
python3 -m http.server 8000
# then open http://localhost:8000
```

Click **Enable camera & join**, then share the URL (it contains a `?room=...` link, also available via the **Copy invite link** button) with others to bring them into the same room. Note that browsers require a **secure context** for camera access — `localhost` is treated as secure, but a hosted deployment must be served over **HTTPS**.

> **Known limitation:** the public PeerJS broker provides STUN but no TURN server, so peers behind strict (symmetric) NATs may fail to connect directly. Adding a TURN server would resolve this but requires infrastructure.
