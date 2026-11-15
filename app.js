'use strict';

// ---------------------------------------------------------------------------
// Data model
//
// Workout { id, name, prep, blocks: Block[] }
// Block   { name, rounds, rest, restAfter, steps: Step[] }
//           rest      = rest between rounds of this block
//           restAfter = rest before the next block
// Step    { name, dur, kind: 'work' | 'rest' }
// ---------------------------------------------------------------------------

const STORE_KEY = 'workout-timer-v2';
const OLD_KEY = 'workout-timer-plan-v1';

const uid = () => Math.random().toString(36).slice(2, 10);
const work = (name, dur) => ({ name, dur, kind: 'work' });
const rest = (dur) => ({ name: 'Rest', dur, kind: 'rest' });

function seedWorkouts() {
  return [
    {
      id: uid(), name: 'Intervals', prep: 10,
      blocks: [
        { name: 'Short', rounds: 5, rest: 15, restAfter: 60, steps: [work('Work', 30)] },
        { name: 'Long', rounds: 3, rest: 30, restAfter: 0, steps: [work('Work', 120)] },
      ],
    },
    {
      id: uid(), name: 'Tabata', prep: 10,
      blocks: [{ name: 'Tabata', rounds: 8, rest: 0, restAfter: 0, steps: [work('Work', 20), rest(10)] }],
    },
    {
      id: uid(), name: 'Circuit', prep: 10,
      blocks: [
        { name: 'Warm-up', rounds: 1, rest: 0, restAfter: 30, steps: [work('Jumping jacks', 120)] },
        {
          name: 'Circuit', rounds: 3, rest: 60, restAfter: 0,
          steps: [work('Squats', 40), rest(20), work('Push-ups', 40), rest(20), work('Plank', 40)],
        },
      ],
    },
  ];
}

function newWorkout() {
  return {
    id: uid(), name: 'New workout', prep: 10,
    blocks: [{ name: 'Block 1', rounds: 5, rest: 15, restAfter: 0, steps: [work('Work', 30)] }],
  };
}

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.workouts)) return s;
  } catch (_) { /* ignore */ }

  const workouts = seedWorkouts();
  // Migrate the single plan from the first version of the app, if present
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY));
    if (old && Array.isArray(old.blocks) && old.blocks.length) {
      workouts.unshift({
        id: uid(), name: 'My workout', prep: old.prep ?? 10,
        blocks: old.blocks.map((b) => ({
          name: b.name || 'Block', rounds: b.rounds || 1, rest: b.rest || 0, restAfter: b.restAfter || 0,
          steps: [work('Work', b.work || 30)],
        })),
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

/** Flatten a workout into a linear list of timed segments. */
function buildSegments(w) {
  const segs = [];
  if (w.prep > 0) segs.push({ type: 'prep', label: 'Get ready', dur: w.prep });
  w.blocks.forEach((b, bi) => {
    const steps = b.steps.filter((s) => s.dur > 0);
    if (!steps.length) return;
    for (let r = 1; r <= b.rounds; r++) {
      const info = { block: b.name, round: r, rounds: b.rounds };
      for (const s of steps) {
        segs.push({ type: s.kind, label: s.name || (s.kind === 'rest' ? 'Rest' : 'Work'), dur: s.dur, ...info });
      }
      if (r < b.rounds && b.rest > 0) segs.push({ type: 'rest', label: 'Rest', dur: b.rest, ...info });
    }
    if (bi < w.blocks.length - 1 && b.restAfter > 0) {
      segs.push({ type: 'rest', label: 'Rest', dur: b.restAfter, block: b.name });
    }
  });
  // A rest at the very end is pointless
  while (segs.length && segs[segs.length - 1].type === 'rest') segs.pop();
  return segs;
}

const totalOf = (segs) => segs.reduce((a, s) => a + s.dur, 0);
const hasWork = (segs) => segs.some((s) => s.type === 'work');

function blockDuration(b) {
  const perRound = b.steps.reduce((a, s) => a + s.dur, 0);
  return b.rounds * perRound + Math.max(0, b.rounds - 1) * b.rest;
}

function describeWorkout(w) {
  return w.blocks.map((b) => {
    const steps = b.steps.filter((s) => s.kind === 'work');
    if (steps.length === 1) return `${b.rounds}×${fmt(steps[0].dur)}`;
    return `${b.rounds}× ${b.name || 'circuit'}`;
  }).join(' · ');
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
  if (audioCtx.state === 'suspended') audioCtx.resume();
  chime(440, 0, 0.05, 0.0001); // silent blip so mobile browsers treat audio as started by a gesture
}

/**
 * Bell-like chime: a sine fundamental plus a few soft overtones, with a quick
 * attack and a natural exponential decay (no harsh square waves).
 */
function chime(freq, delay, decay, vol = 0.5) {
  if (!audioCtx) return;
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
 * Sustained tone (held, then released) rather than a struck chime. Same soft
 * overtones as chime() so it sits in the same family of sounds.
 */
function tone(freq, delay, hold, release, vol = 0.5) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + delay;
  for (const [mult, amp] of [[1, 1], [2, 0.3], [3, 0.08]]) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    const peak = Math.max(0.0002, vol * amp);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    gain.gain.setValueAtTime(peak, t + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + hold + release);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + hold + release + 0.05);
  }
}

/** Long beep confirming the workout has started. */
const startBeep = () => tone(1046.5, 0, 0.55, 0.2, 0.45);  // C6, ~0.75s

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
  if (segs[0].dur > 3) startBeep();
  else countdownBeep();

  show('run');
  renderRun();
  clearInterval(timer.interval);
  timer.interval = setInterval(tick, 50);
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
  timer.running = false;
  clearInterval(timer.interval);
  releaseWakeLock();
}

