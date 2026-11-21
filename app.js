'use strict';

// ---------------------------------------------------------------------------
// Data model (full description and examples: docs/data-model.md)
//
// Workout   { id, name, items: Item[] }
//           (every run starts with a fixed PREP_SEC "Get ready"; it's not part of the plan)
// Item      = Step | Intervals
// Step      = Work | Rest
// Work      { id, type: 'work', name, dur, reps? }
//             with reps it's done when the user taps Done; its dur is then only
//             the expected time, used to estimate the workout length
// Rest      { id, type: 'rest', dur }
// Intervals { id, type: 'intervals', name, rounds, restBetween, steps: Step[] }
//             repeats its steps for N rounds, resting restBetween sec between them
// LogEntry  { id, workoutId, name, status, startedAt, endedAt, planned, dur, segs }
//             what actually happened in one run (see logEntry); times in ms
//
// Plan durations are in seconds; everything in the log is in milliseconds.
// Every item and step has a stable id; log segments point back to it (stepId).
// ---------------------------------------------------------------------------

const uid = () => Math.random().toString(36).slice(2, 10);
const work = (name, dur) => ({ id: uid(), type: 'work', name, dur });
const rest = (dur) => ({ id: uid(), type: 'rest', dur }); // rests have no name: they're always "Rest"
const intervals = (name, rounds, restBetween, steps) =>
  ({ id: uid(), type: 'intervals', name, rounds, restBetween, steps });

const isStep = (it) => it.type === 'work' || it.type === 'rest';
/** A rep-based work step. */
const isReps = (s) => s.type === 'work' && s.reps > 0;
const repsText = (n) => `${n} rep${n === 1 ? '' : 's'}`;

/** Names that say nothing beyond what the background colour already shows. */
const isGenericName = (n) => !n || /^(work|rest|block \d+|interval \d+)$/i.test(n.trim());

const DEFAULT_EXERCISE = 'Push-ups';
const PREP_SEC = 5;
const DEFAULT_REPS = 10;
const MAX_REPS = 200;

function seedWorkouts() {
  return [
    {
      id: uid(), name: 'Intervals',
      items: [intervals('Short', 5, 15, [work('', 30)]), rest(60), intervals('Long', 3, 30, [work('', 120)])],
    },
    {
      id: uid(), name: 'Tabata',
      items: [intervals('Tabata', 8, 10, [work('', 20)])],
    },
    {
      id: uid(), name: 'Circuit',
      items: [
        work('Jumping jacks', 120),
        rest(30),
        intervals('Circuit', 3, 60, [work('Squats', 40), rest(20), work('Push-ups', 40), rest(20), work('Plank', 40)]),
      ],
    },
  ];
}

function newWorkout() {
  return { id: uid(), name: 'New workout', items: [intervals('Interval 1', 5, 15, [work(DEFAULT_EXERCISE, 30)])] };
}

/** "Interval N" with the first N that is not taken yet. */
function nextIntervalName(items) {
  const used = new Set(items.map((i) => (i.name || '').trim().toLowerCase()));
  let n = items.filter((i) => i.type === 'intervals' && i.name.trim()).length + 1;
  while (used.has(`interval ${n}`)) n++;
  return `Interval ${n}`;
}

// ---------------------------------------------------------------------------
// Storage (localStorage)
//
// Three keys, so editing a workout doesn't rewrite the whole history:
//   workout-timer.version   schema version of the two below (a number)
//   workout-timer.workouts  Workout[]
//   workout-timer.log       LogEntry[]
// On load, MIGRATIONS bring older data up to SCHEMA_VERSION.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const KEYS = {
  version: 'workout-timer.version',
  workouts: 'workout-timer.workouts',
  log: 'workout-timer.log',
};

/**
 * MIGRATIONS[n] upgrades { workouts, log } in place from version n to n + 1.
 * To change the stored shape: bump SCHEMA_VERSION, add the step here, and log
 * it in docs/decisions.md. Never edit a step that has shipped.
 */
const MIGRATIONS = {};

/**
 * Data saved before versioning (one 'workout-timer-v2' object). Workouts are
 * kept, brought to version 1 (rests lose name/reps, Intervals rest →
 * restBetween; workouts in even older formats are dropped). The history is
 * dropped: its entries can't be rebuilt in the new shape.
 */
const LEGACY_KEYS = ['workout-timer-v2', 'workout-timer-plan-v1', 'workout-timer-ui'];

function fromUnversioned() {
  let workouts = null;
  try {
    const old = JSON.parse(localStorage.getItem('workout-timer-v2'));
    if (old && Array.isArray(old.workouts)) {
      workouts = old.workouts.filter((w) => Array.isArray(w.items));
      const toStep = (st) => (st.type === 'rest' ? { id: st.id, type: 'rest', dur: st.dur } : st);
      for (const w of workouts) {
        w.items = w.items.filter((it) => it.type === 'work' || it.type === 'rest' || Array.isArray(it.steps)).map((it) => {
          if (it.type !== 'intervals' && it.type !== 'circuit') return toStep(it);
          const { rest: oldRest = 0, ...others } = it;
          return { ...others, type: 'intervals', restBetween: it.restBetween ?? oldRest, steps: it.steps.map(toStep) };
        });
      }
    }
  } catch (_) { /* unreadable: start fresh */ }
  return { workouts: workouts || seedWorkouts(), log: [] };
}

function readKey(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
}

function writeKey(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore: full or blocked */ }
}

function loadStore() {
  const version = readKey(KEYS.version);
  if (typeof version !== 'number') {
    const data = fromUnversioned();
    writeKey(KEYS.workouts, data.workouts);
    writeKey(KEYS.log, data.log);
    writeKey(KEYS.version, SCHEMA_VERSION);
    try { LEGACY_KEYS.forEach((k) => localStorage.removeItem(k)); } catch (_) { /* ignore */ }
    return data;
  }
  const data = {
    workouts: Array.isArray(readKey(KEYS.workouts)) ? readKey(KEYS.workouts) : [],
    log: Array.isArray(readKey(KEYS.log)) ? readKey(KEYS.log) : [],
  };
  if (version < SCHEMA_VERSION) {
    for (let v = version; v < SCHEMA_VERSION; v++) MIGRATIONS[v](data);
    writeKey(KEYS.workouts, data.workouts);
    writeKey(KEYS.log, data.log);
    writeKey(KEYS.version, SCHEMA_VERSION);
  }
  return data;
}

const store = loadStore();

/** Save the workouts (cheap: the log is stored separately). */
function save() { writeKey(KEYS.workouts, store.workouts); }
function saveLog() { writeKey(KEYS.log, store.log); }

