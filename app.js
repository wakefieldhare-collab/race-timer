// ── Event Configuration ──
const EVENTS = {
  '800m':         { laps: 2, relay: false },
  '1600m':        { laps: 4, relay: false },
  '4x400m Relay': { laps: 4, relay: true },
};

function isRelay(event) {
  return !!(EVENTS[event] && EVENTS[event].relay);
}

function splitLabel(event, n) {
  return isRelay(event) ? `Leg ${n}` : `L${n}`;
}

const LANE_COLORS = ['#4ecca3', '#e9a045', '#45a0e9', '#d96bd3'];
const MAX_RUNNERS = 4;

// ── Data Layer ──
const API_BASE = 'https://gtf-desktop.tail98708b.ts.net:3457';
const CACHE_KEY = 'raceTimerCache';
const MEET_KEY = 'raceTimerMeet';

const DEFAULT_DATA = { athletes: [], races: [] };
let data = { ...DEFAULT_DATA, athletes: [], races: [] };
let serverConnected = false;

function updateConnectionStatus(connected) {
  serverConnected = connected;
  const dot = document.getElementById('connStatus');
  if (dot) {
    dot.className = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
    dot.title = connected ? 'Server connected' : 'Offline -- data saved locally only';
  }
}

async function checkConnection() {
  try {
    const res = await fetch(API_BASE + '/api/data', { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    updateConnectionStatus(res.ok);
  } catch {
    updateConnectionStatus(false);
  }
}

setInterval(checkConnection, 30000);

async function loadData() {
  try {
    const res = await fetch(API_BASE + '/api/data', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const d = await res.json();
      updateConnectionStatus(true);
      const cached = getLocalCache();
      if (cached && cached.races && cached.races.length > 0) {
        const serverIds = new Set(d.races.map(r => r.id));
        const localOnly = cached.races.filter(r => !serverIds.has(r.id));
        if (localOnly.length > 0) {
          d.races = [...localOnly, ...d.races];
          d.races.sort((a, b) => new Date(b.date) - new Date(a.date));
          fetch(API_BASE + '/api/data', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(d)
          }).catch(() => {});
        }
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(d));
      return d;
    }
  } catch { /* server unreachable */ }
  updateConnectionStatus(false);
  const cached = getLocalCache();
  if (cached) return cached;
  return { ...DEFAULT_DATA, athletes: [], races: [] };
}

function getLocalCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

function saveData(d) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(d));
  fetch(API_BASE + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(d)
  }).then(res => {
    if (res.ok) { updateConnectionStatus(true); return res.json(); }
    throw new Error('Server save failed');
  }).catch(() => {
    updateConnectionStatus(false);
  });
}