function stopWorkout() {
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
  if (timer.returnTo === 'edit' && findWorkout(timer.workout.id)) openEditor(timer.workout.id);
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
  $('run-block').textContent = seg.block && timer.workout.blocks.length > 1 ? seg.block : '';
  $('run-round').textContent = seg.rounds > 1 ? `Round ${seg.round}/${seg.rounds} · ` : '';
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

/** Bind a pill button to a duration (seconds) with a minutes/seconds wheel picker. */
function bindDuration(btn, title, get, set, maxSec = 3600) {
  btn.textContent = fmt(get());
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
        btn.textContent = fmt(next);
        edited();
      },
    });
  });
}

/** Bind a pill button to an integer count with a single wheel. */
function bindCount(btn, title, get, set, min = 1, max = 99) {
  btn.textContent = get();
  btn.addEventListener('click', () => {
    openPicker({
      title,
      anchor: btn,
      columns: [{ values: range(min, max), index: get() - min, unit: '' }],
      onChange: ([n]) => {
        set(n);
        btn.textContent = n;
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
  card.querySelector('.wo-total').textContent = fmt(totalOf(buildSegments(w)));
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
  const w = newWorkout();
  store.workouts.push(w);
  save();
  openEditor(w.id);
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
    row.append(text, el('span', 'list-value', fmt(totalOf(buildSegments(w)))));
    row.setAttribute('aria-label', `Edit ${w.name || 'workout'}`);
    row.addEventListener('click', () => openEditor(w.id));

    const handle = el('button', 'drag-handle');
    handle.type = 'button';
    handle.setAttribute('aria-label', `Reorder ${w.name || 'workout'} (drag, or use arrow keys)`);
    handle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
    bindDragHandle(handle, item);

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

/** Persist the workout order from the current DOM order of the list. */
function saveListOrder() {
  const ids = [...$('workout-list').querySelectorAll('.list-item')].map((n) => n.dataset.id);
  store.workouts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  save();
}

/**
 * Drag a row by its handle: the row follows the finger and the others slide
 * out of the way. On release the DOM is reordered and the new order saved.
 */
function bindDragHandle(handle, item) {
  handle.addEventListener('keydown', (e) => {
    const sib = e.key === 'ArrowUp' ? item.previousElementSibling : e.key === 'ArrowDown' ? item.nextElementSibling : null;
    if (!sib) return;
    e.preventDefault();
    if (e.key === 'ArrowUp') sib.before(item); else sib.after(item);
    saveListOrder();
    handle.focus();
  });

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);

    const items = [...item.parentElement.querySelectorAll('.list-item')];
    const from = items.indexOf(item);
    const rects = items.map((n) => n.getBoundingClientRect());
    const h = rects[from].height;
    const startY = e.clientY;
    let to = from;
    item.classList.add('dragging');
    items.forEach((n) => { if (n !== item) n.classList.add('shifting'); });

    const move = (ev) => {
      const dy = Math.max(rects[0].top - rects[from].top, Math.min(rects[items.length - 1].top - rects[from].top, ev.clientY - startY));
      item.style.transform = `translateY(${dy}px)`;
      const center = rects[from].top + h / 2 + dy;
      to = rects.findIndex((r) => center < r.bottom);
      if (to === -1) to = items.length - 1;
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
      items.forEach((n) => { n.classList.remove('dragging', 'shifting'); n.style.transform = ''; });
      if (to !== from) {
        if (to > from) items[to].after(item); else items[to].before(item);
        saveListOrder();
      }
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

let editing = null;

function openEditor(id) {
  editing = findWorkout(id);
  if (!editing) return openWorkouts();
  resetDeleteButton();
  renderEditor();
  show('edit');
}

function edited() {
  save();
  if (editing) updateSummaries();
}

function structureChanged() {
  save();
  renderEditor();
}

/** Replace a pill element with a fresh clone so old listeners are dropped. */
function freshPill(node) {
  const fresh = node.cloneNode(true);
  node.replaceWith(fresh);
  return fresh;
}

function renderEditor() {
  const w = editing;
  $('wo-name').value = w.name;
  bindDuration(freshPill($('prep')), 'Get ready', () => w.prep, (v) => { w.prep = v; }, 600);

  const container = $('blocks');
  container.replaceChildren();

  w.blocks.forEach((b, i) => {
    const node = clone('block-tpl');
    const isLast = i === w.blocks.length - 1;
    const label = b.name || `Block ${i + 1}`;

    const name = node.querySelector('.block-name');
    name.value = b.name;
    name.addEventListener('input', () => { b.name = name.value; save(); });

    const restRow = node.querySelector('.rest-row');
    restRow.classList.toggle('hidden', b.rounds < 2);
    bindCount(node.querySelector('.pill-rounds'), `${label}: rounds`, () => b.rounds, (n) => {
      b.rounds = n;
      restRow.classList.toggle('hidden', n < 2);
    });

    // Steps
    const stepsEl = node.querySelector('.steps');
    b.steps.forEach((s, si) => {
      const row = clone('step-tpl');
      const stepName = row.querySelector('.step-name');
      const kind = row.querySelector('.kind');
      const paintKind = () => {
        kind.textContent = s.kind === 'rest' ? 'Rest' : 'Work';
        kind.classList.toggle('is-rest', s.kind === 'rest');
      };
      paintKind();
      kind.addEventListener('click', () => {
        s.kind = s.kind === 'rest' ? 'work' : 'rest';
        if (s.name === 'Work' && s.kind === 'rest') s.name = 'Rest';
        else if (s.name === 'Rest' && s.kind === 'work') s.name = 'Work';
        stepName.value = s.name;
        paintKind();
        edited();
      });

      stepName.value = s.name;
      stepName.addEventListener('input', () => { s.name = stepName.value; save(); });

      bindDuration(row.querySelector('.dur'), s.name || (s.kind === 'rest' ? 'Rest' : 'Work'),
        () => s.dur, (v) => { s.dur = v; });

      const remove = row.querySelector('[data-act="remove-step"]');
      remove.disabled = b.steps.length === 1;
      remove.addEventListener('click', () => {
        if (b.steps.length > 1) { b.steps.splice(si, 1); structureChanged(); }
      });
      stepsEl.appendChild(row);
    });

    node.querySelector('.add-step').addEventListener('click', () => {
      const lastStep = b.steps[b.steps.length - 1];
      const step = lastStep.kind === 'work' ? rest(15) : work('', 30);
      b.steps.push(step);
      structureChanged();
      if (step.kind === 'work') {
        const names = $('blocks').children[i].querySelectorAll('.step-name');
        names[names.length - 1].focus();
      }
    });

    bindDuration(node.querySelector('.pill-rest'), 'Rest between rounds', () => b.rest, (v) => { b.rest = v; });
    bindDuration(node.querySelector('.pill-rest-after'), 'Rest after block', () => b.restAfter, (v) => { b.restAfter = v; });
    node.querySelector('.rest-after-row').classList.toggle('hidden', isLast);

    node.querySelector('[data-act="up"]').disabled = i === 0;
    node.querySelector('[data-act="down"]').disabled = isLast;
    node.querySelector('[data-act="remove"]').disabled = w.blocks.length === 1;
    node.querySelector('.block-actions').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      const bl = w.blocks;
      if (act === 'up' && i > 0) [bl[i - 1], bl[i]] = [bl[i], bl[i - 1]];
      else if (act === 'down' && !isLast) [bl[i + 1], bl[i]] = [bl[i], bl[i + 1]];
      else if (act === 'remove' && bl.length > 1) bl.splice(i, 1);
      else return;
      structureChanged();
    });

    container.appendChild(node);
  });

  updateSummaries();
}

function updateSummaries() {
  const w = editing;
  document.querySelectorAll('#blocks .block').forEach((node, i) => {
    const b = w.blocks[i];
    node.querySelector('.block-summary').textContent =
      `${b.rounds} round${b.rounds === 1 ? '' : 's'} · ${fmt(blockDuration(b))}`;
  });
  const segs = buildSegments(w);
  $('total-time').textContent = fmt(totalOf(segs));
  $('start').disabled = !hasWork(segs);
}

$('wo-name').addEventListener('input', (e) => { editing.name = e.target.value; save(); });
$('wo-name').addEventListener('change', (e) => {
  if (!editing.name.trim()) { editing.name = 'Untitled'; e.target.value = editing.name; save(); }
});

$('edit-back').addEventListener('click', openWorkouts);

$('add-block').addEventListener('click', () => {
  const blocks = editing.blocks;
  const last = blocks[blocks.length - 1];
  if (!last.restAfter) last.restAfter = 60;
  blocks.push({ ...structuredClone(last), name: `Block ${blocks.length + 1}`, restAfter: 0 });
  structureChanged();
});

$('duplicate').addEventListener('click', () => {
  const copy = { ...structuredClone(editing), id: uid(), name: `${editing.name} (copy)` };
  store.workouts.splice(store.workouts.indexOf(editing) + 1, 0, copy);
  save();
  openEditor(copy.id);
});

// Delete needs a second tap within 3 seconds (no browser dialogs)
let deleteArmed = null;
function resetDeleteButton() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  $('delete').textContent = 'Delete';
}
$('delete').addEventListener('click', () => {
  if (!deleteArmed) {
    $('delete').textContent = 'Tap again to delete';
    deleteArmed = setTimeout(resetDeleteButton, 3000);
    return;
  }
  resetDeleteButton();
  store.workouts = store.workouts.filter((w) => w !== editing);
  save();
  openWorkouts();
});

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
