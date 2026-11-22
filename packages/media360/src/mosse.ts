// MOSSE correlation-filter tracker (Bolme et al., 2010): learns a filter that responds
// with a sharp peak on the subject, finds the peak in each new patch, and keeps adapting
// to the subject's changing appearance. Works on small square greyscale patches.

/** In-place radix-2 FFT of a complex signal (length a power of two). */
function fft1(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci, xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a] = re[a]! + xr; im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = im[i]! / n; }
}

/** 2D FFT of an N×N complex image, in place. */
export function fft2(re: Float64Array, im: Float64Array, N: number, inverse = false) {
  const rr = new Float64Array(N), ri = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) { rr[x] = re[y * N + x]!; ri[x] = im[y * N + x]!; }
    fft1(rr, ri, inverse);
    for (let x = 0; x < N; x++) { re[y * N + x] = rr[x]!; im[y * N + x] = ri[x]!; }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { rr[y] = re[y * N + x]!; ri[y] = im[y * N + x]!; }
    fft1(rr, ri, inverse);
    for (let y = 0; y < N; y++) { re[y * N + x] = rr[y]!; im[y * N + x] = ri[y]!; }
  }
}

export interface TrackResult {
  /** Peak offset from the patch centre, pixels (+x right, +y down). */
  dx: number;
  dy: number;
  /** Peak-to-sidelobe ratio: how sure the tracker is (≳ 7 = confident, < 5 = probably lost). */
  psr: number;
}

/** One greyscale patch, or several feature channels of the same patch (N×N each). */
export type Patch = ArrayLike<number> | ArrayLike<number>[];
const channelsOf = (p: Patch): ArrayLike<number>[] => (typeof (p as ArrayLike<number>[])[0] === 'number' ? [p as ArrayLike<number>] : (p as ArrayLike<number>[]));

export class Mosse {
  private window: Float64Array;
  private gRe: Float64Array;
  private gIm: Float64Array;
  private aRe: Float64Array[] = [];
  private aIm: Float64Array[] = [];
  private b: Float64Array;
  /** Channel 0 is log-intensity; other channels (features) are used as they come. */
  private logFirst = true;

  /**
   * @param N patch size (power of two)
   * @param rate how fast the filter adapts to new appearance (0–1)
   */
  /**
   * @param target size of the subject as a fraction of the patch (0–1). When set, everything
   *   outside the subject is faded down (to `floor`) when learning and matching, so a large,
   *   still background can't win over a smaller moving subject.
   */
  /** Relative weight of each feature channel (after normalisation); default 1 each. */
  weights: number[] = [];
  /**
   * Channels whose strength carries meaning (e.g. motion: nothing moving = nothing to see):
   * divided by this fixed scale instead of being normalised to unit variance.
   */
  fixedScale: (number | undefined)[] = [];