function generateId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Format Time ──
function formatTime(ms) {
  const totalSec = ms / 1000;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const sec = Math.floor(seconds);
  const hundredths = Math.floor((seconds - sec) * 100);
  return `${minutes}:${sec.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
}

// ── PR Detection ──
function getAthleteEventPR(athleteId, event, excludeRaceId) {
  let bestMs = Infinity;
  for (const race of data.races) {
    if (race.id === excludeRaceId) continue;
    if (race.event !== event) continue;
    for (const entry of race.entries) {
      if (entry.athleteId === athleteId && entry.status === 'finished' && entry.totalMs < bestMs) {
        bestMs = entry.totalMs;
      }
    }
  }
  return bestMs === Infinity ? null : bestMs;
}

function isEntryPR(entry, event, raceId) {
  if (entry.status !== 'finished') return false;
  const prev = getAthleteEventPR(entry.athleteId, event, raceId);
  if (prev === null) return true;
  return entry.totalMs < prev;
}

function getPRDiff(entry, event, raceId) {
  const prev = getAthleteEventPR(entry.athleteId, event, raceId);
  if (prev === null) return null;
  const diff = entry.totalMs - prev;
  if (diff < 0) return { improved: true, text: '-' + formatTime(Math.abs(diff)) };
  return { improved: false, text: '+' + formatTime(diff) };
}

function showPRToast() {
  const toast = document.getElementById('prToast');
  toast.classList.add('show');
  if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
  setTimeout(() => { toast.classList.remove('show'); }, 2000);
}

// ── Haptic ──
function hapticTap() {
  if (navigator.vibrate) navigator.vibrate(40);
}

// ── Sound ──
// Synthesized via Web Audio API -- no external files, works offline.
// AudioContext must be created/resumed from a user gesture, which is always
// the case here (first sound fires from the Start button click).
let audioCtx = null;
function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(freq, startOffset, dur, peakGain) {
  const ctx = audioCtx;
  const t = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peakGain, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// Short single ding: start and each lap tap.
function playDing() {
  try {
    if (!ensureAudioCtx()) return;
    playTone(880, 0, 0.3, 0.3);
  } catch { /* non-critical */ }
}

// Two-note descending chime for race completion. Starts on the lap-ding
// pitch (880 Hz) and drops a major third down to 660 Hz so the runner
// clearly hears that the race is over, not just another lap.
function playFinishChime() {
  try {
    if (!ensureAudioCtx()) return;
    playTone(880, 0,    0.35, 0.35);
    playTone(660, 0.18, 0.55, 0.35);
  } catch { /* non-critical */ }
}

// ── Wake Lock ──
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* non-critical */ }
}
function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// ── App State ──
let appState = 'setup'; // 'setup' | 'racing' | 'review'
let selectedEvent = '800m';
let selectedAthleteIds = [];

// Active race state (only populated during racing/review)
let activeRace = null;
let raceStartTime = 0;
let masterElapsed = 0;
let rafId = null;

// Undo tracking
let undoTarget = null; // { entryIndex, timeout }

// DNF long-press tracking
let longPressTimer = null;
let longPressIndex = null;
let dnfHintEl = null;

// ── DOM Refs ──
const setupSection = document.getElementById('setupSection');
const racingSection = document.getElementById('racingSection');
const reviewSection = document.getElementById('reviewSection');
const meetInput = document.getElementById('meetInput');
const athleteGrid = document.getElementById('athleteGrid');
const selectionCounter = document.getElementById('selectionCounter');
const startBtn = document.getElementById('startBtn');
const masterClock = document.getElementById('masterClock');
const raceHeader = document.getElementById('raceHeader');
const runnerButtons = document.getElementById('runnerButtons');
const endRaceBtn = document.getElementById('endRaceBtn');

// ── Meet Name Persistence ──
meetInput.value = localStorage.getItem(MEET_KEY) || '';
meetInput.addEventListener('input', () => {
  localStorage.setItem(MEET_KEY, meetInput.value);
});

// ── Event Toggle ──
function updateRosterLabel() {
  const labelEl = document.getElementById('rosterLabelText');
  if (labelEl) labelEl.textContent = isRelay(selectedEvent) ? 'Select teams' : 'Select runners';
}

document.getElementById('eventToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !btn.dataset.event) return;
  selectedEvent = btn.dataset.event;
  document.querySelectorAll('#eventToggle button').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  updateRosterLabel();
});

// ── Athlete Selection Grid ──
function renderAthleteGrid() {
  if (data.athletes.length === 0) {
    athleteGrid.innerHTML = '<div class="empty-roster">No athletes yet. Add some in Settings.</div>';
    updateStartButton();
    return;
  }
  athleteGrid.innerHTML = data.athletes.map(ath => {
    const selIndex = selectedAthleteIds.indexOf(ath.id);
    const isSelected = selIndex !== -1;
    const color = isSelected ? LANE_COLORS[selIndex] : '#0f3460';
    const atMax = selectedAthleteIds.length >= MAX_RUNNERS && !isSelected;
    const cls = 'athlete-chip' + (isSelected ? ' selected' : '') + (atMax ? ' disabled' : '');
    return `<div class="${cls}" data-id="${ath.id}" style="--lane-color: ${color}">${ath.name}</div>`;
  }).join('');

  athleteGrid.querySelectorAll('.athlete-chip').forEach(chip => {
    chip.addEventListener('click', () => toggleAthleteSelection(chip.dataset.id));
  });

  updateSelectionCounter();
  updateStartButton();
}

function toggleAthleteSelection(athleteId) {
  const idx = selectedAthleteIds.indexOf(athleteId);
  if (idx !== -1) {
    selectedAthleteIds.splice(idx, 1);
  } else {
    if (selectedAthleteIds.length >= MAX_RUNNERS) return;
    selectedAthleteIds.push(athleteId);
  }
  renderAthleteGrid();
}

function updateSelectionCounter() {
  const count = selectedAthleteIds.length;
  selectionCounter.textContent = `(${count}/${MAX_RUNNERS})`;
  selectionCounter.className = 'selection-counter' + (count >= MAX_RUNNERS ? ' full' : '');
}

function updateStartButton() {
  startBtn.disabled = selectedAthleteIds.length === 0;
}

// ── Screen Transitions ──
function showSetup() {
  appState = 'setup';
  setupSection.classList.remove('hidden');
  racingSection.classList.remove('active');
  reviewSection.classList.remove('active');
  setTabsDisabled(false);
  renderAthleteGrid();
}

function showRacing() {
  appState = 'racing';
  setupSection.classList.add('hidden');
  racingSection.classList.add('active');
  reviewSection.classList.remove('active');
  setTabsDisabled(true);
}

function showReview() {
  appState = 'review';
  setupSection.classList.add('hidden');
  racingSection.classList.remove('active');
  reviewSection.classList.add('active');
  setTabsDisabled(true);
}

function setTabsDisabled(disabled) {
  document.getElementById('tabHistory').classList.toggle('disabled', disabled);
  document.getElementById('tabSettings').classList.toggle('disabled', disabled);
}

// ── START Race ──
startBtn.addEventListener('click', () => {
  if (selectedAthleteIds.length === 0) return;
  hapticTap();
  playDing();

  const lapsRequired = EVENTS[selectedEvent].laps;
  activeRace = {
    event: selectedEvent,
    lapsRequired: lapsRequired,
    meet: meetInput.value.trim() || null,
    startTimeISO: new Date().toISOString(),
    entries: selectedAthleteIds.map((id, i) => {
      const ath = data.athletes.find(a => a.id === id);
      return {
        athleteId: id,
        athleteName: ath ? ath.name : 'Unknown',
        color: LANE_COLORS[i],
        status: 'active',
        laps: [],
        lastLapTime: 0,
        lastTapTime: 0,
        totalMs: null
      };
    })
  };

  raceHeader.textContent = `${selectedEvent}${activeRace.meet ? '  -  ' + activeRace.meet : ''}`;
  raceStartTime = performance.now();
  masterElapsed = 0;
  masterClock.textContent = '0:00.00';

  renderRunnerButtons();
  showRacing();
  tickMaster();
  requestWakeLock();
});

// ── Master Clock ──
function tickMaster() {
  masterElapsed = performance.now() - raceStartTime;
  masterClock.textContent = formatTime(masterElapsed);
  rafId = requestAnimationFrame(tickMaster);
}

function stopMasterClock() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  masterElapsed = performance.now() - raceStartTime;
  masterClock.textContent = formatTime(masterElapsed);
  releaseWakeLock();
}

// ── Runner Buttons ──
function renderRunnerButtons() {
  runnerButtons.innerHTML = activeRace.entries.map((entry, i) => {
    return `<div class="runner-btn ${entry.status === 'finished' ? 'finished' : ''} ${entry.status === 'dnf' ? 'dnf' : ''}"
                 data-index="${i}"
                 style="background: color-mix(in srgb, ${entry.color} 30%, #16213e);"
                 id="runnerBtn${i}">
      ${renderRunnerBtnContent(entry, i)}
    </div>`;
  }).join('');

  // Attach event handlers
  runnerButtons.querySelectorAll('.runner-btn').forEach(btn => {
    const idx = parseInt(btn.dataset.index);
    btn.addEventListener('pointerdown', (e) => onRunnerPointerDown(idx, e));
    btn.addEventListener('pointerup', (e) => onRunnerPointerUp(idx, e));
    btn.addEventListener('pointerleave', (e) => onRunnerPointerLeave(idx, e));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // Attach undo handlers
  runnerButtons.querySelectorAll('.undo-label').forEach(label => {
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      doUndo();
    });
  });
}

function renderRunnerBtnContent(entry, index) {
  const lapsRequired = activeRace.lapsRequired;

  if (entry.status === 'finished') {
    return `
      <div class="runner-btn-top">
        <span class="runner-btn-name">${entry.athleteName}</span>
        <span class="runner-btn-lap">DONE</span>
      </div>
      <div class="runner-btn-status">Finished: ${formatTime(entry.totalMs)}</div>
    `;
  }

  if (entry.status === 'dnf') {
    return `
      <div class="runner-btn-top">
        <span class="runner-btn-name">${entry.athleteName}</span>
        <span class="runner-btn-lap">${entry.laps.length}/${lapsRequired}</span>
      </div>
      <div class="runner-btn-status">DNF</div>
    `;
  }

  // Active runner
  const lapCount = entry.laps.length;
  const lastLap = lapCount > 0 ? entry.laps[lapCount - 1] : null;
  const showUndo = undoTarget && undoTarget.entryIndex === index;

  let timesHtml = '';
  if (lastLap) {
    timesHtml = `
      <div class="runner-btn-times">
        <span>Split: ${formatTime(lastLap.splitMs)}</span>
        <span>Elapsed: ${formatTime(lastLap.elapsedMs)}</span>
      </div>
    `;
  }

  const nextLap = lapCount + 1;
  const unit = isRelay(activeRace.event) ? 'Leg' : 'L';
  const lapLabel = nextLap >= lapsRequired ? 'FINISH' : `${unit}${unit === 'Leg' ? ' ' : ''}${nextLap}/${lapsRequired}`;

  return `
    <div class="runner-btn-top">
      <span class="runner-btn-name">${entry.athleteName}</span>
      <span class="runner-btn-lap">${lapLabel}</span>
    </div>
    ${timesHtml}
    ${showUndo ? '<div class="undo-label">Undo</div>' : ''}
  `;
}

function updateRunnerButton(index) {
  const btn = document.getElementById('runnerBtn' + index);
  if (!btn) return;
  const entry = activeRace.entries[index];
  btn.className = `runner-btn ${entry.status === 'finished' ? 'finished' : ''} ${entry.status === 'dnf' ? 'dnf' : ''}`;
  btn.innerHTML = renderRunnerBtnContent(entry, index);

  // Re-attach undo handler if present
  const undoLabel = btn.querySelector('.undo-label');
  if (undoLabel) {
    undoLabel.addEventListener('click', (e) => {
      e.stopPropagation();
      doUndo();
    });
  }
}

// ── Runner Button Tap / Long-Press ──
function onRunnerPointerDown(index, e) {
  const entry = activeRace.entries[index];
  if (entry.status !== 'active') return;
  e.preventDefault();

  // Start long-press timer for DNF
  longPressIndex = index;
  longPressTimer = setTimeout(() => {
    // Show DNF hint overlay
    const btn = document.getElementById('runnerBtn' + index);
    if (btn) {
      dnfHintEl = document.createElement('div');
      dnfHintEl.className = 'dnf-hint';
      dnfHintEl.textContent = 'DNF -- Release to confirm';
      btn.appendChild(dnfHintEl);
    }
  }, 600);
}

function onRunnerPointerUp(index, e) {
  const entry = activeRace.entries[index];
  if (entry.status !== 'active') return;
  e.preventDefault();

  // Check if long-press completed (>1s)
  if (dnfHintEl) {
    // DNF confirmed
    clearTimeout(longPressTimer);
    longPressTimer = null;
    removeDnfHint();
    doDNF(index);
    return;
  }

  // Clear long-press timer
  clearTimeout(longPressTimer);
  longPressTimer = null;
  longPressIndex = null;

  // Normal tap -- record lap
  doRunnerTap(index);
}

function onRunnerPointerLeave(index, e) {
  // Cancel long-press if finger moves off button
  clearTimeout(longPressTimer);
  longPressTimer = null;
  longPressIndex = null;
  removeDnfHint();
}

function removeDnfHint() {
  if (dnfHintEl) {
    dnfHintEl.remove();
    dnfHintEl = null;
  }
}

// ── Record Lap for Runner ──
function doRunnerTap(index) {
  const entry = activeRace.entries[index];
  if (entry.status !== 'active') return;

  // Per-runner debounce (400ms)
  const now = Date.now();
  if (now - entry.lastTapTime < 400) return;
  entry.lastTapTime = now;

  hapticTap();
  playDing();

  const elapsed = performance.now() - raceStartTime;
  const split = elapsed - entry.lastLapTime;
  entry.laps.push({ splitMs: Math.round(split), elapsedMs: Math.round(elapsed) });
  entry.lastLapTime = elapsed;

  // Clear previous undo
  clearUndo();

  // Check if this was the final lap
  if (entry.laps.length >= activeRace.lapsRequired) {
    entry.status = 'finished';
    entry.totalMs = Math.round(elapsed);
    updateRunnerButton(index);
    checkRaceComplete();
    return;
  }

  // Set undo target for this tap
  undoTarget = {
    entryIndex: index,
    timeout: setTimeout(() => {
      undoTarget = null;
      updateRunnerButton(index);
    }, 3000)
  };

  updateRunnerButton(index);
}

// ── Undo Last Tap ──
function doUndo() {
  if (!undoTarget) return;
  const entry = activeRace.entries[undoTarget.entryIndex];
  const idx = undoTarget.entryIndex;

  if (entry.laps.length === 0) return;

  // Remove last lap
  entry.laps.pop();

  // Restore lastLapTime
  if (entry.laps.length > 0) {
    entry.lastLapTime = entry.laps[entry.laps.length - 1].elapsedMs;
  } else {
    entry.lastLapTime = 0;
  }

  // If runner was finished, revert to active
  if (entry.status === 'finished') {
    entry.status = 'active';
    entry.totalMs = null;
  }

  clearUndo();
  updateRunnerButton(idx);
}

function clearUndo() {
  if (undoTarget) {
    clearTimeout(undoTarget.timeout);
    // Update the old target button to remove undo label
    const oldIdx = undoTarget.entryIndex;
    undoTarget = null;
    updateRunnerButton(oldIdx);
  }
}

// ── DNF ──
function doDNF(index) {
  const entry = activeRace.entries[index];
  entry.status = 'dnf';
  entry.totalMs = null;
  hapticTap();
  clearUndo();
  updateRunnerButton(index);
  checkRaceComplete();
}

// ── Check if All Runners Done ──
function checkRaceComplete() {
  const allDone = activeRace.entries.every(e => e.status === 'finished' || e.status === 'dnf');
  if (allDone) {
    playFinishChime();
    stopMasterClock();
    transitionToReview();
  }
}

// ── End Race (manual) ──
endRaceBtn.addEventListener('click', () => {
  if (!confirm('End race? Active runners will be marked DNF.')) return;
  playFinishChime();
  // Mark remaining active runners as DNF
  activeRace.entries.forEach(entry => {
    if (entry.status === 'active') {
      entry.status = 'dnf';
      entry.totalMs = null;
    }
  });
  clearUndo();
  stopMasterClock();
  transitionToReview();
});

// ── Transition to Review ──
function transitionToReview() {
  renderReview();
  showReview();
}

// ── Review Screen ──
function renderReview() {
  const d = new Date(activeRace.startTimeISO);
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  reviewHeader.innerHTML = `${activeRace.event}${activeRace.meet ? '  -  ' + activeRace.meet : ''}<br><span class="review-date">${dateStr}  ${timeStr}</span>`;

  // Sort: finished by totalMs, then DNF
  const sorted = [...activeRace.entries].sort((a, b) => {
    if (a.status === 'finished' && b.status !== 'finished') return -1;
    if (a.status !== 'finished' && b.status === 'finished') return 1;
    if (a.status === 'finished' && b.status === 'finished') return a.totalMs - b.totalMs;
    return 0;
  });

  const raceId = 'preview'; // temp ID for PR check
  let place = 0;

  reviewResults.innerHTML = sorted.map(entry => {
    const isFinished = entry.status === 'finished';
    let placeLabel = '';
    if (isFinished) {
      place++;
      const ordinals = ['1st', '2nd', '3rd'];
      placeLabel = ordinals[place - 1] || `${place}th`;
    } else {
      placeLabel = 'DNF';
    }

    const pr = isFinished ? isEntryPR(entry, activeRace.event, raceId) : false;
    const prDiff = isFinished ? getPRDiff(entry, activeRace.event, raceId) : null;
    const prBadge = pr ? '<span class="pr-badge">PR</span>' : '';
    const prDiffHtml = prDiff ? `<span class="pr-diff ${prDiff.improved ? 'improved' : ''}">${prDiff.text}</span>` : '';

    const splitsHtml = entry.laps.map((l, i) =>
      `<span class="review-split-chip">${splitLabel(activeRace.event, i + 1)}: ${formatTime(l.splitMs)}</span>`
    ).join('');

    return `
      <div class="review-entry ${pr ? 'is-pr' : ''}">
        <div class="review-entry-header">
          <span>
            <span class="review-place">${placeLabel}</span>
            <span class="review-name" style="color: ${entry.color}">${entry.athleteName}</span>
            ${prBadge}
          </span>
          ${isFinished ? `<span class="review-time">${formatTime(entry.totalMs)}${prDiffHtml}</span>` : ''}
        </div>
        <div class="review-splits">${splitsHtml}</div>
      </div>
    `;
  }).join('');
}

// ── Save Race ──
document.getElementById('reviewSaveBtn').addEventListener('click', () => {
  const race = {
    id: generateId('race'),
    event: activeRace.event,
    lapsRequired: activeRace.lapsRequired,
    meet: activeRace.meet,
    date: activeRace.startTimeISO,
    entries: activeRace.entries.map(e => ({
      athleteId: e.athleteId,
      athleteName: e.athleteName,
      color: e.color,
      status: e.status,
      laps: e.laps.map(l => ({ splitMs: l.splitMs, elapsedMs: l.elapsedMs })),
      totalMs: e.totalMs
    }))
  };

  // Check for PRs before adding
  let hasPR = false;
  for (const entry of race.entries) {
    if (isEntryPR(entry, race.event, race.id)) {
      hasPR = true;
      break;
    }
  }

  data.races.unshift(race);
  saveData(data);

  if (hasPR) showPRToast();
  activeRace = null;
  showSetup();
});

// ── Discard Race ──
document.getElementById('reviewDiscardBtn').addEventListener('click', () => {
  if (!confirm('Discard this race without saving?')) return;
  activeRace = null;
  showSetup();
});

// ── Share from Review ──
document.getElementById('reviewShareBtn').addEventListener('click', () => {
  if (activeRace) shareRace(activeRace);
});

// ── Share Logic ──
function buildRaceShareText(race) {
  let text = `${race.event}`;
  if (race.meet) text += ` - ${race.meet}`;

  const d = new Date(race.startTimeISO || race.date);
  text += `\n${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const sorted = [...race.entries].sort((a, b) => {
    if (a.status === 'finished' && b.status !== 'finished') return -1;
    if (a.status !== 'finished' && b.status === 'finished') return 1;
    if (a.status === 'finished' && b.status === 'finished') return a.totalMs - b.totalMs;
    return 0;
  });

  let place = 0;
  for (const entry of sorted) {
    if (entry.status === 'finished') {
      place++;
      const ordinals = ['1st', '2nd', '3rd'];
      const placeLabel = ordinals[place - 1] || `${place}th`;
      text += `\n\n${placeLabel} ${entry.athleteName}  ${formatTime(entry.totalMs)}`;
    } else {
      text += `\n\nDNF ${entry.athleteName}`;
    }
    if (entry.laps.length > 0) {
      const splits = entry.laps.map((l, i) => `${splitLabel(race.event, i + 1)} ${formatTime(l.splitMs)}`).join(' | ');
      text += `\n  ${splits}`;
    }
  }
  return text;
}

function shareRace(race) {
  const text = buildRaceShareText(race);
  if (navigator.share) {
    navigator.share({ text }).catch(() => {});
  } else {
    window.location.href = 'sms:?body=' + encodeURIComponent(text);
  }
}

// ── Tab Navigation ──
const tabs = document.querySelectorAll('.tab-bar button');
const views = document.querySelectorAll('.view');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.classList.contains('disabled')) return;
    tabs.forEach(t => t.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'View').classList.add('active');

    if (tab.dataset.tab === 'timer') {
      renderAthleteGrid();
    }
    if (tab.dataset.tab === 'history') {
      loadData().then(d => { data = d; renderHistory(); });
    }
    if (tab.dataset.tab === 'settings') {
      loadData().then(d => { data = d; renderSettings(); });
    }
  });
});

