# Decision log

Why things are the way they are. Newest first. Add an entry when a choice
changes the data model, a core behaviour, or rules out an obvious alternative.

Format: **date — title**, then *Decision*, *Why*, and (if any) *Consequences*.

---

## 2026-11-21 — Import / export as versioned JSON files

**Decision.** A workout, or the whole log, can be exported to a JSON file
tagged with `app` and the schema `version`, and imported again. Import refuses
files from another version. Imported workouts are added as new workouts,
keeping their ids unless one is already taken (then all are regenerated).
Imported log entries are merged in by `id`; existing entries are never
overwritten or removed.

**Why.** Moving to a new device, backups, and sharing a workout. Merging is
the safe choice for the log: it can't lose history, and since entry ids are
unique, re-importing the same file (or an overlapping backup) is harmless.
Replacing the log was considered, but it destroys data and is easy to do by
mistake. Keeping workout ids when they are free means a log moved alongside
its workouts still links to them (`workoutId`, `stepId`); regenerating them
on a clash keeps ids unique within the store.

**Consequences.**
- After a schema change, older export files can't be imported until import
  runs `MIGRATIONS` too.
- There's no "replace the log" or "export all workouts" yet.

## 2026-11-21 — Versioned storage, split into workouts and log

**Decision.** Storage uses three keys: `workout-timer.version`,
`workout-timer.workouts` and `workout-timer.log`. On load, numbered
migrations bring older data up to the current version (`SCHEMA_VERSION`,
now 1). Data from before versioning is converted once: workouts are kept, the
history is deleted, and the old keys are removed. The older shape-sniffing
migrations (single plan, blocks) are gone.

**Why.** With a version number we always know which migrations to run,
instead of guessing a format from its shape. Splitting the keys means an edit
in the workout editor (saved on every keystroke) rewrites only the workouts,
not a history that keeps growing. Per-workout or per-entry keys were
considered but not needed: both lists are read once at start-up, and the log
is only written when a run finishes or an entry is removed.

**Consequences.**
- The history logged before this change is lost (accepted: it had little detail).
- A build older than this one can't read the new keys.

## 2026-11-21 — The log records each run as it happened

**Decision.** A log entry stores the flattened run: one segment per Work/Rest
actually played, with its label, `stepId`, `round`, planned time, reps, time
taken (`took`, without pauses), `skipped`, and wall-clock `startedAt` /
`endedAt`. The entry has the workout's `startedAt` / `endedAt` (first and last
segment), `planned`, `dur` (sum of `took`) and `status: 'done'`. "Get ready"
is left out.

**Why.** The workout template can change or be deleted after a run, so an entry
that only makes sense next to the template loses its meaning. Storing what
happened also gives real per-step times (e.g. how long 15 push-ups take), and
`stepId` links them across runs. Wall-clock start/end next to `took` shows how
long was spent paused, per step and in total.

**Consequences.**
- All times in the log are in milliseconds (`took`, `planned`, `dur`, and the
  wall-clock `startedAt` / `endedAt`), so they can be compared directly; plan
  durations stay in seconds.
- Roughly 2 KB per 30-segment run, so thousands of runs fit in `localStorage`.
  If space gets tight, `label` can be dropped where `stepId` is set.
- Cancelled runs still aren't logged; `status` leaves room for that.
- Field names are camelCase (`startedAt`, `endedAt`), like the rest of the data.

## 2026-11-21 — Work and Rest are separate step types

**Decision.** `Work { id, type: 'work', name, dur, reps? }` and
`Rest { id, type: 'rest', dur }`. Rests no longer carry `name` or `reps`;
existing data is cleaned on load.

**Why.** A rest stored with work fields (an unused name, leftover reps) is
confusing to read and easy to misuse. The cost is that flipping Work → Rest
would lose the name; the editor keeps it in memory by step id instead, so
flipping back restores it while the app is open.

## 2026-11-21 — Intervals `rest` renamed to `restBetween`

**Decision.** The Intervals field for rest between rounds is `restBetween`.

**Why.** `rest` was also a step type, so `it.rest` read ambiguously. Renamed
while migrating data for the Work/Rest split anyway.