const findWorkout = (id) => store.workouts.find((w) => w.id === id);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmt(totalSec) {
  totalSec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const clone = (tplId) => $(tplId).content.firstElementChild.cloneNode(true);

/** First meaningful name, else the plain kind ("Work" / "Rest"). */
function labelOf(kind, ...names) {
  for (const n of names) if (!isGenericName(n)) return n.trim();
  return kind === 'rest' ? 'Rest' : 'Work';
}

function stepSegs(s, parentName) {
  if (!(s.dur > 0) && !isReps(s)) return [];
  const seg = { type: s.type, label: s.type === 'rest' ? 'Rest' : labelOf('work', s.name, parentName), dur: s.dur, stepId: s.id };
  if (isReps(s)) seg.reps = s.reps;
  return [seg];
}

/** How a step's amount reads in summaries: "15 reps" or "0:30". */
const amountText = (s) => (isReps(s) ? repsText(s.reps) : fmt(s.dur));

/** Flatten one item into timed segments. */
function itemSegs(it) {
  if (isStep(it)) return stepSegs(it);
  const segs = [];
  const round = it.steps.flatMap((s) => stepSegs(s, it.name));
  if (!round.length) return segs;
  for (let r = 1; r <= it.rounds; r++) {
    segs.push(...round.map((s) => ({ ...s, round: r })));
    if (r < it.rounds && it.restBetween > 0) segs.push({ type: 'rest', label: 'Rest', dur: it.restBetween });
  }
  return segs;
}

/** Flatten a workout into a linear list of timed segments. */
function buildSegments(w) {
  const segs = [];
  segs.push({ type: 'prep', label: 'Get ready', dur: PREP_SEC });
  for (const it of w.items) {
    for (const s of itemSegs(it)) {
      const prev = segs[segs.length - 1];
      // Back-to-back rests (e.g. intervals ending in rest, then a Rest item) become
      // one, which then no longer belongs to a single step or round
      if (s.type === 'rest' && prev?.type === 'rest') {
        prev.dur += s.dur;
        delete prev.stepId;
        delete prev.round;
      } else segs.push(s);
    }
  }
  // A rest at the very end is pointless
  while (segs.length && segs[segs.length - 1].type === 'rest') segs.pop();
  return segs;
}

const totalOf = (segs) => segs.reduce((a, s) => a + s.dur, 0);
/** Length of the plan itself, without the fixed "Get ready". */
const planDuration = (w) => totalOf(buildSegments(w).filter((s) => s.type !== 'prep'));
const hasWork = (segs) => segs.some((s) => s.type === 'work');
const itemDuration = (it) => totalOf(itemSegs(it));

/** Short summary for cards, e.g. "Jumping jacks · 5×0:30 · 3× Circuit". */
function describeWorkout(w) {
  const tokens = [];
  for (const it of w.items) {
    if (it.type === 'work') tokens.push(isGenericName(it.name) ? amountText(it) : it.name.trim());
    else if (it.type === 'intervals') {
      const works = it.steps.filter((s) => s.type === 'work');
      tokens.push(works.length === 1 ? `${it.rounds}×${amountText(works[0])}` : `${it.rounds}× ${it.name.trim() || 'intervals'}`);
    }
  }
  // Collapse runs of identical single steps: 0:30 · 0:30 · 0:30 → 3×0:30
  const out = [];
  for (let i = 0; i < tokens.length;) {
    let j = i;
    while (j < tokens.length && tokens[j] === tokens[i]) j++;
    out.push(j - i > 1 && !tokens[i].includes('×') ? `${j - i}×${tokens[i]}` : tokens[i]);
    i = j;
  }
  return out.join(' · ');
}

// ---------------------------------------------------------------------------
// Audio (Web Audio API: generated tones, no files needed)
// ---------------------------------------------------------------------------

let audioCtx = null;
let master = null;

function unlockAudio() {
  // iOS 17+: play through the silent switch like a media app
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* ignore */ }
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Gentle compressor so overlapping chimes stay loud but never clip
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    master = audioCtx.createGain();
    master.gain.value = 0.9;
    master.connect(comp).connect(audioCtx.destination);
  }
  resumeAudio();
  chime(440, 0, 0.05, 0.0001); // silent blip so mobile browsers treat audio as started by a gesture
}

/**
 * When the app goes to the background, iOS suspends the AudioContext (state
 * "interrupted" or "suspended") and never resumes it on its own, so every
 * later chime is silent. Kick it back to "running" whenever we can.
 */
function resumeAudio() {
  if (audioCtx && audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
    audioCtx.resume().catch(() => {});
  }
}

// Coming back to the app: try straight away (works on most browsers)...
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeAudio();
});
window.addEventListener('pageshow', resumeAudio);
window.addEventListener('focus', resumeAudio);
// ...and on the next touch, since iOS may only allow resuming from a gesture.
for (const ev of ['pointerdown', 'touchend', 'keydown']) {
  document.addEventListener(ev, () => {
    if (audioCtx && audioCtx.state !== 'running') unlockAudio();
  }, { capture: true, passive: true });
}

/**
 * Bell-like chime: a sine fundamental plus a few soft overtones, with a quick
 * attack and a natural exponential decay (no harsh square waves).
 */
function chime(freq, delay, decay, vol = 0.5) {
  if (!audioCtx) return;
  resumeAudio();
  const t = audioCtx.currentTime + delay;
  const partials = [
    [1, 1],        // fundamental
    [2, 0.35],     // octave
    [3, 0.12],     // twelfth
    [4.2, 0.06],   // slightly inharmonic shimmer, bell-like
  ];
  for (const [mult, amp] of partials) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    const peak = Math.max(0.0002, vol * amp);
    const d = decay / Math.sqrt(mult); // higher partials fade faster
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + d + 0.05);
  }
}

/**
 * Start beep: the same A5 ping as the countdown, but ringing out longer
 * (~0.9s). Cut short so it always fades before the first countdown ping,
 * which comes at (firstSegDur - 3) seconds.
 */
function startBeep(firstSegDur) {
  chime(880, 0, Math.min(0.9, firstSegDur - 3 - 0.05), 0.55);
}

/** Soft ping for each of the last 3 seconds. */
const countdownBeep = () => chime(880, 0, 0.35);          // A5

/** Brighter, longer chime when a new interval starts. */
const goBeep = () => chime(1318.5, 0, 0.9, 0.6);          // E6

/** "Finish" chime: rising major arpeggio ending on a long ringing note. */
function finishBeep() {
  chime(1046.5, 0.0, 0.8);        // C6
  chime(1318.5, 0.16, 0.8);       // E6
  chime(1568.0, 0.32, 0.8);       // G6
  chime(2093.0, 0.48, 2.2, 0.6);  // C7 (rings out)
  chime(1046.5, 0.48, 2.2, 0.3);  // C6 underneath for warmth
}

// ---------------------------------------------------------------------------
// Screen wake lock (keep the screen on while the timer runs)
// ---------------------------------------------------------------------------

let wakeLock = null;

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) { /* ignore */ }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && timer.running && !timer.paused) requestWakeLock();
});

// ---------------------------------------------------------------------------
// Timer engine
// ---------------------------------------------------------------------------

const timer = {
  running: false,
  paused: false,
  workout: null,
  segs: [],
  idx: 0,
  segStart: 0,      // performance.now() timestamp when current segment started
  segEnd: 0,        // ...and when it ends (for reps: when it's expected to end)
  pausedLeft: 0,    // ms left in segment when paused
  lastBeepSec: null,
  interval: null,
};

function startWorkout(w) {
  const segs = buildSegments(w);
  if (!hasWork(segs)) return;
  numberWorkRounds(segs);
  unlockAudio();
  requestWakeLock();

  Object.assign(timer, {
    running: true,
    paused: false,
    workout: w,
    segs,
    idx: 0,
    segStart: performance.now(),
    segEnd: performance.now() + segs[0].dur * 1000,
    pausedAt: 0,
    lastBeepSec: null,
  });

  // Confirm the start with a long beep, unless the first segment is so short
  // that the 3-2-1 countdown is already due: then a countdown ping starts it.
  if (segs[0].dur > 3) startBeep(segs[0].dur);
  else countdownBeep();

  segs[0].startedAt = wallAt(timer.segStart);
  show('run');
  renderRun();
  clearInterval(timer.interval);
  timer.interval = setInterval(tick, 50);
}

/**
 * Count rounds across the whole workout, where each work interval is a round.
 * Prep and rest segments show the round that comes next.
 */
function numberWorkRounds(segs) {
  const total = segs.filter((s) => s.type === 'work').length;
  let n = 0;
  for (const s of segs) if (s.type === 'work') s.workNo = ++n;
  let upcoming = total;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].type === 'work') upcoming = segs[i].workNo;
    else segs[i].workNo = upcoming;
  }
  segs.workTotal = total;
}

/** Wall-clock time (ms since epoch) of a performance.now() timestamp. */
const wallAt = (perf) => Math.round(Date.now() - performance.now() + perf);

/**
 * Close the current segment for the log. activeEnd: when it stopped counting
 * (performance.now() time; segStart is pushed forward by pauses, so this
 * excludes them); wallEnd: when it actually ended.
 */
function endSegment(activeEnd, wallEnd = activeEnd, skipped = false) {
  const seg = timer.segs[timer.idx];
  seg.took = Math.max(0, Math.round(activeEnd - timer.segStart));
  seg.endedAt = wallAt(wallEnd);
  if (skipped) seg.skipped = true;
}

function enterNextSegment(at) {
  timer.idx++;
  timer.segStart = at;
  timer.segs[timer.idx].startedAt = wallAt(at);
  timer.lastBeepSec = null;
}

