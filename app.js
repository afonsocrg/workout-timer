'use strict';

// ---------------------------------------------------------------------------
// Data model
//
// Workout   { id, name, items: Item[] }
//           (every run starts with a fixed PREP_SEC "Get ready"; it's not part of the plan)
// Item      = Step | Intervals
// Step      { id, type: 'work' | 'rest', name, dur }
// Intervals { id, type: 'intervals', name, rounds, rest, steps: Step[] }
//             repeats its steps for N rounds; rest = rest between rounds
//
// Every item and step has a stable id, so per-step history (e.g. how long a
// rep-based step usually takes) can be attached later.
// ---------------------------------------------------------------------------

const STORE_KEY = 'workout-timer-v2';
const OLD_KEY = 'workout-timer-plan-v1';

const uid = () => Math.random().toString(36).slice(2, 10);
const work = (name, dur) => ({ id: uid(), type: 'work', name, dur });
const rest = (dur) => ({ id: uid(), type: 'rest', name: '', dur }); // rests have no name: they're always "Rest"
const intervals = (name, rounds, restDur, steps) =>
  ({ id: uid(), type: 'intervals', name, rounds, rest: restDur, steps });

const isStep = (it) => it.type === 'work' || it.type === 'rest';

/** Names that say nothing beyond what the background colour already shows. */
const isGenericName = (n) => !n || /^(work|rest|block \d+|interval \d+)$/i.test(n.trim());

const DEFAULT_EXERCISE = 'Push-ups';
const PREP_SEC = 10;

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

/**
 * Convert the old "blocks" format (every block had rounds, steps, rest between
 * rounds and rest after) into items, picking the simplest item that fits.
 */
function migrateBlocks(blocks) {
  const items = [];
  blocks.forEach((b, bi) => {
    const steps = (b.steps || []).map((s) => (s.kind === 'rest' ? rest(s.dur) : work(s.name || '', s.dur)));
    const rounds = b.rounds || 1;
    const blockName = isGenericName(b.name) ? '' : b.name;
    const nameOf = (s) => (isGenericName(s.name) ? blockName : s.name);
    if (rounds === 1 && steps.length === 1 && steps[0].type === 'work') {
      items.push(work(nameOf(steps[0]), steps[0].dur));
    } else if (steps.length) {
      items.push(intervals(blockName, rounds, b.rest || 0, steps));
    }
    if (bi < blocks.length - 1 && b.restAfter > 0) items.push(rest(b.restAfter));
  });
  return items;
}

/** "Interval N" with the first N that is not taken yet. */
function nextIntervalName(items) {
  const used = new Set(items.map((i) => (i.name || '').trim().toLowerCase()));
  let n = items.filter((i) => i.type === 'intervals' && i.name.trim()).length + 1;
  while (used.has(`interval ${n}`)) n++;
  return `Interval ${n}`;
}

/** Upgrade items saved by the short-lived split Intervals / Circuit format. */
function normalizeItem(it) {
  if (it.type === 'circuit') it.type = 'intervals';
  if (it.type === 'intervals' && !Array.isArray(it.steps)) {
    it.steps = [work('', it.work || 30)];
    delete it.work;
  }
}

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.workouts)) {
      for (const w of s.workouts) {
        if (!Array.isArray(w.items)) {
          w.items = migrateBlocks(w.blocks || []);
          delete w.blocks;
        }
        w.items.forEach(normalizeItem);
        // Unnamed intervals get a default name, like new ones do
        w.items.filter((it) => it.type === 'intervals' && !it.name.trim())
          .forEach((it) => { it.name = nextIntervalName(w.items); });
      }
      return s;
    }
  } catch (_) { /* ignore */ }

  const workouts = seedWorkouts();
  // Migrate the single plan from the first version of the app, if present
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY));
    if (old && Array.isArray(old.blocks) && old.blocks.length) {
      workouts.unshift({
        id: uid(), name: 'My workout',
        items: old.blocks.map((b) => intervals(b.name || '', b.rounds || 1, b.rest || 0, [work('', b.work || 30)])),
      });
    }
  } catch (_) { /* ignore */ }
  return { workouts };
}

