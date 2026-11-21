# Workout Timer

A small, installable interval timer for workouts. Plain HTML, CSS and JavaScript — no framework, no build step.

## Features

- **Home**: an activity calendar (days with a completed workout are green) and a row of your workouts — tap one to start
- **Workouts** tab: create, edit, reorder, duplicate (⋯ menu) and delete workouts
- **Log** tab: every completed workout, grouped by day
- **Import / export** a workout (⋯ menu, and the import button on Workouts) or the whole log (⋯ on Log) as a JSON file; imported log entries are merged in
- **Workouts are a list of items**, each one of:
  - **Work** / **Rest**: a single timed step. A Work step can count **reps** instead (switch Time → Reps in its picker): the run shows the rep count and waits for you to tap **Done**. Its expected time only feeds the workout's estimated length
  - **Intervals**: a list of named work/rest steps repeated for N rounds, with optional rest between rounds — covers 5 × 30s, Tabata, EMOM and circuits (Squats → Rest → Push-ups …)

  Drag the handle to reorder items, or steps inside intervals. Edits save as you make them.
- **iOS-style scroll wheels** for picking times and round counts
- **Sounds**: a soft chime on each of the last 3 seconds of every interval, a brighter chime on each change, and a finish chime at the end
- Time remaining and expected finish time while running
- **Keeps the screen awake** during a workout (Screen Wake Lock API)
- **Works offline** and installs to the home screen (PWA)

Workouts are stored in the browser's `localStorage`, on the device.

## Docs

- [Data model](docs/data-model.md): how workout plans and history are stored, with examples
- [Decision log](docs/decisions.md): why things are the way they are
- [Backlog](docs/backlog.md): ideas to spec before building

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