function tick() {
  if (!timer.running || timer.paused) return;
  const now = performance.now();

  // Advance through any segments that have elapsed (handles throttled tabs too).
  // A rep segment never elapses: it waits for the user to tap Done.
  while (!timer.segs[timer.idx].reps && now >= timer.segEnd) {
    endSegment(timer.segEnd);
    if (timer.idx >= timer.segs.length - 1) return finishWorkout();
    enterNextSegment(timer.segEnd);
    timer.segEnd += timer.segs[timer.idx].dur * 1000;
    goBeep();
  }

  const leftMs = timer.segEnd - now;
  const secLeft = Math.ceil(leftMs / 1000);
  const seg = timer.segs[timer.idx];
  if (!seg.reps && secLeft >= 1 && secLeft <= 3 && secLeft < seg.dur && secLeft !== timer.lastBeepSec) {
    timer.lastBeepSec = secLeft;
    countdownBeep();
  }

  renderRun(leftMs);
}

function togglePause() {
  if (!timer.running) return;
  if (timer.paused) {
    unlockAudio();
    const now = performance.now();
    timer.segStart += now - timer.pausedAt;
    timer.segEnd = now + timer.pausedLeft;
    timer.paused = false;
    requestWakeLock();
  } else {
    timer.pausedAt = performance.now();
    timer.pausedLeft = timer.segEnd - timer.pausedAt;
    timer.paused = true;
  }
  renderRun();
}

/** Move on to the next segment: Skip, or (done) Done on a rep segment. */
function skipSegment({ done = false } = {}) {
  if (!timer.running) return;
  const now = performance.now();
  const seg = timer.segs[timer.idx];
  endSegment(timer.paused ? timer.pausedAt : now, now, !(done && seg.reps));
  if (timer.idx >= timer.segs.length - 1) return finishWorkout();
  enterNextSegment(now);
  const next = timer.segs[timer.idx];
  // Reps have no clock to hold, so landing on one while paused resumes
  if (timer.paused && next.reps) { timer.paused = false; unlockAudio(); requestWakeLock(); }
  timer.pausedAt = now;
  if (timer.paused) timer.pausedLeft = next.dur * 1000;
  else { timer.segEnd = now + next.dur * 1000; goBeep(); }
  renderRun();
}

/** The big middle button: Done on a rep segment, Pause / Resume otherwise. */
function mainAction() {
  if (timer.segs[timer.idx]?.reps && !timer.paused) skipSegment({ done: true });
  else togglePause();
}

function stopTimer() {
  resetStopButton();
  timer.running = false;
  clearInterval(timer.interval);
  releaseWakeLock();
}

// Stop needs a second tap within 3 seconds, so a stray tap mid-workout
// doesn't throw away the session. The timer keeps running meanwhile.
let stopArmed = null;
function resetStopButton() {
  clearTimeout(stopArmed);
  stopArmed = null;
  $('stop').textContent = 'Cancel';
  $('stop').classList.remove('armed');
}

function stopWorkout() {
  if (!stopArmed) {
    $('stop').textContent = 'Confirm';
    $('stop').classList.add('armed');
    stopArmed = setTimeout(resetStopButton, 3000);
    return;
  }
  resetStopButton();
  stopTimer();
  goBack();
}

function finishWorkout() {
  stopTimer();
  finishBeep();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
  const w = timer.workout;
  const entry = logEntry(w, timer.segs);
  store.log.push(entry);
  saveLog();

  const week = workoutsThisWeek();
  $('done-name').textContent = w.name;
  $('done-time').textContent = fmt(entry.dur / 1000);
  $('done-week').textContent = week === 1 ? 'First workout this week' : `That's ${week} this week`;
  show('done');
}

/**
 * What actually happened in a run, independent of later edits to the workout.
 * "Get ready" is left out. All times are in ms. Per segment: planned = planned
 * length (or the estimate, for reps); took = time spent, without pauses;
 * startedAt / endedAt = wall clock, so endedAt - startedAt - took = time paused.
 */
function logEntry(w, segs) {
  const ran = segs.filter((s) => s.type !== 'prep');
  return {
    id: uid(),
    workoutId: w.id,
    name: w.name || 'Untitled',
    status: 'done',
    startedAt: ran[0].startedAt,
    endedAt: ran[ran.length - 1].endedAt,
    planned: totalOf(ran) * 1000,
    dur: ran.reduce((a, s) => a + s.took, 0),
    segs: ran.map((s) => ({
      type: s.type,
      label: s.label,
      ...(s.stepId && { stepId: s.stepId }),
      ...(s.round && { round: s.round }),
      planned: s.dur * 1000,
      ...(s.reps && { reps: s.reps }),
      took: s.took,
      ...(s.skipped && { skipped: true }),
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    })),
  };
}

function goBack() {
  openHome();
}

