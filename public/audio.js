// SIGNAL DOMINION — sound. Everything here is synthesized live in WebAudio:
// a slow generative dark-ambient bed (detuned pads over a deep pulse, with
// sparse echoing blips) plus a small kit of UI/game sound effects. No audio
// files, no licensing, no loading — and the loop never seams.
//
// Browsers only allow audio after a user gesture, so ensureAudio() is called
// from the first pointer event. Preferences persist in localStorage.

let ctx = null;
let master = null;
let musicBus = null;
let sfxBus = null;
let musicTimer = null;
let step = 0;

const prefs = {
  sound: localStorage.getItem('sd_sound') !== 'off', // master (music + sfx)
};

export function soundOn() {
  return prefs.sound;
}

export function toggleSound() {
  prefs.sound = !prefs.sound;
  localStorage.setItem('sd_sound', prefs.sound ? 'on' : 'off');
  if (!ctx) return prefs.sound;
  master.gain.setTargetAtTime(prefs.sound ? 1 : 0, ctx.currentTime, 0.05);
  if (prefs.sound && ctx.state === 'suspended') ctx.resume();
  return prefs.sound;
}

export function ensureAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return; // no audio stack — the game plays silently
  }
  master = ctx.createGain();
  master.gain.value = prefs.sound ? 1 : 0;
  master.connect(ctx.destination);
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.5;
  musicBus.connect(master);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.5;
  sfxBus.connect(master);
  startMusic();
}

// --------------------------------------------------------------------------
// Generative ambient bed
// --------------------------------------------------------------------------
// A minor progression drifting between four chords. Every 8 seconds a new
// pad swells in (two detuned triangles through a slowly-opening lowpass);
// a deep sine pulses on the root; sparse high blips echo through a feedback
// delay. Melancholy server-room weather.

const CHORDS = [
  [110.0, 130.81, 164.81, 196.0],   // Am add9-ish
  [87.31, 130.81, 174.61, 220.0],   // F
  [98.0, 146.83, 196.0, 246.94],    // G
  [82.41, 123.47, 164.81, 207.65],  // E-ish
];
const BLIP_SCALE = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];

function startMusic() {
  // Feedback delay shared by the blips.
  const delay = ctx.createDelay(1.5);
  delay.delayTime.value = 0.42;
  const fb = ctx.createGain();
  fb.gain.value = 0.42;
  const wet = ctx.createGain();
  wet.gain.value = 0.5;
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(musicBus);

  const BAR = 8; // seconds per chord
  let next = ctx.currentTime + 0.1;

  const schedule = () => {
    while (next < ctx.currentTime + 2 * BAR) {
      playBar(next, CHORDS[step % CHORDS.length], delay);
      next += BAR;
      step += 1;
    }
  };
  schedule();
  musicTimer = setInterval(schedule, 2000);
}

function playBar(t, chord, delay) {
  // Pad: each chord tone as two detuned triangles through a lowpass swell.
  for (const f of chord) {
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 1.2;
    filt.frequency.setValueAtTime(300, t);
    filt.frequency.linearRampToValueAtTime(900 + (step % 3) * 300, t + 4);
    filt.frequency.linearRampToValueAtTime(320, t + 9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.045, t + 3);
    g.gain.linearRampToValueAtTime(0.0001, t + 9.5);
    filt.connect(g).connect(musicBus);
    for (const detune of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(filt);
      o.start(t);
      o.stop(t + 10);
    }
  }
  // Root pulse two octaves down, breathing twice a bar.
  for (let i = 0; i < 4; i++) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = chord[0] / 2;
    const g = ctx.createGain();
    const pt = t + i * 2;
    g.gain.setValueAtTime(0, pt);
    g.gain.linearRampToValueAtTime(0.10, pt + 0.5);
    g.gain.linearRampToValueAtTime(0.0001, pt + 1.9);
    o.connect(g).connect(musicBus);
    o.start(pt);
    o.stop(pt + 2);
  }
  // Sparse blips: 0–2 per bar, echoed. Position derived from the step so the
  // pattern drifts but never repeats exactly on a short cycle.
  const n = (step * 7) % 3;
  for (let i = 0; i < n; i++) {
    const bt = t + 1.5 + ((step * 5 + i * 11) % 9) * 0.6;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = BLIP_SCALE[(step * 3 + i * 5) % BLIP_SCALE.length];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, bt);
    g.gain.linearRampToValueAtTime(0.05, bt + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, bt + 0.5);
    o.connect(g);
    g.connect(musicBus);
    g.connect(delay);
    o.start(bt);
    o.stop(bt + 0.6);
  }
}

// --------------------------------------------------------------------------
// Sound effects
// --------------------------------------------------------------------------

function tone(freqs, { type = 'sine', dur = 0.15, gain = 0.12, gap = 0.07, slideTo = null } = {}) {
  if (!ctx || !prefs.sound) return;
  const t0 = ctx.currentTime;
  freqs.forEach((f, i) => {
    const t = t0 + i * gap;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(sfxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  });
}

function noiseBurst({ dur = 0.25, cutoff = 700, gain = 0.2 } = {}) {
  if (!ctx || !prefs.sound) return;
  const t = ctx.currentTime;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(filt).connect(g).connect(sfxBus);
  src.start(t);
}

export function sfx(name) {
  if (!ctx || !prefs.sound) return;
  switch (name) {
    case 'click': tone([1800], { type: 'square', dur: 0.03, gain: 0.03 }); break;
    case 'queue': tone([520], { dur: 0.09, gain: 0.08, slideTo: 780 }); break;
    case 'unqueue': tone([520], { dur: 0.09, gain: 0.06, slideTo: 310 }); break;
    case 'lock': tone([329.63, 493.88], { dur: 0.16, gain: 0.10 }); break;
    case 'resolve':
      noiseBurst({ dur: 0.5, cutoff: 1800, gain: 0.06 });
      tone([523.25, 659.25, 783.99], { dur: 0.35, gain: 0.06, gap: 0.09 });
      break;
    case 'alert': tone([660, 660], { type: 'square', dur: 0.12, gain: 0.05, gap: 0.16 }); break;
    case 'combat': noiseBurst({ dur: 0.3, cutoff: 420, gain: 0.18 }); break;
    case 'detect': tone([1318.5], { dur: 0.4, gain: 0.06, slideTo: 1108.7 }); break;
    case 'win': tone([392, 523.25, 659.25, 783.99], { dur: 0.4, gain: 0.09, gap: 0.13 }); break;
    case 'lose': tone([392, 329.63, 261.63], { dur: 0.5, gain: 0.09, gap: 0.2, type: 'triangle' }); break;
    default: break;
  }
}
