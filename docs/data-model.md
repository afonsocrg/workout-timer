# Data model

How workout plans and history are stored. The source of truth is the code
(`app.js`, top of the file); keep this page in sync when the shapes change,
and record the reasoning in [decisions.md](decisions.md).

## Storage

Data lives in `localStorage`, on the device, under three keys:

| Key                      | Value          | Written when |
|--------------------------|----------------|--------------|
| `workout-timer.version`  | number         | Data is created or migrated. |
| `workout-timer.workouts` | `Workout[]`    | Any edit to a workout, or the list order (Workouts tab order). |
| `workout-timer.log`      | `LogEntry[]`   | A run finishes, or an entry is removed. Oldest first. |

The workouts and the log are separate so that editing a workout (saved on
every keystroke) doesn't rewrite the whole history.

**Units:** durations in a plan are **whole seconds**; every time in the log is
in **milliseconds**. All ids are short random strings (`uid()`), unique within
the store.

## Types

```
Workout    { id, name, items: Item[] }

Item       = Step | Intervals                  // top level of a workout
Step       = Work | Rest

Work       { id, type: 'work', name, dur, reps? }
Rest       { id, type: 'rest', dur }
Intervals  { id, type: 'intervals', name, rounds, restBetween, steps: Step[] }

LogEntry   { id, workoutId, name, status, startedAt, endedAt, planned, dur, segs: LogSeg[] }
LogSeg     { type, label, stepId?, round?, planned, reps?, took, skipped?, startedAt, endedAt }
```

### Workout