function renderRun(leftMs) {
  const seg = timer.segs[timer.idx];
  if (!seg) return;
  if (leftMs === undefined) leftMs = timer.paused ? timer.pausedLeft : timer.segEnd - performance.now();
  leftMs = Math.max(0, leftMs);

  const run = $('run');
  run.dataset.phase = seg.type;
  run.classList.toggle('paused', timer.paused);

  $('run-label').textContent = timer.paused ? 'Paused' : seg.label;
  if (seg.reps) $('run-time').replaceChildren(String(seg.reps), el('span', 'run-unit', seg.reps === 1 ? 'rep' : 'reps'));
  else $('run-time').textContent = fmt(Math.ceil(leftMs / 1000));
  $('run-round').style.visibility = timer.segs.workTotal < 2 ? 'hidden' : ''; // keep its space so "left" stays put
  $('run-round-num').textContent = seg.workNo;
  $('run-round-total').textContent = timer.segs.workTotal;
  // Reps have no clock, so no bar; it's only hidden (not removed) so nothing below moves
  $('run-progress').parentElement.style.visibility = seg.reps ? 'hidden' : '';
  if (!seg.reps) $('run-progress').style.width = `${(1 - leftMs / (seg.dur * 1000)) * 100}%`;

  const next = timer.segs[timer.idx + 1];
  $('run-next').textContent = next ? `Next: ${next.label} ${next.reps ? repsText(next.reps) : fmt(next.dur)}` : 'Last interval!';

  const remainingSec = Math.ceil(leftMs / 1000) + totalOf(timer.segs.slice(timer.idx + 1));
  $('run-total').textContent = fmt(remainingSec);
  const endsAt = new Date(Date.now() + remainingSec * 1000);
  $('run-eta').textContent = `Ends at ${endsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const done = !!seg.reps && !timer.paused;
  $('pause').textContent = done ? 'Done' : timer.paused ? 'Resume' : 'Pause';
  $('pause').classList.toggle('done', done);
}

// ---------------------------------------------------------------------------
// Wheel picker (iOS-style scroll wheels in a bottom sheet)
// ---------------------------------------------------------------------------

let sheet = null; // { anchor, wheels }

function itemHeight() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wheel-item')) || 38;
}

/**
 * One scrolling wheel column.
 * col = { values: any[], index: number, format?: v => string, unit?: string }
 * onSettle(index) is called when the wheel comes to rest on a new value.
 */
function createWheel(col, onSettle) {
  const wrap = el('div', 'wheel');
  const scroller = el('div', 'wheel-scroll');
  const h = itemHeight();
  const items = col.values.map((v, i) => {
    const it = el('div', 'wheel-item', col.format ? col.format(v) : String(v));
    it.addEventListener('click', () => scroller.scrollTo({ top: i * h, behavior: 'smooth' }));
    scroller.appendChild(it);
    return it;
  });
  wrap.appendChild(scroller);
  if (col.unit) wrap.appendChild(el('span', 'wheel-unit', col.unit));

  let index = col.index;
  let settleTimer = null;
  let frame = null;

  // Curve the items like a drum: rotate and fade with distance from the centre
  const paint = () => {
    frame = null;
    const center = scroller.scrollTop / h;
    const lo = Math.max(0, Math.floor(center) - 4);
    const hi = Math.min(items.length - 1, Math.ceil(center) + 4);
    for (let i = lo; i <= hi; i++) {
      const off = i - center;
      const angle = clamp(off * 22, -80, 80);
      items[i].style.transform = `perspective(500px) rotateX(${-angle}deg)`;
      items[i].style.opacity = String(Math.max(0.15, 1 - Math.abs(off) * 0.28));
    }
  };

  const settle = () => {
    clearTimeout(settleTimer);
    const i = clamp(Math.round(scroller.scrollTop / h), 0, items.length - 1);
    if (i !== index) {
      index = i;
      onSettle(i);
    }
  };

  scroller.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(paint);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 120);
  }, { passive: true });

  return {
    el: wrap,
    init() { scroller.scrollTop = index * h; paint(); },
    flush: settle,
  };
}

/**
 * Open the picker sheet.
 * columns: wheel column specs (see createWheel, plus an optional `group` label
 * shown above a run of columns); onChange(values[]) fires live.
 * footer (optional): a quiet link under the wheels that swaps in another view,
 *   { text, onClick() => view }, where a view is { columns, onChange, footer? }
 * modes (optional): a segmented switch above the wheels,
 *   { options: { key: label }, current: key, onSelect(key) => view }
 */
function openPicker({ title, anchor, columns, onChange, footer, modes }) {
  closePicker();
  $('sheet-title').textContent = title;
  anchor?.classList.add('active');
  $('sheet').classList.remove('hidden');
  $('sheet').setAttribute('aria-hidden', 'false');
  sheet = { anchor, wheels: [], modes };

  const seg = $('sheet-modes');
  seg.classList.toggle('hidden', !modes);
  seg.replaceChildren();
  if (modes) {
    for (const [key, label] of Object.entries(modes.options)) {
      const b = el('button', key === modes.current ? 'on' : '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(key === modes.current));
      b.addEventListener('click', () => {
        if (key === modes.current) return;
        modes.current = key;
        seg.querySelectorAll('button').forEach((x) => {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        });
        setWheels(modes.onSelect(key));
      });
      seg.appendChild(b);
    }
  }
  setWheels({ columns, onChange, footer });
}

/** Fill the (visible) sheet with a view's wheels and footer, replacing what's there. */
function setWheels({ columns, onChange, footer }) {
  const row = $('wheels-row');
  row.replaceChildren();
  const current = columns.map((c) => c.index);
  sheet.wheels = columns.map((col, ci) => {
    const wheel = createWheel(col, (i) => {
      current[ci] = i;
      onChange(current.map((idx, k) => columns[k].values[idx]));
    });
    row.appendChild(wheel.el);
    return wheel;
  });
  sheet.wheels.forEach((w) => w.init());

  // Group labels, each centred over its run of wheels. The row stays (empty)
  // when switching modes, so the sheet doesn't jump in height.
  const labels = $('wheel-labels');
  labels.replaceChildren();
  const groups = [...new Set(columns.map((c) => c.group).filter(Boolean))];
  labels.classList.toggle('hidden', !groups.length && !sheet.modes);
  const base = labels.getBoundingClientRect().left;
  for (const g of groups) {
    const els = sheet.wheels.filter((_, i) => columns[i].group === g).map((w) => w.el.getBoundingClientRect());
    const label = el('span', 'wheel-label', g);
    label.style.left = `${els[0].left - base}px`;
    label.style.width = `${els[els.length - 1].right - els[0].left}px`;
    labels.appendChild(label);
  }

  // With a mode switch the footer keeps its space even when empty, so
  // switching modes doesn't make the sheet jump in height
  const foot = $('sheet-footer');
  foot.classList.toggle('hidden', !footer && !sheet.modes);
  foot.style.visibility = footer ? '' : 'hidden';
  foot.textContent = footer?.text ?? '';
  foot.onclick = footer && (() => {
    sheet.wheels.forEach((w) => w.flush()); // keep a value that is still settling
    setWheels(footer.onClick());
  });
}

function closePicker() {
  if (!sheet) return;
  sheet.wheels.forEach((w) => w.flush()); // commit a value that is still settling
  sheet.anchor?.classList.remove('active');
  $('sheet').classList.add('hidden');
  $('sheet').setAttribute('aria-hidden', 'true');
  sheet = null;
}

$('sheet-done').addEventListener('click', closePicker);
document.querySelector('.sheet-backdrop').addEventListener('click', closePicker);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const pad2 = (v) => String(v).padStart(2, '0');

/** Seconds wheel: 0, 5, … 55. A stored value off the 5s grid opens on the nearest step below. */
const SEC_STEP = 5;
const secColumn = (dur, extra = {}) => ({
  values: range(0, 60 / SEC_STEP - 1).map((i) => i * SEC_STEP),
  index: Math.floor((dur % 60) / SEC_STEP),
  format: pad2,
  unit: 'sec',
  ...extra,
});

/**
 * Bind a button to a duration (seconds) with a minutes/seconds wheel picker.
 * opts.render(value): shows the value (default: the button's text).
 */
function bindDuration(btn, title, get, set, maxSec = 3600, { render = (v) => { btn.textContent = fmt(v); } } = {}) {
  render(get());
  btn.addEventListener('click', () => {
    const v = get();
    openPicker({
      title,
      anchor: btn,
      columns: [
        { values: range(0, Math.floor(maxSec / 60)), index: Math.floor(v / 60), unit: 'min' },
        secColumn(v),
      ],
      onChange: ([m, s]) => {
        const next = clamp(m * 60 + s, 0, maxSec);
        set(next);
        render(next);
        edited();
      },
    });
  });
}

/**
 * The amount of a Work/Rest step: a duration, or (work only) a number of reps
 * plus the time they're expected to take. Returns a function that repaints
 * the button, e.g. after the step switched between work and rest.
 */
function bindStepAmount(btn, s) {
  const render = () => {
    btn.classList.toggle('reps', isReps(s));
    if (isReps(s)) btn.replaceChildren(String(s.reps), el('span', 'pill-unit', s.reps === 1 ? 'rep' : 'reps'));
    else btn.textContent = fmt(s.dur);
  };
  render();

  const durColumns = (group) => [
    { values: range(0, 60), index: Math.floor(s.dur / 60), unit: 'min', group },
    secColumn(s.dur, { group }),
  ];
  const setDur = (m, sec) => { s.dur = clamp(m * 60 + sec, 0, 3600); };
  const commit = () => { render(); edited(); };
  // Reps lead; the time they take only feeds the workout's estimated length,
  // so it sits behind a quiet link under the reps wheel
  const estimate = () => ({
    columns: durColumns('Takes about'),
    onChange: ([m, sec]) => { setDur(m, sec); commit(); },
    footer: { text: `‹ Back to ${repsText(s.reps)}`, onClick: modes.reps },
  });
  const modes = {
    time: () => ({ columns: durColumns(), onChange: ([m, sec]) => { setDur(m, sec); commit(); } }),
    reps: () => ({
      columns: [{ values: range(1, MAX_REPS), index: clamp(s.reps, 1, MAX_REPS) - 1, unit: 'reps' }],
      onChange: ([n]) => { s.reps = n; commit(); },
      footer: { text: `Takes about ${fmt(s.dur)} ›`, onClick: estimate },
    }),
  };

  btn.addEventListener('click', () => {
    if (s.type === 'rest') return openPicker({ title: 'Rest', anchor: btn, ...modes.time() });
    const current = isReps(s) ? 'reps' : 'time';
    openPicker({
      title: labelOf('work', s.name),
      anchor: btn,
      ...modes[current](),
      modes: {
        options: { time: 'Time', reps: 'Reps' },
        current,
        onSelect: (key) => {
          if (key === 'reps') s.reps = DEFAULT_REPS;
          else delete s.reps;
          commit();
          return modes[key]();
        },
      },
    });
  });
  return render;
}

/** Bind a button to an integer count with a single wheel (opts as in bindDuration). */
function bindCount(btn, title, get, set, min = 1, max = 99, { render = (n) => { btn.textContent = n; } } = {}) {
  render(get());
  btn.addEventListener('click', () => {
    openPicker({
      title,
      anchor: btn,
      columns: [{ values: range(min, max), index: get() - min, unit: '' }],
      onChange: ([n]) => {
        set(n);
        render(n);
        edited();
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Views & tab bar
// ---------------------------------------------------------------------------

const VIEWS = ['home', 'workouts', 'log', 'edit', 'preview', 'run', 'done'];
const TAB_VIEWS = ['home', 'workouts', 'log'];

function show(view) {
  closeMenu();
  for (const id of VIEWS) $(id).classList.toggle('hidden', id !== view);
  const tabbed = TAB_VIEWS.includes(view);
  $('tabbar').classList.toggle('hidden', !tabbed);
  if (tabbed) {
    document.querySelectorAll('#tabbar [data-tab]').forEach((b) => {
      const on = b.dataset.tab === view;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }
  window.scrollTo(0, 0);
}

document.querySelectorAll('#tabbar [data-tab]').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.tab === 'home') openHome();
    else if (b.dataset.tab === 'workouts') openWorkouts();
    else openLog();
  });
});

/** Fill a workout card (shared by the home row and the workouts grid). */
function fillCard(card, w) {
  card.querySelector('.wo-title').textContent = w.name || 'Untitled';
  card.querySelector('.wo-total').textContent = fmt(planDuration(w));
  card.querySelector('.wo-meta').textContent = describeWorkout(w);
  return card;
}

function onActivate(card, fn) {
  card.addEventListener('click', fn);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
}

// ----- Activity calendar (home) -----

const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const plural = (n) => `${n} workout${n === 1 ? '' : 's'}`;
const cal = { year: 0, month: 0 };

function resetCalendar() {
  const now = new Date();
  cal.year = now.getFullYear();
  cal.month = now.getMonth();
}

/** Number of completed workouts since Monday 00:00 of the current week. */
function workoutsThisWeek() {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  return store.log.filter((e) => e.endedAt >= monday.getTime()).length;
}

function workoutsInMonth(year, month) {
  return store.log.filter((e) => {
    const d = new Date(e.endedAt);
    return d.getFullYear() === year && d.getMonth() === month;
  }).length;
}

function logByDay() {
  const map = new Map();
  for (const e of store.log) {
    const k = dayKey(new Date(e.endedAt));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return map;
}

function renderCalendar() {
  const byDay = logByDay();
  const now = new Date();
  const todayKey = dayKey(now);
  const first = new Date(cal.year, cal.month, 1);
  const daysInMonth = new Date(cal.year, cal.month + 1, 0).getDate();
  const leading = (first.getDay() + 6) % 7; // weeks start on Monday
  const isCurrentMonth = cal.year === now.getFullYear() && cal.month === now.getMonth();
  const monthCount = workoutsInMonth(cal.year, cal.month);

  $('cal-month').textContent = first.toLocaleDateString([], { month: 'long', year: 'numeric' });
  $('cal-stats').textContent = isCurrentMonth
    ? `${workoutsThisWeek()} this week · ${monthCount} this month`
    : plural(monthCount);
  $('cal-next').disabled = isCurrentMonth;

  const days = $('cal-days');
  days.replaceChildren();
  for (let i = 0; i < leading; i++) days.appendChild(el('span', 'cal-day empty'));

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(cal.year, cal.month, d);
    const k = dayKey(date);
    const entries = byDay.get(k);
    const btn = el('button', 'cal-day', String(d));
    btn.type = 'button';
    if (k === todayKey) btn.classList.add('today');
    if (date > now) btn.classList.add('future');
    if (entries) {
      btn.classList.add('done');
      btn.setAttribute('aria-label', `${date.toLocaleDateString([], { day: 'numeric', month: 'long' })}, ${plural(entries.length)}`);
      btn.addEventListener('click', () => openLog(k)); // jump to that day in the log
    } else {
      btn.tabIndex = -1;
    }
    days.appendChild(btn);
  }
  // Always render 6 weeks so the calendar height never changes between months
  for (let i = leading + daysInMonth; i < 42; i++) days.appendChild(el('span', 'cal-day empty'));
}

$('cal-prev').addEventListener('click', () => {
  cal.month--;
  if (cal.month < 0) { cal.month = 11; cal.year--; }
  renderCalendar();
});
$('cal-next').addEventListener('click', () => {
  cal.month++;
  if (cal.month > 11) { cal.month = 0; cal.year++; }
  renderCalendar();
});

// ----- Home: calendar + row of workouts (tap to start) -----

function openHome() {
  editing = null;
  resetCalendar();
  renderCalendar();

  const row = $('quick-row');
  row.replaceChildren();
  for (const w of store.workouts) {
    if (!hasWork(buildSegments(w))) continue;
    const card = fillCard(clone('card-tpl'), w);
    card.classList.add('quick');
    card.setAttribute('aria-label', `Start ${w.name || 'workout'}`);
    onActivate(card, () => startWorkout(w));
    row.appendChild(card);
  }
  if (!row.children.length) {
    const empty = el('button', 'empty-state', 'No workouts yet. Create one in Workouts.');
    empty.type = 'button';
    empty.addEventListener('click', openWorkouts);
    row.appendChild(empty);
  }

  show('home');
}

// ----- Workouts tab: grid of workouts (tap to edit) -----

function createWorkout() {
  const w = newWorkout();
  store.workouts.push(w);
  save();
  openEditor(w.id, { collapse: false }); // a brand-new workout opens ready to edit
  $('wo-name').focus();
  $('wo-name').select();
}

function openWorkouts() {
  editing = null;
  const list = $('workout-list');
  list.replaceChildren();

  for (const w of store.workouts) {
    const item = el('div', 'list-item');
    item.dataset.id = w.id;
    const row = el('button', 'list-row');
    row.type = 'button';
    const text = el('span', 'list-text');
    text.append(el('span', 'list-title', w.name || 'Untitled'), el('span', 'list-sub', describeWorkout(w)));
    row.append(text, el('span', 'list-value', fmt(planDuration(w))));
    row.setAttribute('aria-label', `Edit ${w.name || 'workout'}`);
    row.addEventListener('click', () => openEditor(w.id));

    const handle = el('button', 'drag-handle');
    handle.type = 'button';
    handle.setAttribute('aria-label', `Reorder ${w.name || 'workout'} (drag, or use arrow keys)`);
    handle.innerHTML = HANDLE_SVG;
    bindDragHandle(handle, item, (from, to) => { moveItem(store.workouts, from, to); save(); });

    const more = el('button', 'icon-btn more');
    more.type = 'button';
    more.setAttribute('aria-label', `More actions for ${w.name || 'workout'}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.innerHTML = MORE_SVG;
    more.addEventListener('click', () => (menuOpenFor === more ? closeMenu() : openMenu(more, [
      { label: 'Preview', action: () => openPreview(w) },
      { label: 'Duplicate', action: () => duplicateWorkout(w) },
      { label: 'Export', action: () => exportWorkout(w) },
    ])));

    const del = el('button', 'icon-btn trash');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete ${w.name || 'workout'}`);
    del.innerHTML = TRASH_SVG;
    armToConfirm(del, () => {
      store.workouts = store.workouts.filter((x) => x !== w);
      save();
      openWorkouts();
    });

    item.append(handle, row, more, del);
    list.appendChild(item);
  }

  if (!store.workouts.length) {
    const empty = el('button', 'empty-state', 'No workouts yet. Tap + to create one.');
    empty.type = 'button';
    empty.addEventListener('click', createWorkout);
    list.appendChild(empty);
  }

  show('workouts');
}

$('add-workout').addEventListener('click', createWorkout);

const MORE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

/** Copy a workout (new ids, so the copy's history stays its own) right after the original. */
function duplicateWorkout(w) {
  const copy = reId({ ...structuredClone(w), name: `${w.name} (copy)` });
  store.workouts.splice(store.workouts.indexOf(w) + 1, 0, copy);
  save();
  openWorkouts();
  const row = $('workout-list').querySelector(`[data-id="${copy.id}"]`);
  row?.classList.add('flash');
  setTimeout(() => row?.classList.remove('flash'), 900);
}

// ----- Preview: the workout rolled out as the run will go -----

let previewing = null;

/**
 * List every segment the run will go through (without "Get ready"), with the
 * time it starts at. After a reps step, times are estimates, so they get a "~".
 */
function openPreview(w) {
  previewing = w;
  const segs = buildSegments(w).filter((s) => s.type !== 'prep');
  // Which intervals block a step belongs to, to say "Round 2 of 3 · Circuit"
  const blockOf = new Map();
  for (const it of w.items) if (it.type === 'intervals') for (const s of it.steps) blockOf.set(s.id, it);

  $('preview-name').textContent = w.name || 'Untitled';
  const works = segs.filter((s) => s.type === 'work').length;
  const rests = segs.length - works;
  const approx = segs.some(isReps) ? '~' : '';
  $('preview-summary').textContent =
    `${works} work · ${rests} rest${rests === 1 ? '' : 's'} · ${approx}${fmt(totalOf(segs))}`;

  const list = $('preview-list');
  list.replaceChildren();
  let at = 0;
  let estimated = false;
  for (const s of segs) {
    const row = el('li', `preview-row is-${s.type}`);
    const text = el('span', 'list-text');
    text.appendChild(el('span', 'preview-label', s.label));
    const block = blockOf.get(s.stepId);
    if (block && s.round) {
      const name = isGenericName(block.name) ? '' : ` · ${block.name.trim()}`;
      text.appendChild(el('span', 'list-sub', `Round ${s.round} of ${block.rounds}${name}`));
    }
    row.append(
      el('span', 'preview-at', `${estimated ? '~' : ''}${fmt(at)}`),
      text,
      el('span', 'preview-amount', isReps(s) ? repsText(s.reps) : fmt(s.dur)),
    );
    list.appendChild(row);
    at += s.dur;
    if (isReps(s)) estimated = true;
  }
  if (!segs.length) list.appendChild(el('li', 'empty-state', 'Nothing to do yet: this workout has no steps.'));
  $('preview-start').disabled = !hasWork(segs);
  show('preview');
}

$('preview-back').addEventListener('click', openWorkouts);
$('preview-start').addEventListener('click', () => previewing && startWorkout(previewing));

// ----- Small popover menu (e.g. the ⋯ on a workout row) -----

let menuOpenFor = null;

function openMenu(anchor, entries) {
  closeMenu();
  const menu = $('menu');
  menu.replaceChildren(...entries.map(({ label, action }) => {
    const b = el('button', 'menu-item', label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { closeMenu(); action(); });
    return b;
  }));
  menu.classList.remove('hidden');
  // Below the button, right-aligned with it (above it if there's no room below)
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const below = r.bottom + 4 + m.height < window.innerHeight;
  menu.style.top = `${(below ? r.bottom + 4 : r.top - 4 - m.height) + window.scrollY}px`;
  menu.style.left = `${Math.max(8, r.right - m.width) + window.scrollX}px`;
  anchor.classList.add('active');
  anchor.setAttribute('aria-expanded', 'true');
  menuOpenFor = anchor;
  menu.firstElementChild?.focus({ preventScroll: true });
}

function closeMenu() {
  if (!menuOpenFor) return;
  $('menu').classList.add('hidden');
  menuOpenFor.classList.remove('active');
  menuOpenFor.setAttribute('aria-expanded', 'false');
  menuOpenFor = null;
}

document.addEventListener('pointerdown', (e) => {
  if (menuOpenFor && !$('menu').contains(e.target) && !menuOpenFor.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('scroll', closeMenu, { passive: true });

/** Move one array element from index `from` to index `to`. */
const moveItem = (arr, from, to) => arr.splice(to, 0, arr.splice(from, 1)[0]);

const HANDLE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';

/**
 * Drag a row by its handle: the row follows the finger and its siblings slide
 * out of the way. On release the DOM is reordered and onMove(from, to) called.
 * Rows may differ in height and be separated by a gap.
 *
 * The drag only starts once the finger has moved a few pixels, so the handle
 * can also be a normal button (a tap still fires "click"; after a drag the
 * click is swallowed).
 * collapse: while dragging, add .reordering to the list so items shrink to
 * one line (CSS); the page scrolls so the handle stays under the finger.
 */
const DRAG_THRESHOLD = 6;

function bindDragHandle(handle, item, onMove, { collapse = false } = {}) {
  handle.addEventListener('keydown', (e) => {
    const sib = e.key === 'ArrowUp' ? item.previousElementSibling : e.key === 'ArrowDown' ? item.nextElementSibling : null;
    if (!sib) return;
    e.preventDefault();
    const from = [...item.parentElement.children].indexOf(item);
    if (e.key === 'ArrowUp') sib.before(item); else sib.after(item);
    handle.focus();
    onMove(from, from + (e.key === 'ArrowUp' ? -1 : 1));
  });

  // Swallow the click that follows a drag, so a dragged chevron doesn't also toggle
  let draggedAt = 0;
  handle.addEventListener('click', (e) => {
    if (performance.now() - draggedAt < 400) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging (a tap still fires "click")
    e.stopPropagation(); // a step's handle inside intervals shouldn't drag the whole block
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const list = item.parentElement;
    let started = false;
    let items, from, rects, gap, h, to, offset = 0;

    const begin = () => {
      started = true;
      if (collapse) {
        const before = handle.getBoundingClientRect().top;
        list.classList.add('reordering');
        window.scrollBy(0, handle.getBoundingClientRect().top - before);
        offset = before - handle.getBoundingClientRect().top; // what scrolling couldn't undo
      }
      items = [...list.children];
      from = to = items.indexOf(item);
      rects = items.map((n) => n.getBoundingClientRect());
      gap = items.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;
      h = rects[from].height + gap; // how far the others move to make room
      item.classList.add('dragging');
      items.forEach((n) => { if (n !== item) n.classList.add('shifting'); });
    };

    const move = (ev) => {
      if (!started) {
        if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
        begin();
      }
      const last = items.length - 1;
      const dy = Math.max(rects[0].top - rects[from].top,
        Math.min(rects[last].bottom - rects[from].bottom, ev.clientY - startY + offset));
      item.style.transform = `translateY(${dy}px)`;
      const center = rects[from].top + rects[from].height / 2 + dy;
      to = rects.findIndex((r) => center < r.bottom + gap / 2);
      if (to === -1) to = last;
      items.forEach((n, i) => {
        if (n === item) return;
        const shift = from < to && i > from && i <= to ? -h : to < from && i >= to && i < from ? h : 0;
        n.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      if (!started) return; // a tap: let the click through
      draggedAt = performance.now();
      items.forEach((n) => { n.classList.remove('dragging', 'shifting'); n.style.transform = ''; });
      if (to !== from) { if (to > from) items[to].after(item); else items[to].before(item); }
      if (collapse) {
        // Expand again, keeping the dropped item where the finger left it
        const before = handle.getBoundingClientRect().top;
        list.classList.remove('reordering');
        window.scrollBy(0, handle.getBoundingClientRect().top - before);
      }
      if (to !== from) onMove(from, to);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

// ----- Log tab: every completed workout, grouped by day -----

function openLog(focusDay) {
  editing = null;
  const now = new Date();
  $('log-stats').textContent =
    `${plural(workoutsThisWeek())} this week · ${workoutsInMonth(now.getFullYear(), now.getMonth())} this month · ${store.log.length} total`;

  const list = $('log-list');
  list.replaceChildren();
  const byDay = logByDay();
  const keys = [...byDay.keys()].sort().reverse(); // newest day first
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  if (!keys.length) list.appendChild(el('div', 'empty-state', 'Finish a workout and it will show up here.'));

  for (const k of keys) {
    const [y, m, d] = k.split('-').map(Number);
    const group = el('section', 'log-day');
    group.id = `day-${k}`;
    const title = k === todayKey ? 'Today'
      : k === yesterdayKey ? 'Yesterday'
      : new Date(y, m - 1, d).toLocaleDateString([], {
        weekday: 'long', day: 'numeric', month: 'long', ...(y !== now.getFullYear() && { year: 'numeric' }),
      });
    group.appendChild(el('div', 'log-day-title', title));

    for (const e of byDay.get(k).sort((a, b) => a.endedAt - b.endedAt)) {
      const row = el('div', 'log-entry');
      row.append(
        el('span', 'log-time', new Date(e.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        el('span', 'log-name', e.name),
        el('span', 'log-dur', fmt(e.dur / 1000)), // log times are in ms
      );
      const del = el('button', 'icon-btn trash');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove from history');
      del.innerHTML = TRASH_SVG;
      armToConfirm(del, () => {
        store.log = store.log.filter((x) => x.id !== e.id);
        saveLog();
        const y0 = window.scrollY;
        openLog();
        window.scrollTo(0, y0);
      }, 'Remove?');
      row.appendChild(del);
      group.appendChild(row);
    }
    list.appendChild(group);
  }

  show('log');

  if (focusDay) {
    const target = $(`day-${focusDay}`);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1200);
    }
  }
}

$('log-more').addEventListener('click', () => {
  const btn = $('log-more');
  if (menuOpenFor === btn) return closeMenu();
  openMenu(btn, [
    ...(store.log.length ? [{ label: 'Export log', action: exportLog }] : []),
    { label: 'Import log…', action: () => pickFile(importLog) },
  ]);
});

// ---------------------------------------------------------------------------
// Import / export (JSON files)
//
// { app: 'workout-timer', version, exportedAt, workouts?: Workout[], log?: LogEntry[] }
// `version` is the SCHEMA_VERSION the data is in; a file from another version
// is refused (no migrations on import yet).
// ---------------------------------------------------------------------------

const EXPORT_APP = 'workout-timer';

/** Save a JSON file: the share sheet on phones (iOS can't "download"), a download elsewhere. */
function exportFile(filename, payload) {
  const text = JSON.stringify({ app: EXPORT_APP, version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...payload }, null, 2);
  const file = new File([text], filename, { type: 'application/json' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] }).catch(() => {}); // cancelled: nothing to do
    return;
  }
  const a = el('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const slug = (s) => (s || 'workout').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workout';

function exportWorkout(w) {
  exportFile(`${slug(w.name)}.workout.json`, { workouts: [w] });
}

function exportLog() {
  exportFile(`workout-log-${dayKey(new Date())}.json`, { log: store.log });
}

/**
 * Ask for a file and pass its text to onText. Errors it throws are shown.
 * With { multiple: true }, several files can be picked and onText gets
 * [{ name, text }] for all of them instead.
 */
function pickFile(onText, { multiple = false } = {}) {
  const input = $('import-file');
  input.value = '';
  input.multiple = multiple;
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    try {
      if (multiple) onText(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
      else onText(await files[0].text());
    } catch (e) { toast(e.message, { error: true }); }
  };
  input.click();
}

/** Parse an exported file and return data[key], or throw an Error saying what's wrong. */
function readExport(text, key, valid) {
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error("That file isn't valid JSON."); }
  if (data?.app !== EXPORT_APP) throw new Error("That file wasn't exported from this app.");
  if (data.version !== SCHEMA_VERSION) {
    throw new Error(data.version > SCHEMA_VERSION
      ? 'That file comes from a newer version of the app. Update the app, then try again.'
      : `That file comes from an older version of the app (v${data.version}) and can't be imported.`);
  }
  const list = data[key];
  if (!Array.isArray(list)) throw new Error(key === 'log' ? 'That file has no log in it.' : 'That file has no workouts in it.');
  if (!list.every(valid)) throw new Error('That file is damaged: some of its data is not in the expected shape.');
  return list;
}

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isCount = (v, max) => Number.isInteger(v) && v >= 1 && v <= max;