let store = loadStore();
// History of completed workouts: { id, at (ms timestamp), workoutId, name, dur (sec) }
if (!Array.isArray(store.log)) store.log = [];
save();

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) { /* ignore */ }
}

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
  if (!(s.dur > 0)) return [];
  return [{ type: s.type, label: s.type === 'rest' ? 'Rest' : labelOf('work', s.name, parentName), dur: s.dur }];
}

/** Flatten one item into timed segments. */
function itemSegs(it) {
  if (isStep(it)) return stepSegs(it);
  const segs = [];
  const round = it.steps.flatMap((s) => stepSegs(s, it.name));
  if (!round.length) return segs;
  for (let r = 1; r <= it.rounds; r++) {
    segs.push(...round.map((s) => ({ ...s })));
    if (r < it.rounds && it.rest > 0) segs.push({ type: 'rest', label: 'Rest', dur: it.rest });
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
      // Back-to-back rests (e.g. intervals ending in rest, then a Rest item) become one
      if (s.type === 'rest' && prev?.type === 'rest') {
        prev.dur += s.dur;
        if (prev.label === 'Rest') prev.label = s.label;
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
    if (it.type === 'work') tokens.push(isGenericName(it.name) ? fmt(it.dur) : it.name.trim());
    else if (it.type === 'intervals') {
      const works = it.steps.filter((s) => s.type === 'work');
      tokens.push(works.length === 1 ? `${it.rounds}×${fmt(works[0].dur)}` : `${it.rounds}× ${it.name.trim() || 'intervals'}`);
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
  segEnd: 0,        // performance.now() timestamp when current segment ends
  pausedLeft: 0,    // ms left in segment when paused
  lastBeepSec: null,
  interval: null,
  returnTo: 'home',
};

function startWorkout(w, returnTo) {
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
    segEnd: performance.now() + segs[0].dur * 1000,
    lastBeepSec: null,
    returnTo,
  });

  // Confirm the start with a long beep, unless the first segment is so short
  // that the 3-2-1 countdown is already due: then a countdown ping starts it.
  if (segs[0].dur > 3) startBeep(segs[0].dur);
  else countdownBeep();

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

function tick() {
  if (!timer.running || timer.paused) return;
  const now = performance.now();

  // Advance through any segments that have elapsed (handles throttled tabs too)
  while (now >= timer.segEnd) {
    if (timer.idx >= timer.segs.length - 1) return finishWorkout();
    timer.idx++;
    timer.segEnd += timer.segs[timer.idx].dur * 1000;
    timer.lastBeepSec = null;
    goBeep();
  }

  const leftMs = timer.segEnd - now;
  const secLeft = Math.ceil(leftMs / 1000);
  const seg = timer.segs[timer.idx];
  if (secLeft >= 1 && secLeft <= 3 && secLeft < seg.dur && secLeft !== timer.lastBeepSec) {
    timer.lastBeepSec = secLeft;
    countdownBeep();
  }

  renderRun(leftMs);
}

function togglePause() {
  if (!timer.running) return;
  if (timer.paused) {
    unlockAudio();
    timer.segEnd = performance.now() + timer.pausedLeft;
    timer.paused = false;
    requestWakeLock();
  } else {
    timer.pausedLeft = timer.segEnd - performance.now();
    timer.paused = true;
  }
  renderRun();
}

function skipSegment() {
  if (!timer.running) return;
  if (timer.idx >= timer.segs.length - 1) return finishWorkout();
  timer.idx++;
  const dur = timer.segs[timer.idx].dur * 1000;
  timer.lastBeepSec = null;
  if (timer.paused) timer.pausedLeft = dur;
  else { timer.segEnd = performance.now() + dur; goBeep(); }
  renderRun();
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
  $('stop').textContent = 'Stop';
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
  store.log.push({ id: uid(), at: Date.now(), workoutId: w.id, name: w.name || 'Untitled', dur: totalOf(timer.segs) });
  save();

  const week = workoutsThisWeek();
  $('done-name').textContent = w.name;
  $('done-time').textContent = fmt(totalOf(timer.segs));
  $('done-week').textContent = week === 1 ? 'First workout this week' : `That's ${week} this week`;
  show('done');
}

function goBack() {
  if (timer.returnTo === 'edit' && editing) { renderEditor(); show('edit'); } // back to the (maybe unsaved) draft
  else openHome();
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
  $('run-time').textContent = fmt(Math.ceil(leftMs / 1000));
  $('run-round').style.visibility = timer.segs.workTotal < 2 ? 'hidden' : ''; // keep its space so "left" stays put
  $('run-round-num').textContent = seg.workNo;
  $('run-round-total').textContent = timer.segs.workTotal;
  $('run-progress').style.width = `${(1 - leftMs / (seg.dur * 1000)) * 100}%`;

  const next = timer.segs[timer.idx + 1];
  $('run-next').textContent = next ? `Next: ${next.label} ${fmt(next.dur)}` : 'Last interval!';

  const remainingSec = Math.ceil(leftMs / 1000) + totalOf(timer.segs.slice(timer.idx + 1));
  $('run-total').textContent = fmt(remainingSec);
  const endsAt = new Date(Date.now() + remainingSec * 1000);
  $('run-eta').textContent = `Ends at ${endsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('pause').textContent = timer.paused ? 'Resume' : 'Pause';
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
 * columns: wheel column specs (see createWheel); onChange(values[]) fires live.
 */
function openPicker({ title, anchor, columns, onChange }) {
  closePicker();
  $('sheet-title').textContent = title;
  const row = $('wheels-row');
  row.replaceChildren();
  const current = columns.map((c) => c.index);
  const wheels = columns.map((col, ci) => {
    const wheel = createWheel(col, (i) => {
      current[ci] = i;
      onChange(current.map((idx, k) => columns[k].values[idx]));
    });
    row.appendChild(wheel.el);
    return wheel;
  });
  anchor?.classList.add('active');
  $('sheet').classList.remove('hidden');
  $('sheet').setAttribute('aria-hidden', 'false');
  sheet = { anchor, wheels };
  wheels.forEach((w) => w.init());
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
        { values: range(0, 59), index: v % 60, format: pad2, unit: 'sec' },
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

const VIEWS = ['home', 'workouts', 'log', 'edit', 'run', 'done'];
const TAB_VIEWS = ['home', 'workouts', 'log'];

function show(view) {
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
  return store.log.filter((e) => e.at >= monday.getTime()).length;
}

function workoutsInMonth(year, month) {
  return store.log.filter((e) => {
    const d = new Date(e.at);
    return d.getFullYear() === year && d.getMonth() === month;
  }).length;
}

function logByDay() {
  const map = new Map();
  for (const e of store.log) {
    const k = dayKey(new Date(e.at));
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
    onActivate(card, () => startWorkout(w, 'home'));
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
  openDraft(newWorkout(), { isNew: true });
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

    item.append(row, handle);
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

    for (const e of byDay.get(k).sort((a, b) => a.at - b.at)) {
      const row = el('div', 'log-entry');
      row.append(
        el('span', 'log-time', new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        el('span', 'log-name', e.name),
        el('span', 'log-dur', fmt(e.dur)),
      );
      const del = el('button', 'log-del', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove from history');
      let armed = null;
      del.addEventListener('click', () => {
        if (!armed) {
          del.textContent = 'Remove?';
          del.classList.add('armed');
          armed = setTimeout(() => { armed = null; del.textContent = '✕'; del.classList.remove('armed'); }, 3000);
          return;
        }
        clearTimeout(armed);
        store.log = store.log.filter((x) => x.id !== e.id);
        save();
        const y0 = window.scrollY;
        openLog();
        window.scrollTo(0, y0);
      });
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

// ----- Editor -----

// The editor works on a copy of the workout ("draft"); nothing is stored until Save.
let editing = null;
let draft = { isNew: false, after: null, dirty: false };

function openEditor(id) {
  const w = findWorkout(id);
  if (!w) return openWorkouts();
  openDraft(structuredClone(w), { isNew: false });
}

/** isNew: not in the store yet; after: id of the workout to insert it after on save. */
function openDraft(w, { isNew, after = null, dirty = false }) {
  editing = w;
  draft = { isNew, after, dirty };
  renderEditor();
  show('edit');
}

function markDirty() { draft.dirty = true; }

function edited() {
  markDirty();
  if (editing) updateSummaries();
}

function structureChanged() {
  markDirty();
  renderEditor();
}

function saveDraft() {
  const i = store.workouts.findIndex((w) => w.id === editing.id);
  if (i !== -1) store.workouts[i] = editing;
  else {
    const after = store.workouts.findIndex((w) => w.id === draft.after);
    store.workouts.splice(after === -1 ? store.workouts.length : after + 1, 0, editing);
  }
  save();
  editing = structuredClone(editing); // keep the stored copy safe from further edits
  draft = { isNew: false, after: null, dirty: false };
}

/** Leave the editor, asking first if there are unsaved changes. */
function leaveEditor() {
  if (!draft.dirty && !draft.isNew) return openWorkouts();
  askConfirm({
    title: draft.isNew ? 'Discard this new workout?' : 'Discard unsaved changes?',
    message: 'Your changes will be lost.',
    ok: 'Discard',
  }, openWorkouts);
}

/** Replace a pill element with a fresh clone so old listeners are dropped. */
function freshPill(node) {
  const fresh = node.cloneNode(true);
  node.replaceWith(fresh);
  return fresh;
}

// ----- Confirm dialog (no browser dialogs: they block the page on iOS) -----

let confirmAction = null;

function askConfirm({ title, message = '', ok = 'Delete' }, onOk) {
  $('confirm-title').textContent = title;
  $('confirm-msg').textContent = message;
  $('confirm-msg').classList.toggle('hidden', !message);
  $('confirm-ok').textContent = ok;
  confirmAction = onOk;
  $('confirm').classList.remove('hidden');
  $('confirm').setAttribute('aria-hidden', 'false');
  $('confirm-cancel').focus();
}

function closeConfirm() {
  confirmAction = null;
  $('confirm').classList.add('hidden');
  $('confirm').setAttribute('aria-hidden', 'true');
}

$('confirm-ok').addEventListener('click', () => { const fn = confirmAction; closeConfirm(); fn?.(); });
$('confirm-cancel').addEventListener('click', closeConfirm);
document.querySelector('.confirm-backdrop').addEventListener('click', closeConfirm);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && confirmAction) closeConfirm(); });


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

/** A Work/Rest row: used both as a top-level item and inside intervals. */
function renderStep(s, list, { minCount = 0, parentName = '' } = {}) {
  const row = clone('step-tpl');
  const stepName = row.querySelector('.step-name');
  const kind = row.querySelector('.kind');
  const paintKind = () => {
    kind.classList.toggle('is-rest', s.type === 'rest');
    kind.setAttribute('aria-label', s.type === 'rest' ? 'Rest (tap to make it work)' : 'Work (tap to make it rest)');
    row.classList.toggle('is-rest', s.type === 'rest');
    stepName.placeholder = isGenericName(parentName) ? 'Exercise' : parentName.trim();
  };
  paintKind();
  kind.addEventListener('click', () => {
    s.type = s.type === 'rest' ? 'work' : 'rest';
    // The name is kept while it's a rest, so switching back restores it
    paintKind();
    edited();
  });

  stepName.value = s.name;
  stepName.addEventListener('input', () => { s.name = stepName.value; markDirty(); });

  bindDuration(row.querySelector('.dur'), s.type === 'rest' ? 'Rest' : labelOf('work', s.name), () => s.dur, (v) => { s.dur = v; });

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
    paintCollapseAll();
  };
  // The chevron folds/unfolds on tap and reorders on drag (see bindDragHandle)
  node.querySelector('.collapse-btn').addEventListener('click', toggle);
  // A collapsed block also opens when tapped anywhere on its row
  node.querySelector('.block-head').addEventListener('click', (e) => {
    if (collapsed.has(it.id) && !e.target.closest('.collapse-btn, .trash')) toggle();
  });
  name.addEventListener('input', () => { it.name = name.value; markDirty(); });

  // "5 rounds · 0:30 rest between": two tappable values with small labels
  const roundsBtn = node.querySelector('.stat-rounds');
  const restBtn = node.querySelector('.stat-rest');
  restBtn.classList.toggle('hidden', it.rounds < 2); // no rounds to rest between
  bindCount(roundsBtn, 'Rounds', () => it.rounds, (n) => {
    it.rounds = n;
    restBtn.classList.toggle('hidden', n < 2);
  }, 1, 99, { render: (n) => renderStat(roundsBtn, n, n === 1 ? 'round' : 'rounds') });
  bindDuration(restBtn, 'Rest between rounds', () => it.rest, (v) => { it.rest = v; }, 3600,
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
  paintCollapseAll();

  updateSummaries();
}

function updateSummaries() {
  const w = editing;
  for (const it of w.items) {
    if (isStep(it)) continue;
    const node = $('items').querySelector(`[data-id="${it.id}"]`);
    node.querySelector('.head-meta').textContent = fmt(itemDuration(it));
  }
  const segs = buildSegments(w);
  $('total-time').textContent = fmt(planDuration(w));
  $('start').disabled = !hasWork(segs);
}

$('wo-name').addEventListener('input', (e) => { editing.name = e.target.value; markDirty(); });
$('wo-name').addEventListener('change', (e) => {
  if (!editing.name.trim()) { editing.name = 'Untitled'; e.target.value = editing.name; }
});

$('edit-back').addEventListener('click', leaveEditor);

// ----- Collapsing intervals (view state only: remembered per device, not part of the workout) -----

const UI_KEY = 'workout-timer-ui';
const collapsed = new Set((() => {
  try { return JSON.parse(localStorage.getItem(UI_KEY))?.collapsed || []; } catch (_) { return []; }
})());

function setCollapsed(id, on) {
  if (on) collapsed.add(id); else collapsed.delete(id);
  try { localStorage.setItem(UI_KEY, JSON.stringify({ collapsed: [...collapsed] })); } catch (_) { /* ignore */ }
}

function paintCollapseAll() {
  const blocks = editing.items.filter((it) => it.type === 'intervals');
  const btn = $('collapse-all');
  const allCollapsed = blocks.every((it) => collapsed.has(it.id));
  btn.classList.toggle('hidden', !blocks.length);
  btn.classList.toggle('expand', allCollapsed);
  btn.querySelector('.collapse-all-label').textContent = allCollapsed ? 'Expand all' : 'Collapse all';
}

$('collapse-all').addEventListener('click', () => {
  const blocks = editing.items.filter((it) => it.type === 'intervals');
  const collapse = !blocks.every((it) => collapsed.has(it.id));
  for (const it of blocks) setCollapsed(it.id, collapse);
  renderEditor();
});

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

// Duplicate: the copy (including any unsaved edits) opens as a new draft; the original stays as saved.
$('duplicate').addEventListener('click', () => {
  const copy = reId({ ...structuredClone(editing), name: `${editing.name} (copy)` });
  openDraft(copy, { isNew: true, after: editing.id, dirty: true });
});

armToConfirm($('delete'), () => {
  store.workouts = store.workouts.filter((w) => w.id !== editing.id);
  save();
  openWorkouts();
}, 'Tap again to delete');

$('save').addEventListener('click', () => { saveDraft(); openWorkouts(); });
$('start').addEventListener('click', () => startWorkout(editing, 'edit'));

// ----- Running / done -----

$('pause').addEventListener('click', togglePause);
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