## 2026-11-21 — Intervals don't nest

**Decision.** An Intervals block contains only Work and Rest steps.

**Why.** Intentional, to keep the editor simple. Patterns like
"3 × (5 × 20s / 10s)" are written out as separate blocks.

## 2026-11-21 — Rep steps are an optional `reps` field on Work steps

**Decision.** A Work step becomes rep-based when it has `reps` set. Its `dur`
then holds the expected time. The step picker has a Time | Reps switch (Time by
default); Reps mode shows only a reps wheel, with a quiet "Takes about 0:45 ›"
link under it that swaps in the min/sec wheels for the estimate. (At first all
three wheels showed side by side, but that gave the estimate as much weight as
the reps.)

**Why.** Considered: two Work types, or a mode field on each step. An optional
key is the smallest change: existing data stays valid with no migration, and
everything that only needs a duration (totals, ETA, cards) keeps working by
reading `dur`.

**Consequences.**
- During a run, a rep step shows the count, has no countdown beeps or progress
  bar (hidden, not removed, so the layout doesn't move), and only ends on
  **Done** (the middle button) or Skip. Both move on; the log marks only
  Skip as `skipped`.
- Landing on a rep step while paused resumes the timer (there's no clock to hold).
- The log records how long a rep step actually took, not the estimate.
- `dur` keeps meaning "length" for timed steps and "estimate" for rep steps.
  Reviewed later the same day: kept as is, since it's simple and documented
  (a separate `expectedDur` was considered).

## 2026-11-21 — The editor saves as you edit

**Decision.** Changes are stored immediately; the Save / Start bar and the
"discard changes?" dialog are gone. Duplicate and Delete moved to the Workouts
list (⋯ menu and a two-tap trash button).

**Why.** The draft-until-Save model added a step and a way to lose work.

## 2026-11-21 — Workouts are a list of Work, Rest and Intervals items

**Decision.** Replace "blocks" (every block had rounds, steps, rest between
rounds and rest after) with a list of items: single Work / Rest steps, or
Intervals (named steps repeated N rounds, with rest between rounds). Old
data is migrated on load. Every item and step gets a stable `id`.

**Why.** Most plans are a few single steps plus one repeated block; forcing
everything into blocks made simple plans verbose. Stable ids leave room for
per-step history (e.g. how long a rep step usually takes).

**Consequences.**
- Intervals don't nest.
- "Get ready" became a fixed countdown (`PREP_SEC`) at the start of every run,
  no longer part of the plan, and plan totals exclude it.
- Rests have no name; they're always shown as "Rest".
- Opening a workout shows every Intervals block collapsed, for an overview;
  fold state is not stored.

## 2026-11-16 — Stop needs a second tap

**Decision.** Stopping (now "Cancel") a running workout needs a confirming tap
within 3 seconds; the timer keeps running meanwhile.

**Why.** A stray tap mid-workout threw the whole session away.

## 2026-11-16 — Resume audio after the app is backgrounded

**Decision.** Resume the `AudioContext` on return to the app, before each
chime, and on the next touch.

**Why.** iOS suspends it in the background and never resumes it, so beeps went
silent for the rest of the workout.

## 2026-11-15 — One label per interval

**Decision.** The run screen shows a single label: the step's name, else the
block's name, else Work / Rest. Generic names ("Work", "Interval 3") count as
empty.

**Why.** Showing block and step names together was noisy; the background colour
already says work vs rest.

## 2026-11-14 — Completed workouts are logged

**Decision.** Each finished workout appends `{ id, at, workoutId, name, dur }`
to `store.log`, shown in the Log tab and the Home calendar.

**Why.** To see consistency over time. The name is copied so the log still reads
well after a workout is renamed or deleted.

## 2026-11-14 — Plain HTML/CSS/JS PWA, data in `localStorage`

**Decision.** No framework, no build step, no backend. Installable and offline
via a network-first service worker; data stays on the device.

**Why.** It's a small personal tool; this keeps it trivial to deploy (static
hosting) and to change.

**Consequences.** No sync between devices; clearing site data loses workouts
and history.