  constructor(readonly N: number, readonly rate = 0.125, sigma = N / 16, readonly reg = 0.1, target = 0, floor = 0.15) {
    const n = N * N;
    this.window = new Float64Array(n);
    // Flat-topped (Tukey) window: tapers only the outer 25% on each side. A full cosine
    // window drags the estimate towards the centre for smooth subjects (under-reports motion).
    const taper = (i: number) => {
      const u = (i + 0.5) / N, e = 0.25;
      if (u < e) return 0.5 - 0.5 * Math.cos((Math.PI * u) / e);
      if (u > 1 - e) return 0.5 - 0.5 * Math.cos((Math.PI * (1 - u)) / e);
      return 1;
    };
    const sig = (Math.max(0.05, target) * N) / 2;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const r2 = (x + 0.5 - N / 2) ** 2 + (y + 0.5 - N / 2) ** 2;
        const focus = target > 0 ? floor + (1 - floor) * Math.exp(-r2 / (2 * sig * sig)) : 1;
        this.window[y * N + x] = taper(x) * taper(y) * focus;
      }
    // Desired response: a Gaussian peak at the centre.
    this.gRe = new Float64Array(n);
    this.gIm = new Float64Array(n);
    const c = N / 2;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) this.gRe[y * N + x] = Math.exp(-((x - c) ** 2 + (y - c) ** 2) / (2 * sigma * sigma));
    fft2(this.gRe, this.gIm, N);
    this.b = new Float64Array(n);
  }

  /** Normalise and window each channel (log for the intensity channel), then FFT. */
  private spectrum(patch: Patch): [Float64Array, Float64Array][] {
    const n = this.N * this.N;
    return channelsOf(patch).map((ch, c) => {
      const re = new Float64Array(n), im = new Float64Array(n);
      let mean = 0;
      for (let i = 0; i < n; i++) { re[i] = c === 0 && this.logFirst ? Math.log(ch[i]! + 1) : ch[i]!; mean += re[i]!; }
      mean /= n;
      let v = 0;
      for (let i = 0; i < n; i++) { re[i] = re[i]! - mean; v += re[i]! ** 2; }
      const sd = this.fixedScale[c] ?? (Math.sqrt(v / n) || 1);
      const w = (this.weights[c] ?? 1) / sd;
      for (let i = 0; i < n; i++) re[i] = re[i]! * w * this.window[i]!;
      fft2(re, im, this.N);
      return [re, im];
    });
  }

  private learn(spec: [Float64Array, Float64Array][], rate: number) {
    const n = this.N * this.N;
    while (this.aRe.length < spec.length) { this.aRe.push(new Float64Array(n)); this.aIm.push(new Float64Array(n)); }
    for (let i = 0; i < n; i++) this.b[i] = (1 - rate) * this.b[i]!;
    spec.forEach(([fRe, fIm], c) => {
      const aRe = this.aRe[c]!, aIm = this.aIm[c]!;
      for (let i = 0; i < n; i++) {
        // A_c += G · conj(F_c);  B += Σ_c F_c · conj(F_c)
        const ar = this.gRe[i]! * fRe[i]! + this.gIm[i]! * fIm[i]!;
        const ai = this.gIm[i]! * fRe[i]! - this.gRe[i]! * fIm[i]!;
        aRe[i] = rate * ar + (1 - rate) * aRe[i]!;
        aIm[i] = rate * ai + (1 - rate) * aIm[i]!;
        this.b[i] = this.b[i]! + rate * (fRe[i]! ** 2 + fIm[i]! ** 2);
      }
    });
  }

  /** Starts tracking the subject centred in `patch`. */
  init(patch: Patch) {
    this.aRe = [];
    this.aIm = [];
    this.b.fill(0);
    this.learn(this.spectrum(patch), 1);
    // Brightness/contrast-jittered copies of the intensity channel make the first filter less
    // brittle (the target stays centred, so these must not move the subject).
    const chans = channelsOf(patch);
    for (const [gain, bias] of [[0.9, 8], [1.1, -8], [0.95, -4], [1.05, 4]]) {
      const j0 = Float64Array.from({ length: this.N * this.N }, (_, i) => Math.max(0, Math.min(255, chans[0]![i]! * gain! + bias!)));
      this.learn(this.spectrum([j0, ...chans.slice(1)]), 0.2);
    }
  }

  /**
   * Where the subject is in `patch` (relative to its centre) and how confident that is.
   * One look under-reports larger moves; callers re-centre on the estimate and look again
   * (see the tracker), which converges in two or three passes.
   */
  /**
   * @param prior optional N×N weights (0–1) multiplied into the response before picking the
   *   peak — e.g. "where something is moving", so still background can't win.
   */
  find(patch: Patch, prior?: Float64Array): TrackResult {
    const N = this.N, n = N * N;
    const spec = this.spectrum(patch);
    const rRe = new Float64Array(n), rIm = new Float64Array(n);
    // Regularisation relative to the average energy: stops the filter amplifying
    // frequencies the subject barely has (which would let static background win).
    let meanB = 0;
    for (let i = 0; i < n; i++) meanB += this.b[i]!;
    const eps = (this.reg * meanB) / n + 1e-6;
    spec.forEach(([fRe, fIm], c) => {
      const aRe = this.aRe[c]!, aIm = this.aIm[c]!;
      for (let i = 0; i < n; i++) {
        // H*_c = A_c / B;  R = Σ_c H*_c · F_c
        const d = this.b[i]! + eps;
        const hr = aRe[i]! / d, hi = aIm[i]! / d;
        rRe[i] = rRe[i]! + hr * fRe[i]! - hi * fIm[i]!;
        rIm[i] = rIm[i]! + hr * fIm[i]! + hi * fRe[i]!;
      }
    });
    fft2(rRe, rIm, N, true);
    // The response is circular (peak index = offset); the prior is in patch coordinates, with
    // the patch centre at N/2 — i.e. the same layout as the target G (peak at the centre).
    let best = 0, bestV = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = prior ? rRe[i]! * prior[i]! : rRe[i]!;
      if (v > bestV) { bestV = v; best = i; }
    }
    const px = best % N, py = Math.floor(best / N);
    // Sub-pixel peak (parabola through neighbours).
    const at = (x: number, y: number) => rRe[((y + N) % N) * N + ((x + N) % N)]!;
    const c = at(px, py);
    const sub = (m: number, p: number) => { const d = m - 2 * c + p; return d === 0 ? 0 : (m - p) / (2 * d); };
    const sx = px + sub(at(px - 1, py), at(px + 1, py));
    const sy = py + sub(at(px, py - 1), at(px, py + 1));
    // PSR: peak against the response outside an 11×11 window round it.
    let sum = 0, sum2 = 0, cnt = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (Math.abs(x - px) <= 5 && Math.abs(y - py) <= 5) continue;
        const v = rRe[y * N + x]!;
        sum += v; sum2 += v * v; cnt++;
      }
    const mean = sum / cnt, sd = Math.sqrt(Math.max(1e-12, sum2 / cnt - mean * mean));
    return { dx: sx - N / 2, dy: sy - N / 2, psr: (c - mean) / sd };
  }

  /** Learns from a patch centred on the subject's new position. */
  update(patch: Patch) {
    this.learn(this.spectrum(patch), this.rate);
  }
}
