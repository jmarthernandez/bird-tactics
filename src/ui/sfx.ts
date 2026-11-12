// Tiny synthesized sound effects (no audio files). Muting is remembered per browser.

let ctx: AudioContext | null = null;
let muted = (() => {
  try {
    return localStorage.getItem("birdTactics.muted") === "1";
  } catch {
    return false;
  }
})();

export const isMuted = () => muted;
export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem("birdTactics.muted", m ? "1" : "0");
  } catch {
    // ignore
  }
}

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One beep that slides from f1 to f2 Hz. */
function tone(f1: number, f2: number, dur: number, type: OscillatorType = "square", vol = 0.06, delay = 0): void {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f1, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  select: () => tone(900, 1200, 0.05, "square", 0.03),
  hop: () => tone(500, 900, 0.08, "triangle", 0.06),
  chirp: () => (tone(2200, 3200, 0.06), tone(2400, 3600, 0.06, "square", 0.05, 0.08)),
  screech: () => tone(1800, 600, 0.35, "sawtooth", 0.05),
  caw: () => (tone(500, 380, 0.12, "sawtooth", 0.07), tone(480, 360, 0.12, "sawtooth", 0.06, 0.16)),
  dive: () => tone(2400, 300, 0.3, "sawtooth", 0.04),
  hit: () => tone(220, 60, 0.12, "square", 0.08),
  bump: () => tone(120, 40, 0.18, "triangle", 0.12),
  poof: () => tone(600, 100, 0.4, "triangle", 0.07),
  nom: () => (tone(300, 500, 0.06, "square", 0.05), tone(300, 500, 0.06, "square", 0.05, 0.1)),
  turn: () => (tone(523, 523, 0.08, "square", 0.04), tone(784, 784, 0.12, "square", 0.04, 0.09)),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.15, "square", 0.05, i * 0.12)),
};
