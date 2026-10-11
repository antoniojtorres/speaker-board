/**
 * Emulates the Web Audio AnalyserNode behind `p5.FFT(0.8, 64)`, the analyzer the
 * wall-piece visual (rossi.lol/wall-piece.html) was tuned against, so its dots
 * move the same way here even though the audio is captured server-side:
 * Blackman-windowed 128-point DFT, magnitudes normalized by N, and decibels
 * mapped from [-100, -30] onto 0..255 bytes.
 *
 * Two differences by necessity. The mic runs at 16kHz, so the 64 bins span
 * 0–8kHz rather than the browser's 0–24kHz. And a 50ms capture frame is
 * summarized as the mean power of its 128-sample windows instead of being
 * sampled once per paint; the 0.8 temporal smoothing is applied client-side,
 * per animation frame, where it matches the browser's cadence.
 */
export const SPECTRUM_BINS = 64;

const N = SPECTRUM_BINS * 2;
const MIN_DB = -100;
const MAX_DB = -30;

const BLACKMAN = Float64Array.from(
  { length: N },
  (_, n) => 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / N) + 0.08 * Math.cos((4 * Math.PI * n) / N),
);
const COS = new Float64Array(SPECTRUM_BINS * N);
const SIN = new Float64Array(SPECTRUM_BINS * N);
for (let k = 0; k < SPECTRUM_BINS; k++) {
  for (let n = 0; n < N; n++) {
    COS[k * N + n] = Math.cos((2 * Math.PI * k * n) / N);
    SIN[k * N + n] = Math.sin((2 * Math.PI * k * n) / N);
  }
}

/** One capture frame of PCM16 → SPECTRUM_BINS bytes, low to high frequency. */
export function spectrum(frame: Int16Array): number[] {
  const power = new Float64Array(SPECTRUM_BINS);
  const x = new Float64Array(N);
  let windows = 0;
  for (let off = 0; off + N <= frame.length; off += N) {
    for (let n = 0; n < N; n++) x[n] = (frame[off + n] / 32768) * BLACKMAN[n];
    for (let k = 0; k < SPECTRUM_BINS; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        re += x[n] * COS[k * N + n];
        im -= x[n] * SIN[k * N + n];
      }
      const mag = Math.hypot(re, im) / N;
      power[k] += mag * mag;
    }
    windows++;
  }
  return Array.from(power, (p) => toByte(windows ? Math.sqrt(p / windows) : 0));
}

function toByte(magnitude: number): number {
  const db = 20 * Math.log10(magnitude); // -Infinity for digital silence → clamps to 0
  const scaled = (255 * (db - MIN_DB)) / (MAX_DB - MIN_DB);
  return Math.max(0, Math.min(255, Math.floor(scaled)));
}