| Field   | Type     | Notes |
|---------|----------|-------|
| `id`    | string   | Stable; a duplicated workout gets new ids for itself and every item/step. |
| `name`  | string   | Shown on cards and in the log. An emptied name becomes `"Untitled"`. |
| `items` | `Item[]` | Run in order. May be empty (the workout then can't be started). |

Every run starts with a fixed **"Get ready"** countdown (`PREP_SEC`). It is not
part of the plan and is not stored.

### Work

Used both as a top-level item and inside an Intervals block.

| Field  | Type             | Notes |
|--------|------------------|-------|
| `id`   | string           | Stable; log segments point back to it (`stepId`). |
| `type` | `'work'`         | |
| `name` | string           | Exercise name. May be empty: the run then shows the block's name, else "Work". |
| `dur`  | number (sec)     | **Timed step:** its length. **Rep step:** the *expected* time, used only to estimate the workout length. |
| `reps` | number, optional | If set (1–200), it's a rep step: the run shows the count and waits for **Done** instead of counting down. |

A step is a **rep step** exactly when `type === 'work' && reps > 0`
(`isReps()` in `app.js`).

### Rest

| Field  | Type         | Notes |
|--------|--------------|-------|
| `id`   | string       | Stable. |
| `type` | `'rest'`     | Always shown as "Rest". |
| `dur`  | number (sec) | |

Tapping a step's icon in the editor flips it between Work and Rest in place
(same `id`). Rests have no `name` or `reps`, so flipping to Rest drops them;
the editor remembers them in memory (not stored) so flipping back restores
them while the app stays open.

### Intervals

| Field    | Type           | Notes |
|----------|----------------|-------|
| `id`     | string         | Stable. |
| `name`   | string         | Defaults to `"Interval N"`. Also the fallback label for its unnamed work steps. |
| `rounds` | number         | 1–99. |
| `restBetween` | number (sec) | Rest **between** rounds (not after the last one). `0` = none. |
| `steps`  | `Step[]`       | At least one. Repeated in order every round. Intervals don't nest. |

### LogEntry

One per finished run. It records **what actually happened**, so it stays
meaningful after the workout is edited or deleted. "Get ready" is not included.

| Field       | Type          | Notes |
|-------------|---------------|-------|
| `id`        | string        | |
| `workoutId` | string        | The workout that was run (it may since have been edited or deleted). |
| `name`      | string        | Copy of the workout name at the time. |
| `status`    | `'done'`      | Only finished runs are logged for now; room for `'cancelled'`. |
| `startedAt` | number (ms)   | Wall-clock start of the first segment (after "Get ready"). |
| `endedAt`   | number (ms)   | Wall-clock end of the last segment. The Log tab and calendar use this. |
| `planned`   | number (ms)   | Planned length: sum of the segments' `planned`. |
| `dur`       | number (ms)   | Time actually spent: sum of the segments' `took` (no pauses, no "Get ready"). |
| `segs`      | `LogSeg[]`    | The run, segment by segment (see below). |

`endedAt - startedAt - dur` = total time paused.

### LogSeg

One per segment that ran, in order (the flattened plan, see below).

| Field       | Type                 | Notes |
|-------------|----------------------|-------|
| `type`      | `'work'` \| `'rest'` | |
| `label`     | string               | As shown on screen, e.g. "Push-ups". |
| `stepId`    | string, optional     | The Work/Rest it came from. Absent for rest between rounds and for merged rests. |
| `round`     | number, optional     | 1-based round, for steps inside Intervals. |
| `planned`   | number (ms)          | Planned length; for a rep step, the expected time. |
| `reps`      | number, optional     | For rep steps. |
| `took`      | number (ms)          | Time spent on it, without pauses. |
| `skipped`   | `true`, optional     | Ended early with **Skip** (Done on a rep step doesn't count as skipping). |
| `startedAt` | number (ms)          | Wall-clock start. |
| `endedAt`   | number (ms)          | Wall-clock end. `endedAt - startedAt - took` = time paused in it. |

## From plan to run

When a workout starts, `buildSegments()` flattens it into a list of segments
`{ type: 'prep' | 'work' | 'rest', label, dur, stepId?, round?, reps? }`:

1. A `prep` segment ("Get ready", `PREP_SEC`) comes first.
2. Each Step becomes one segment; timed steps with `dur: 0` are skipped (rep
   steps never are).
3. Each Intervals block becomes `rounds` copies of its steps, with a
   rest segment between rounds when `restBetween > 0`.
4. Back-to-back rests merge into one (losing `stepId` / `round`); a rest at
   the very end is dropped.

Labels: a work segment shows the step's name, else the block's name, else
"Work". Names like "Work", "Rest", "Interval 3" count as empty
(`isGenericName()`).

None of this is written back to the plan. While running, each segment also
collects `startedAt`, `took`, `endedAt` and `skipped`; at the end they become
the log entry's `segs` (`logEntry()`).

## Examples

The helpers at the top of `app.js` build valid objects with fresh ids:

```js
work(name, dur)                          // timed work step
rest(dur)                                // rest step
intervals(name, rounds, restBetween, steps)  // Intervals block
```

A rep step is a work step with `reps` added:

```js
{ ...work('Push-ups', 40), reps: 15 }    // 15 push-ups, expected to take ~40s
```

### Simple: 30s plank, then 15 push-ups

```js
{
  id: uid(), name: 'Quick core',
  items: [
    work('Plank', 30),
    rest(20),
    { ...work('Push-ups', 40), reps: 15 },
  ],
}
```

Runs as: Get ready → Plank 0:30 → Rest 0:20 → Push-ups ×15 (until Done).

### Tabata: 8 × (20s on / 10s off)

```js
{
  id: uid(), name: 'Tabata',
  items: [intervals('Tabata', 8, 10, [work('', 20)])],
}
```

The work step has no name, so each one is labelled "Tabata". The rest between
rounds comes from the block's `rest`, so there's no trailing rest after round 8.

### Circuit with mixed time and reps

```js
{
  id: uid(), name: 'Circuit',
  items: [
    work('Jumping jacks', 120),
    rest(30),
    intervals('Circuit', 3, 60, [
      { ...work('Squats', 45), reps: 20 },
      rest(20),
      { ...work('Push-ups', 40), reps: 15 },
      rest(20),
      work('Plank', 40),
    ]),
  ],
}
```

Estimated length: 120 + 30 + 3 × (45 + 20 + 40 + 20 + 40) + 2 × 60 = 765s
(12:45), plus "Get ready".

### As stored

`workout-timer.version`: `1`

`workout-timer.workouts`:

```json
[
  {
    "id": "k3j9x0a1",
    "name": "Quick core",
    "items": [
      { "id": "p1a2b3c4", "type": "work", "name": "Plank", "dur": 30 },
      { "id": "r5d6e7f8", "type": "rest", "dur": 20 },
      { "id": "u9g0h1i2", "type": "work", "name": "Push-ups", "dur": 40, "reps": 15 }
    ]
  }
]
```

`workout-timer.log`:

```json
[
  {
    "id": "l3m4n5o6", "workoutId": "k3j9x0a1", "name": "Quick core", "status": "done",
    "startedAt": 1795255100000, "endedAt": 1795255212000,
    "planned": 90000, "dur": 97000,
    "segs": [
      { "type": "work", "label": "Plank", "stepId": "p1a2b3c4", "planned": 30000, "took": 30000,
        "startedAt": 1795255100000, "endedAt": 1795255130000 },
      { "type": "rest", "label": "Rest", "stepId": "r5d6e7f8", "planned": 20000, "took": 20000,
        "startedAt": 1795255130000, "endedAt": 1795255165000 },
      { "type": "work", "label": "Push-ups", "stepId": "u9g0h1i2", "planned": 40000, "reps": 15, "took": 47000,
        "startedAt": 1795255165000, "endedAt": 1795255212000 }
    ]
  }
]
```

Here the rest lasted 35s of wall time but `took` 20s: it was paused for 15s.
The push-ups took 47s against an estimate of 40s.

## Versions and migrations

`workout-timer.version` says which shape the other two keys are in. The
current version is `SCHEMA_VERSION` in `app.js`. On load, `loadStore()`:

1. **No version** (fresh install, or data from before versioning): see below,
   then writes all three keys at the current version.
2. **Older version `n`:** runs `MIGRATIONS[n]`, `MIGRATIONS[n + 1]`, … up to
   the current version, then writes all three keys.
3. **Current version:** reads the data as is.

To change a stored shape: bump `SCHEMA_VERSION`, add
`MIGRATIONS[old] = (data) => { … }` that upgrades `{ workouts, log }` in place,
update this page, and add an entry to [decisions.md](decisions.md). A shipped
migration is never edited.

| Version | Shape |
|---------|-------|
| 1       | As described on this page. |

### Before versioning

Data saved before versioning lived in one `workout-timer-v2` key. It's
converted once and the old keys (`workout-timer-v2`, `workout-timer-plan-v1`,
`workout-timer-ui`) are removed:

- **Workouts are kept:** rests lose `name` / `reps`, Intervals `rest` becomes
  `restBetween`, `type: 'circuit'` becomes `intervals`. Workouts still in an
  even older format (`blocks`) are dropped.
- **The history is dropped:** old entries can't be rebuilt in the new shape.
- With nothing to convert, the app starts with the built-in sample workouts.

## Export files

Workouts and the log can be exported to, and imported from, JSON files:

```
{ "app": "workout-timer", "version": 1, "exportedAt": "2026-11-21T10:00:00.000Z",
  "workouts": Workout[] }          // or "log": LogEntry[]
```

- **Export:** one workout (⋯ menu on the Workouts tab), saved as
  `<name>.workout.json`; or the whole log (⋯ on the Log tab), saved as
  `workout-log-YYYY-MM-DD.json`. On phones this opens the share sheet.
- **`version`** is the `SCHEMA_VERSION` the data is in. Import refuses a file
  with any other version (no migrations on import yet), a file without
  `app: "workout-timer"`, and data not in the shapes above.
- **Importing workouts** adds them at the end of the list. They keep their ids,
  so an imported log still points at them, unless any id is already taken
  (e.g. the same workout imported twice): then the copy gets fresh ids, like
  Duplicate.
- **Importing a log** merges: entries whose `id` is already in the log are
  skipped, the rest are added and the log is re-sorted by `endedAt`. Nothing
  is overwritten or removed, and importing the same file twice changes nothing.

## Not stored

- Which Intervals blocks are collapsed in the editor (view state only).
- A step's name and reps while it's flipped to Rest (in memory only).
- The flattened run segments and timer state.

## Open questions

None right now. Settled ones are in [decisions.md](decisions.md).
