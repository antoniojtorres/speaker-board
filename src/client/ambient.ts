import p5 from "p5";

// Ported from rossi.lol/wall-piece.html: same color, dot size and geometry.
const DOT = 10; // px diameter
const BLUE: [number, number, number] = [80, 120, 255];
const SKIP_BELOW = 0.02; // near-silent bins would otherwise draw a flat line through center
// p5.FFT(0.8, 64) smooths once per paint; the server sends raw frames, so the
// same constant is applied here per animation frame to keep the original motion.
const SMOOTHING = 0.8;

/**
 * Ambient audio-reactive background (p5 instance mode): the wall-piece's
 * amplitude line. Each spectrum bin is a dot mirrored into all four quadrants
 * around the center, so low frequencies stack in the middle and highs spread
 * outward, and each dot fades with its own amplitude. The page has no mic; the
 * spectrum comes from the server's capture over the bus.
 */
export class Ambient {
  private target: number[] = [];
  private readonly instance: p5;

  constructor(container: HTMLElement) {
    const sketch = (p: p5): void => {
      let smoothed = new Float32Array(0);
      p.setup = () => {
        p.createCanvas(p.windowWidth, p.windowHeight);
        p.noStroke();
      };
      p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
      p.draw = () => {
        p.clear(); // transparent: the page's theme background shows through
        const bins = this.target.length;
        if (smoothed.length !== bins) smoothed = new Float32Array(bins);
        const cx = p.width / 2;
        const cy = p.height / 2;
        for (let i = 0; i < bins; i++) {
          smoothed[i] = SMOOTHING * smoothed[i] + (1 - SMOOTHING) * this.target[i];
          const amp = smoothed[i] / 255;
          if (amp < SKIP_BELOW) continue;
          const dx = ((i / bins) * p.width) / 8;
          const dy = (amp * p.height) / 4;
          p.fill(...BLUE, amp * 255);
          p.circle(cx + dx, cy - dy, DOT);
          p.circle(cx - dx, cy - dy, DOT);
          p.circle(cx + dx, cy + dy, DOT);
          p.circle(cx - dx, cy + dy, DOT);
        }
      };
    };
    this.instance = new p5(sketch, container);
  }

  setSpectrum(spectrum: number[]): void {
    this.target = spectrum;
  }

  destroy(): void {
    this.instance.remove();
  }
}
