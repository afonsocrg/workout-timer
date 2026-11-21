# Workout Timer

A small, installable interval timer for workouts. Plain HTML, CSS and JavaScript — no framework, no build step.

## Features

- **Home**: an activity calendar (days with a completed workout are green) and a row of your workouts — tap one to start
- **Workouts** tab: create and edit saved workouts
- **Log** tab: every completed workout, grouped by day
- **Workouts are a list of items**, each one of:
  - **Work** / **Rest**: a single timed step
  - **Intervals**: a list of named work/rest steps repeated for N rounds, with optional rest between rounds — covers 5 × 30s, Tabata, EMOM and circuits (Squats → Rest → Push-ups …)

  Drag the handle to reorder items, or steps inside intervals. Edits are kept as a draft until you tap **Save**.
- **iOS-style scroll wheels** for picking times and round counts
- **Sounds**: a soft chime on each of the last 3 seconds of every interval, a brighter chime on each change, and a finish chime at the end
- Time remaining and expected finish time while running
- **Keeps the screen awake** during a workout (Screen Wake Lock API)
- **Works offline** and installs to the home screen (PWA)

Workouts are stored in the browser's `localStorage`, on the device.

## Run locally

```sh
python3 -m http.server 8737
```

Then open <http://localhost:8737>. Installing and keeping the screen awake need HTTPS (or `localhost`).

## Deploy (Cloudflare Pages)

Connect this repository and use:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `/` |