function validStep(s) {
  if (!s || !isStr(s.id) || !isNum(s.dur) || s.dur < 0) return false;
  if (s.type === 'rest') return true;
  return s.type === 'work' && isStr(s.name) && (s.reps === undefined || isCount(s.reps, MAX_REPS));
}

function validWorkout(w) {
  return !!w && isStr(w.id) && isStr(w.name) && Array.isArray(w.items) && w.items.every((it) => validStep(it) || (
    it?.type === 'intervals' && isStr(it.id) && isStr(it.name) && isCount(it.rounds, 99)
    && isNum(it.restBetween) && it.restBetween >= 0
    && Array.isArray(it.steps) && it.steps.length > 0 && it.steps.every(validStep)));
}

function validLogEntry(e) {
  return !!e && isStr(e.id) && isStr(e.workoutId) && isStr(e.name) && isStr(e.status)
    && [e.startedAt, e.endedAt, e.planned, e.dur].every(isNum) && Array.isArray(e.segs);
}

/** Every id in a workout: its own, its items' and their steps'. */
const idsOf = (w) => [w.id, ...w.items.flatMap((it) => [it.id, ...(it.steps || []).map((s) => s.id)])];

/**
 * Add the files' workouts as new workouts at the end of the list. They keep
 * their ids (so an imported log still points at them) unless one is already
 * taken, e.g. the same workout imported twice: then the copy gets fresh ids.
 * A file that can't be read is skipped; the others are still imported.
 */
