// Sounds of the start menu, synthesised with Web Audio (no files). Browsers allow audio only after a
// press or a key, so nothing plays before the first one.
import { safeStorageGet, safeStorageSet } from '../utils/safe-storage';

const KEY = 'bansho-sound';

export interface SoundSettings { effects: boolean; music: boolean; volume: number }

function stored(): SoundSettings {
  const base: SoundSettings = { effects: true, music: true, volume: 60 };
  try {
    const saved = JSON.parse(safeStorageGet(KEY) ?? '{}') as Partial<SoundSettings>;
    return {
      effects: typeof saved.effects === 'boolean' ? saved.effects : base.effects,
      music: typeof saved.music === 'boolean' ? saved.music : base.music,
      volume: Number.isFinite(saved.volume) ? Math.max(0, Math.min(100, Number(saved.volume))) : base.volume,
    };
  } catch {
    return base;
  }
}

export const sound: SoundSettings = stored();

let context: AudioContext | null = null;
let master: GainNode | null = null;
let hum: { gain: GainNode; voices: OscillatorNode[] } | null = null;

function audio(): AudioContext | null {
  if (!context) {
    if (typeof window.AudioContext !== 'function') return null;
    context = new window.AudioContext();
    master = context.createGain();
    master.connect(context.destination);
  }
  if (context.state === 'suspended') void context.resume();
  if (master) master.gain.value = sound.volume / 100;
  return context;
}

function tone(from: number, to: number, seconds: number, level: number, type: OscillatorType, delay = 0): void {
  const ctx = audio();
  if (!ctx || !master) return;
  const start = ctx.currentTime + delay;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, start);
  oscillator.frequency.exponentialRampToValueAtTime(to, start + seconds);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(level, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
  oscillator.connect(gain).connect(master);
  oscillator.start(start);
  oscillator.stop(start + seconds + 0.02);
}

export function playHover(): void {
  // Without an earlier press the browser keeps audio silent, so the context is not created here.
  if (sound.effects && context) tone(520, 620, 0.06, 0.08, 'triangle');
}

export function playClick(): void {
  if (sound.effects) tone(660, 440, 0.1, 0.2, 'square');
}

export function playStart(): void {
  if (!sound.effects) return;
  [262, 392, 523, 784].forEach((pitch, i) => tone(pitch, pitch * 1.01, 0.22, 0.22, 'triangle', i * 0.09));
}

export function stopMusic(): void {
  for (const voice of hum?.voices ?? []) voice.stop();
  hum?.gain.disconnect();
  hum = null;
}

/** Starts or stops the quiet background chord according to the settings. */
export function syncMusic(): void {
  if (!sound.music) {
    stopMusic();
    return;
  }
  const ctx = audio();
  if (!ctx || !master || hum) return;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 1.5);
  gain.connect(master);
  const voices = [110, 164.81, 220.5].map((pitch) => {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = pitch;
    oscillator.connect(gain);
    oscillator.start();
    return oscillator;
  });
  hum = { gain, voices };
}

export function saveSound(change: Partial<SoundSettings>): void {
  Object.assign(sound, change);
  safeStorageSet(KEY, JSON.stringify(sound));
  if (master) master.gain.value = sound.volume / 100;
}