// ── History View ──
const filterAthlete = document.getElementById('filterAthlete');
const filterEvent = document.getElementById('filterEvent');
const filterMeet = document.getElementById('filterMeet');
const raceList = document.getElementById('raceList');

function populateFilters() {
  // Athletes from race data (not just roster, in case athletes were deleted)
  const athleteNames = new Map();
  for (const race of data.races) {
    for (const entry of race.entries) {
      athleteNames.set(entry.athleteId, entry.athleteName);
    }
  }
  filterAthlete.innerHTML = '<option value="all">All Athletes</option>' +
    [...athleteNames.entries()].map(([id, name]) => `<option value="${id}">${name}</option>`).join('');

  filterEvent.innerHTML = '<option value="all">All Events</option>' +
    Object.keys(EVENTS).map(e => `<option value="${e}">${e}</option>`).join('');

  const meets = [...new Set(data.races.map(r => r.meet).filter(Boolean))];
  filterMeet.innerHTML = '<option value="all">All Meets</option>' +
    meets.map(m => `<option value="${m}">${m}</option>`).join('');
}

function renderHistory() {
  populateFilters();
  const fa = filterAthlete.value;
  const fe = filterEvent.value;
  const fm = filterMeet.value;

  let races = data.races;
  if (fa !== 'all') races = races.filter(r => r.entries.some(e => e.athleteId === fa));
  if (fe !== 'all') races = races.filter(r => r.event === fe);
  if (fm !== 'all') races = races.filter(r => r.meet === fm);

  if (races.length === 0) {
    raceList.innerHTML = '<div class="empty-state">No races recorded yet.<br>Start timing!</div>';
    return;
  }

  // Group by meet
  const groups = [];
  let currentGroup = null;
  for (const race of races) {
    const meetKey = race.meet || null;
    const dateKey = new Date(race.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const groupKey = meetKey || dateKey;
    if (!currentGroup || currentGroup.key !== groupKey) {
      currentGroup = { key: groupKey, meet: meetKey, date: dateKey, races: [] };
      groups.push(currentGroup);
    }
    currentGroup.races.push(race);
  }

  let html = '';
  for (const group of groups) {
    if (group.meet) {
      html += `<div class="meet-header">${group.meet}<span class="meet-date">${group.date}</span></div>`;
    } else {
      html += `<div class="meet-header">${group.date}</div>`;
    }
    for (const race of group.races) {
      html += renderRaceCard(race, fa);
    }
  }

  raceList.innerHTML = html;

  raceList.querySelectorAll('.share-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const race = data.races.find(r => r.id === btn.dataset.id);
      if (race) shareRace(race);
    });
  });

  raceList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this race?')) {
        data.races = data.races.filter(r => r.id !== btn.dataset.id);
        saveData(data);
        renderHistory();
      }
    });
  });
}