function importWorkouts(files) {
  const list = [];
  const failed = [];
  for (const { name, text } of files) {
    try {
      const ws = readExport(text, 'workouts', validWorkout);
      if (!ws.length) throw new Error('That file has no workouts in it.');
      list.push(...ws);
    } catch (e) { failed.push({ name, message: e.message }); }
  }
  if (!list.length) {
    throw new Error(failed.length === 1 ? failed[0].message
      : `None of those files could be imported. ${failed[0].name}: ${failed[0].message}`);
  }
  const taken = new Set(store.workouts.flatMap(idsOf));
  const added = list.map((w) => {
    const ids = idsOf(w);
    if (ids.some((id) => taken.has(id)) || new Set(ids).size !== ids.length) reId(w);
    idsOf(w).forEach((id) => taken.add(id));
    return w;
  });
  store.workouts.push(...added);
  save();
  openWorkouts();
  for (const w of added) {
    const row = $('workout-list').querySelector(`[data-id="${w.id}"]`);
    row?.classList.add('flash');
    setTimeout(() => row?.classList.remove('flash'), 900);
  }
  $('workout-list').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const msg = added.length === 1 ? `Imported “${added[0].name || 'Untitled'}”` : `Imported ${added.length} workouts`;
  if (!failed.length) return toast(msg);
  const which = failed.length === 1 ? failed[0].name : `${failed.length} files`;
  toast(`${msg}. Skipped ${which}: ${failed.length === 1 ? failed[0].message : 'they could not be read.'}`, { error: true });
}

