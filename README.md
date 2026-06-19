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

> **Note on signaling:** WebRTC requires a signaling step to exchange connection metadata (SDP offers/answers and ICE candidates) before a peer connection is established. Because there is no application server, signaling will be handled without a dedicated backend — for example via manual copy/paste of connection codes, a shareable link, or a serverless/public signaling mechanism. The design goal is to keep the app fully static with no server we operate.

## Roadmap

### Milestone 1 — Movable webcams (initial)
- Each participant can see their own webcam feed on a shared screen/canvas.
- Each participant can **move their own webcam around the screen using the WASD keys**.
- Peer connections established over WebRTC so participants can see each other.

### Future milestones
- Real-time position sync so everyone sees where everyone else is.
- Interactive zones and objects on the canvas (e.g. proximity-based audio, breakout areas).
- Game mechanics and shared activities layered onto the meeting space.
- Polished signaling/join flow that keeps the app fully serverless.

## Tech Stack

- Static HTML / CSS / JavaScript (no build server required)
- WebRTC for peer-to-peer audio/video
- Browser `getUserMedia` for webcam capture
- Keyboard input (WASD) for moving webcams around the canvas

## Status

🚧 Early development. Starting with Milestone 1.

## Getting Started

> Setup instructions will be added as the project takes shape. Because this is a static app, running it will be as simple as serving the project directory with any static file server and opening it in a WebRTC-capable browser.