function renderRaceCard(race, highlightAthleteId) {
  const d = new Date(race.date);
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Sort entries
  const sorted = [...race.entries].sort((a, b) => {
    if (a.status === 'finished' && b.status !== 'finished') return -1;
    if (a.status !== 'finished' && b.status === 'finished') return 1;
    if (a.status === 'finished' && b.status === 'finished') return a.totalMs - b.totalMs;
    return 0;
  });

  let place = 0;
  let hasAnyPR = false;

  const entriesHtml = sorted.map(entry => {
    const isFinished = entry.status === 'finished';
    let placeLabel = '';
    if (isFinished) {
      place++;
      const ordinals = ['1st', '2nd', '3rd'];
      placeLabel = ordinals[place - 1] || `${place}th`;
    } else {
      placeLabel = 'DNF';
    }

    const pr = isFinished ? isEntryPR(entry, race.event, race.id) : false;
    if (pr) hasAnyPR = true;
    const prDiff = isFinished ? getPRDiff(entry, race.event, race.id) : null;
    const prBadge = pr ? '<span class="pr-badge">PR</span>' : '';
    const prDiffHtml = prDiff ? `<span class="pr-diff ${prDiff.improved ? 'improved' : ''}">${prDiff.text}</span>` : '';

    const splitsHtml = entry.laps.map((l, i) =>
      `<span class="entry-split-chip">${splitLabel(race.event, i + 1)}: ${formatTime(l.splitMs)}</span>`
    ).join('');

    const isHighlighted = highlightAthleteId && highlightAthleteId !== 'all' && entry.athleteId === highlightAthleteId;

    return `
      <div class="race-card-entry" ${isHighlighted ? 'style="background: rgba(255,255,255,0.03); border-radius: 6px; padding: 6px;"' : ''}>
        <div class="race-card-entry-header">
          <span>
            <span class="entry-place">${placeLabel}</span>
            <span class="entry-name" style="color: ${entry.color}">${entry.athleteName}</span>
            ${prBadge}
          </span>
          ${isFinished ? `<span class="entry-total">${formatTime(entry.totalMs)}${prDiffHtml}</span>` : ''}
        </div>
        <div class="entry-splits">${splitsHtml}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="race-card ${hasAnyPR ? 'is-pr' : ''}">
      <div class="race-card-event">
        <span class="event-label">${race.event}</span>
        <span class="race-time">${timeStr}</span>
      </div>
      ${entriesHtml}
      <div class="race-card-actions">
        <button class="share-btn" data-id="${race.id}" title="Share">&#9993; Share</button>
        <button class="delete-btn" data-id="${race.id}" title="Delete">&times; Delete</button>
      </div>
    </div>
  `;
}

filterAthlete.addEventListener('change', renderHistory);
filterEvent.addEventListener('change', renderHistory);
filterMeet.addEventListener('change', renderHistory);

// ── Settings View ──
function renderSettings() {
  const listEdit = document.getElementById('athleteListEdit');
  listEdit.innerHTML = data.athletes.map(ath => `
    <div class="editable-item">
      <span>${ath.name}</span>
      <button data-id="${ath.id}">&times;</button>
    </div>
  `).join('');

  listEdit.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      data.athletes = data.athletes.filter(a => a.id !== btn.dataset.id);
      selectedAthleteIds = selectedAthleteIds.filter(id => id !== btn.dataset.id);
      saveData(data);
      renderSettings();
    });
  });

  updateRecoveryStatus();
}