/**
 * Merge the file's entries into the log. Entries already in it (same id) are
 * skipped, so importing the same file twice changes nothing.
 */
function importLog(text) {
  const list = readExport(text, 'log', validLogEntry);
  const have = new Set(store.log.map((e) => e.id));
  const added = list.filter((e) => !have.has(e.id) && have.add(e.id));
  if (added.length) {
    store.log.push(...added);
    store.log.sort((a, b) => a.endedAt - b.endedAt); // stored oldest first
    saveLog();
  }
  openLog();
  const entries = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
  const skipped = list.length - added.length;
  toast(!added.length ? 'Nothing new: everything in that file is already in the log'
    : `Imported ${entries(added.length)}${skipped ? ` (${skipped} already in the log)` : ''}`);
}

$('import-workout').addEventListener('click', () => pickFile(importWorkouts, { multiple: true }));

// ----- Toast: a short message near the bottom of the screen -----

let toastTimer = null;
function toast(message, { error = false } = {}) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', error);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), error ? 5000 : 3000);
}

// ----- Editor -----

// The editor changes the stored workout directly; every edit is saved right away.
let editing = null;

/** collapse: start with every intervals block folded (for an overview). */
function openEditor(id, { collapse = true } = {}) {
  editing = findWorkout(id);
  if (!editing) return openWorkouts();
  collapsed.clear();
  if (collapse) for (const it of editing.items) if (it.type === 'intervals') collapsed.add(it.id);
  renderEditor();
  show('edit');
}

/** A value changed: save and refresh the totals. */
function edited() {
  save();
  if (editing) updateSummaries();
}

/** Items were added, removed or moved: save and redraw. */
function structureChanged() {
  save();
  renderEditor();
}

/**
 * Two-tap confirm: the first tap turns the button into a red "Delete", the
 * second one runs onConfirm. Tapping anywhere else, or waiting 3s, undoes it.
 */
function armToConfirm(btn, onConfirm, label = 'Delete') {
  const original = btn.innerHTML;
  let timer = null;
  const outside = (e) => { if (!btn.contains(e.target)) disarm(); };
  function disarm() {
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('armed');
    btn.innerHTML = original;
    document.removeEventListener('pointerdown', outside, true);
  }
  btn.addEventListener('click', () => {
    if (!timer) {
      btn.classList.add('armed');
      btn.textContent = label;
      timer = setTimeout(disarm, 3000);
      document.addEventListener('pointerdown', outside, true);
      return;
    }
    disarm();
    onConfirm();
  });
}

/** Trash button that removes `obj` from `list` (two taps). */
function bindDelete(btn, list, obj) {
  armToConfirm(btn, () => {
    const i = list.indexOf(obj);
    if (i !== -1) { list.splice(i, 1); structureChanged(); }
  });
}

/**
 * A rest has no name or reps, so flipping a work step to rest drops them. They
 * are kept here (in memory, by step id) so flipping back restores them while
 * the app stays open.
 */
const flippedAway = new Map();

/** Turn a Work step into a Rest or back, in place (keeps its id and position). */
function flipStep(s) {
  if (s.type === 'work') {
    flippedAway.set(s.id, { name: s.name, reps: s.reps });
    s.type = 'rest';
    delete s.name;
    delete s.reps;
  } else {
    const { name = '', reps } = flippedAway.get(s.id) || {};
    flippedAway.delete(s.id);
    s.type = 'work';
    s.name = name;
    if (reps) s.reps = reps;
  }
}

/** A Work/Rest row: used both as a top-level item and inside intervals. */
function renderStep(s, list, { minCount = 0, parentName = '' } = {}) {
  const row = clone('step-tpl');
  const stepName = row.querySelector('.step-name');
  const kind = row.querySelector('.kind');
  let paintAmount = () => {};
  const paintKind = () => {
    paintAmount(); // a rest never counts reps
    stepName.value = s.name ?? '';
    kind.classList.toggle('is-rest', s.type === 'rest');
    kind.setAttribute('aria-label', s.type === 'rest' ? 'Rest (tap to make it work)' : 'Work (tap to make it rest)');
    row.classList.toggle('is-rest', s.type === 'rest');
    stepName.placeholder = isGenericName(parentName) ? 'Exercise' : parentName.trim();
  };
  paintKind();
  kind.addEventListener('click', () => {
    flipStep(s);
    paintKind();
    edited();
  });

  stepName.addEventListener('input', () => { s.name = stepName.value; save(); });

  paintAmount = bindStepAmount(row.querySelector('.dur'), s);

  const del = row.querySelector('[data-act="delete"]');
  del.disabled = list.length <= minCount;
  bindDelete(del, list, s);
  bindDragHandle(row.querySelector('.drag-handle'), row, (from, to) => { moveItem(list, from, to); structureChanged(); },
    { collapse: list === editing.items });
  return row;
}

/** "<b>5</b> rounds": a value followed by a muted word. */
function renderStat(btn, value, unit) {
  btn.querySelector('.stat-value').textContent = value;
  btn.querySelector('.stat-unit').textContent = unit;
}

function renderIntervals(it, list) {
  const node = clone('intervals-tpl');

  const name = node.querySelector('.block-name');
  name.value = it.name;

  const paintCollapsed = () => {
    const on = collapsed.has(it.id);
    node.classList.toggle('collapsed', on);
    node.querySelector('.collapse-btn').setAttribute('aria-expanded', String(!on));
  };
  paintCollapsed();
  const toggle = () => {
    setCollapsed(it.id, !collapsed.has(it.id));
    paintCollapsed();
    };
  // The chevron folds/unfolds on tap and reorders on drag (see bindDragHandle)
  node.querySelector('.collapse-btn').addEventListener('click', toggle);
  // A collapsed block also opens when tapped anywhere on its row
  node.querySelector('.block-head').addEventListener('click', (e) => {
    if (collapsed.has(it.id) && !e.target.closest('.collapse-btn, .trash')) toggle();
  });
  name.addEventListener('input', () => { it.name = name.value; save(); });

  // "5 rounds · 0:30 rest between": two tappable values with small labels
  const roundsBtn = node.querySelector('.stat-rounds');
  const restBtn = node.querySelector('.stat-rest');
  restBtn.classList.toggle('hidden', it.rounds < 2); // no rounds to rest between
  bindCount(roundsBtn, 'Rounds', () => it.rounds, (n) => {
    it.rounds = n;
    restBtn.classList.toggle('hidden', n < 2);
  }, 1, 99, { render: (n) => renderStat(roundsBtn, n, n === 1 ? 'round' : 'rounds') });
  bindDuration(restBtn, 'Rest between rounds', () => it.restBetween, (v) => { it.restBetween = v; }, 3600,
    { render: (v) => renderStat(restBtn, v ? fmt(v) : 'No', 'rest') });

  const stepsEl = node.querySelector('.steps');
  for (const s of it.steps) stepsEl.appendChild(renderStep(s, it.steps, { minCount: 1, parentName: it.name }));

  node.querySelector('.add-step').addEventListener('click', () => {
    const lastStep = it.steps[it.steps.length - 1];
    const step = lastStep?.type === 'work' ? rest(15) : work(DEFAULT_EXERCISE, 30);
    it.steps.push(step);
    structureChanged();
    if (step.type === 'work') {
      const names = $('items').querySelector(`[data-id="${it.id}"]`).querySelectorAll('.step-name');
      focusName(names[names.length - 1]);
    }
  });

  bindDelete(node.querySelector('.block-head [data-act="delete"]'), list, it);
  bindDragHandle(node.querySelector('.collapse-btn'), node,
    (from, to) => { moveItem(list, from, to); structureChanged(); }, { collapse: true });
  return node;
}

function renderEditor() {
  const w = editing;
  $('wo-name').value = w.name;

  const container = $('items');
  container.replaceChildren();

  for (const it of w.items) {
    const node = isStep(it) ? renderStep(it, w.items) : renderIntervals(it, w.items);
    node.classList.add('item');
    node.dataset.id = it.id;
    container.appendChild(node);
  }
  $('items-empty').classList.toggle('hidden', w.items.length > 0);

  updateSummaries();
}

function updateSummaries() {
  const w = editing;
  for (const it of w.items) {
    if (isStep(it)) continue;
    const node = $('items').querySelector(`[data-id="${it.id}"]`);
    node.querySelector('.head-meta').textContent = fmt(itemDuration(it));
  }
  $('total-time').textContent = fmt(planDuration(w));
}

$('wo-name').addEventListener('input', (e) => { editing.name = e.target.value; save(); });
$('wo-name').addEventListener('change', (e) => {
  if (!editing.name.trim()) { editing.name = 'Untitled'; e.target.value = editing.name; save(); }
});

$('edit-back').addEventListener('click', openWorkouts);

// ----- Collapsing intervals (view state only, not part of the workout) -----
// Opening a workout starts with every block collapsed, for an overview;
// blocks added while editing start expanded.

const collapsed = new Set();

function setCollapsed(id, on) {
  if (on) collapsed.add(id); else collapsed.delete(id);
}

/** Focus a name field with its text selected, so typing replaces the default name. */
function focusName(input) {
  input.focus({ preventScroll: true });
  input.select();
}

const NEW_ITEM = {
  work: () => work(DEFAULT_EXERCISE, 30),
  rest: () => rest(30),
  intervals: () => intervals(nextIntervalName(editing.items), 5, 15, [work(DEFAULT_EXERCISE, 30)]),
};

document.querySelectorAll('[data-add]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const it = NEW_ITEM[btn.dataset.add]();
    editing.items.push(it);
    structureChanged();
    const node = $('items').lastElementChild;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 900);
    if (it.type === 'work') focusName(node.querySelector('.step-name'));
  });
});

/** Fresh ids for a copied workout, so the copy's history stays its own. */
function reId(w) {
  w.id = uid();
  for (const it of w.items) {
    it.id = uid();
    if (it.steps) for (const s of it.steps) s.id = uid();
  }
  return w;
}

// ----- Running / done -----

$('pause').addEventListener('click', mainAction);
$('skip').addEventListener('click', skipSegment);
$('stop').addEventListener('click', stopWorkout);
$('done-back').addEventListener('click', goBack);

openHome();

// ---------------------------------------------------------------------------
// Service worker (offline / installable)
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