function updateRecoveryStatus() {
  const el = document.getElementById('recoveryStatus');
  if (!el) return;
  const cached = getLocalCache();
  const localRaces = cached ? (cached.races || []).length : 0;
  const serverRaces = data.races.length;

  if (localRaces > 0 && localRaces > serverRaces) {
    el.innerHTML = `<div class="recovery-alert">Found ${localRaces} races in local cache (server has ${serverRaces}). <button id="recoverLocalBtn" class="recover-btn">Recover Local Data</button></div>`;
    document.getElementById('recoverLocalBtn').addEventListener('click', recoverFromLocal);
  } else {
    el.innerHTML = `<div class="recovery-info">${serverRaces} races on server, ${localRaces} in local cache.</div>`;
  }
}

async function recoverFromLocal() {
  const cached = getLocalCache();
  if (!cached || !cached.races || cached.races.length === 0) {
    alert('No local data to recover.');
    return;
  }
  try {
    const res = await fetch(API_BASE + '/api/recover', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ races: cached.races })
    });
    if (res.ok) {
      const result = await res.json();
      alert(`Recovered ${result.recovered} races! Total: ${result.raceCount}`);
      loadData().then(d => { data = d; renderSettings(); });
    } else {
      alert('Recovery failed. Server may be unreachable.');
    }
  } catch {
    alert('Could not reach server for recovery.');
  }
}

// Add athlete
document.getElementById('addAthleteBtn').addEventListener('click', () => {
  const input = document.getElementById('newAthleteInput');
  const name = input.value.trim();
  if (!name) return;
  if (data.athletes.some(a => a.name === name)) return alert('Athlete already exists.');
  data.athletes.push({ id: generateId('ath'), name: name });
  saveData(data);
  input.value = '';
  renderSettings();
});

// Handle enter key on athlete input
document.getElementById('newAthleteInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('addAthleteBtn').click();
  }
});

// Export
document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `race-timer-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Visibility Change (re-acquire wake lock) ──
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && appState === 'racing') {
    requestWakeLock();
  }
});

// ── Service Worker Registration ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Init ──
loadData().then(d => {
  data = d;
  renderAthleteGrid();
  checkConnection();
});
