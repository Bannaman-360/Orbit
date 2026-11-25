// Finishing pass: motion blur (frame blending), masks (blur, pixelate, hide), sharpen, colour
// grade, LUT, vignette.
// Reads the reframed history layers and writes the final image.

const HUE_SHIFT = 1 / 6;

export const FINISH_WGSL = /* wgsl */ `
struct Finish {
  layers0 : vec4u,  // history layer index for blend slot 0..3 (newest first)
  layers1 : vec4u,  // slots 4..7
  blend : vec4f,    // x = frames blended, y = bypass grade (1) , z = has LUT, w = LUT size
  // Grade (see packages/project/src/look.ts)
  g0 : vec4f,       // exposure, contrast, highlights, shadows
  g1 : vec4f,       // fade, saturation, vibrance, temperature
  g2 : vec4f,       // tint, vignette, sharpen, lutMix
  size : vec4f,     // output width, height, 1/width, 1/height
  fx0 : vec4f,      // grain, glow, chroma (colour fringing), zoom blur
  fx1 : vec4f,      // light leak, bars, time (s), log / HLG clip (values reach above white)
  lens : vec4f,     // sharpness front, back; clarity front, back (see lensMatch.ts)
  mark : vec4f,     // which lens to point out (1 front, 2 back); y: exporting, the display curve to undo (0 = none); z: one step of the output (dither)
  maskKind : vec4f, // per mask (one per channel of maskTex): 0 none, 1 blur, 2 pixelate, 3 hide
  maskAmt : vec4f,  // strength of each, 0..1
  hide0 : vec4f,    // colour each mask hides with
  hide1 : vec4f,
  hide2 : vec4f,
  hide3 : vec4f,
  // Milestone 4 (see packages/project/src/grading.ts)
  lift : vec4f,     // colour wheels, per channel: lift (added to the blacks)
  gamma : vec4f,    // exponent
  gain : vec4f,     // multiplier
  offs : vec4f,     // added to everything
  q0 : vec4f,       // qualifier: hue (turns), half width (turns), soft, invert
  q1 : vec4f,       // saturation low, high; luma low, high
  q2 : vec4f,       // exposure, saturation, hue turn (turns), show the matte
  pro : vec4f,      // x: wheels on, y: curves (1 tone, 2 colour, 3 both), z: qualifier on, w: film look strength
  nr : vec4f,       // spatial, temporal strength, frames to look back over, film LUT size
  fx2 : vec4f,      // halation, VHS, shake, RGB split
  fx3 : vec4f,      // bloom
  winE : vec4f,     // power windows (colour masks), per mask: exposure
  winC : vec4f,     // contrast
  winS : vec4f,     // saturation
  winT : vec4f,     // temperature
};

@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var history : texture_2d_array<f32>;
@group(0) @binding(2) var lut : texture_3d<f32>;
@group(0) @binding(3) var<uniform> f : Finish;
/*MASKS*/@group(0) @binding(4) var maskTex : texture_2d<f32>;/*END*/
/*PRO*/@group(0) @binding(5) var curveTex : texture_2d<f32>;
@group(0) @binding(6) var filmLut : texture_3d<f32>;/*ENDPRO*/

struct VsOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f };

@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o : VsOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

fn layerFor(slot : u32) -> u32 {
  if (slot < 4u) { return f.layers0[slot]; }
  return f.layers1[slot - 4u];
}

// Box-average the most recent N reframed frames: a longer virtual shutter.
fn blended(uv : vec2f) -> vec3f {
  let n = u32(f.blend.x);
  var acc = vec3f(0.0);
  for (var s = 0u; s < 8u; s++) {
    if (s >= n) { break; }
    acc += textureSampleLevel(history, samp, uv, layerFor(s), 0.0).rgb;
  }
  return acc / f32(max(n, 1u));
}

// Picture before grading, with lens-style effects that change where pixels are sampled:
// radial zoom blur and chromatic aberration.
fn source(uv : vec2f) -> vec3f {
  let zoom = f.fx0.w;
  let chroma = f.fx0.z;
  if (zoom < 0.001 && chroma < 0.001) { return blended(uv); }
  let d = uv - 0.5;
  let fringe = d * chroma * 0.012;
  let taps = select(1u, 10u, zoom >= 0.001);
  var acc = vec3f(0.0);
  for (var i = 0u; i < 10u; i++) {
    if (i >= taps) { break; }
    let k = 1.0 - zoom * 0.09 * f32(i) / 10.0;
    let p = 0.5 + d * k;
    if (chroma >= 0.001) {
      acc += vec3f(blended(p + fringe).r, blended(p).g, blended(p - fringe).b);
    } else {
      acc += blended(p);
    }
  }
  return acc / f32(taps);
}

fn hash(p : vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Mask blur: a disc of samples (a spiral), turned a little differently at each pixel so no
// pattern shows. Interleaved gradient noise turns it far more evenly than random noise, so
// what is left is a faint, even grain. Radius up to 8% of the frame's height.
fn maskBlur(uv : vec2f, amt : f32, pix : vec2f) -> vec3f {
  let r = 0.004 + amt * 0.076;
  let ign = fract(52.9829189 * fract(dot(pix, vec2f(0.06711056, 0.00583715))));
  let turn = ign * 6.2831853;
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < 64; i++) {
    let fi = f32(i) + 0.5;
    let k = sqrt(fi / 64.0);
    let a = fi * 2.3999632 + turn;
    // Fewer samples count at the rim: a soft (roughly Gaussian) blur rather than a hard disc.
    let w = 1.0 - 0.6 * k * k;
    acc += blended(uv + vec2f(cos(a) * r * k * f.size.y / f.size.x, sin(a) * r * k)) * w;
    wsum += w;
  }
  return acc / wsum;
}

// Mask pixelate: blocks up to 7% of the frame's height, each the average of its middle.
fn maskPixelate(uv : vec2f, amt : f32) -> vec3f {
  let b = 0.006 + amt * 0.064;
  let cell = vec2f(b * f.size.y / f.size.x, b);
  let c = (floor(uv / cell) + 0.5) * cell;
  let q = cell * 0.25;
  return (blended(c) + blended(c + vec2f(q.x, q.y)) + blended(c + vec2f(-q.x, q.y)) + blended(c + vec2f(q.x, -q.y)) + blended(c + vec2f(-q.x, -q.y))) * 0.2;
}

fn hideColor(i : u32) -> vec3f {
  if (i == 0u) { return f.hide0.rgb; }
  if (i == 1u) { return f.hide1.rgb; }
  if (i == 2u) { return f.hide2.rgb; }
  return f.hide3.rgb;
}

fn srgbToLight(v : vec3f) -> vec3f {
  let a = abs(v);
  return sign(v) * select(pow((a + 0.055) / 1.055, vec3f(2.4)), a / 12.92, a <= vec3f(0.04045));
}

fn luma(c : vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Eases what is brighter than white into the top of the range (see shoulder in inputColor.ts).
fn shoulder(c : vec3f) -> vec3f { return select(0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2)), c, c <= vec3f(0.8)); }

fn grade(cIn : vec3f) -> vec3f {
  let exposure = f.g0.x; let contrast = f.g0.y; let highlights = f.g0.z; let shadows = f.g0.w;
  let fade = f.g1.x; let saturation = f.g1.y; let vibrance = f.g1.z; let temperature = f.g1.w;
  let tint = f.g2.x;

  // Exposure and white balance in (approximately) linear light.
  var lin = pow(max(cIn, vec3f(0.0)), vec3f(2.2));
  lin *= exp2(exposure);
  var wb = vec3f(1.0 + 0.25 * temperature, 1.0 - 0.18 * tint, 1.0 - 0.25 * temperature);
  wb.r *= 1.0 + 0.08 * tint;
  wb.b *= 1.0 + 0.08 * tint;
  lin *= wb / luma(wb);
  var c = pow(max(lin, vec3f(0.0)), vec3f(1.0 / 2.2));
  if (f.fx1.w > 0.5) { c = shoulder(c); }

  // Tone: shadows/highlights recovery, then an S-ish contrast curve around mid grey.
  let l0 = luma(c);
  let sMask = 1.0 - smoothstep(0.0, 0.55, l0);
  let hMask = smoothstep(0.45, 1.0, l0);
  c += vec3f(shadows * 0.3 * sMask + highlights * 0.3 * hMask);
  let k = 1.0 + contrast;
  c = clamp((c - 0.5) * k + 0.5, vec3f(0.0), vec3f(1.5));

  // Fade lifts the blacks.
  c = fade * 0.12 + c * (1.0 - fade * 0.12);

  // Saturation and vibrance.
  let l = luma(c);
  c = mix(vec3f(l), c, 1.0 + saturation);
  let sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3f(luma(c)), c, 1.0 + vibrance * (1.0 - clamp(sat, 0.0, 1.0)));
  return clamp(c, vec3f(0.0), vec3f(1.0));
}

fn rgbToHsv(c : vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let d = mx - mn;
  var h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) { h = (c.g - c.b) / d; }
    else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
  }
  h = fract(h / 6.0 + 1.0);
  return vec3f(h, select(0.0, d / mx, mx > 1e-6), mx);
}
fn hsvToRgb(h : vec3f) -> vec3f {
  let k = (vec3f(5.0, 3.0, 1.0) + h.x * 6.0) % vec3f(6.0);
  return h.z - h.z * h.y * clamp(min(k, 4.0 - k), vec3f(0.0), vec3f(1.0));
}

/*PRO*/
// Colour wheels: lift, gain, gamma, offset (see wheelUniforms in grading.ts).
fn wheels(cIn : vec3f) -> vec3f {
  var c = cIn * (1.0 - f.lift.rgb) + f.lift.rgb;
  c *= f.gain.rgb;
  c = pow(max(c, vec3f(0.0)), f.gamma.rgb);
  return c + f.offs.rgb;
}
fn curveRow(x : f32, row : f32) -> vec4f {
  return textureSampleLevel(curveTex, samp, vec2f((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, row), 0.0);
}
// Tone curves, then hue vs sat, hue vs hue and luma vs sat (see bakeCurves).
fn curves(cIn : vec3f) -> vec3f {
  let mode = u32(f.pro.y + 0.5);
  var c = cIn;
  if ((mode & 1u) != 0u) {
    let hi = max(c - vec3f(1.0), vec3f(0.0));
    c = vec3f(curveRow(c.r, 0.25).r, curveRow(c.g, 0.25).g, curveRow(c.b, 0.25).b) + hi;
  }
  if ((mode & 2u) != 0u) {
    var hsv = rgbToHsv(clamp(c, vec3f(0.0), vec3f(1.0)));
    let byHue = curveRow(hsv.x, 0.75);
    let byLuma = curveRow(luma(c), 0.25).a;
    hsv.x = fract(hsv.x + (byHue.g - 0.5) * 2.0 * ${HUE_SHIFT} + 1.0);
    let l = luma(c);
    let rgb = hsvToRgb(hsv);
    // Saturation scaled around the pixel's own brightness.
    c = mix(vec3f(l), rgb + vec3f(l - luma(rgb)), byHue.r * 2.0 * byLuma * 2.0);
  }
  return c;
}
// The HSL qualifier: what it picks (0–1).
fn matte(c : vec3f) -> f32 {
  let hsv = rgbToHsv(clamp(c, vec3f(0.0), vec3f(1.0)));
  let l = luma(clamp(c, vec3f(0.0), vec3f(1.0)));
  let sw = max(f.q0.z, 0.001);
  let dh = abs(fract(hsv.x - f.q0.x + 0.5) - 0.5);
  let mh = select(1.0 - smoothstep(f.q0.y, f.q0.y + sw * 0.12, dh), 1.0, f.q0.y >= 0.5);
  let ms = smoothstep(f.q1.x - sw * 0.15, f.q1.x, hsv.y) * (1.0 - smoothstep(f.q1.y, f.q1.y + sw * 0.15, hsv.y));
  let ml = smoothstep(f.q1.z - sw * 0.15, f.q1.z, l) * (1.0 - smoothstep(f.q1.w, f.q1.w + sw * 0.15, l));
  let m = mh * ms * ml;
  return select(m, 1.0 - m, f.q0.w > 0.5);
}
fn qualify(c : vec3f, m : f32) -> vec3f {
  var x = c * exp2(f.q2.x / 2.2);
  var hsv = rgbToHsv(clamp(x, vec3f(0.0), vec3f(1.0)));
  hsv.x = fract(hsv.x + f.q2.z + 1.0);
  let l = luma(x);
  let turned = hsvToRgb(hsv);
  x = mix(vec3f(l), turned + vec3f(l - luma(turned)), 1.0 + f.q2.y);
  return mix(c, x, m);
}
fn applyFilm(c : vec3f) -> vec3f {
  let n = f.nr.w;
  let coord = (clamp(c, vec3f(0.0), vec3f(1.0)) * (n - 1.0) + 0.5) / n;
  return mix(c, textureSampleLevel(filmLut, samp, coord, 0.0).rgb, f.pro.w);
}
/*ENDPRO*/

/*MASKS*/
// A power window's grade (a colour mask): exposure, contrast, saturation, temperature.
fn windowGrade(cIn : vec3f, i : u32) -> vec3f {
  var c = cIn * exp2(f.winE[i] / 2.2);
  c = (c - 0.5) * (1.0 + f.winC[i]) + 0.5;
  let t = f.winT[i];
  c *= vec3f(1.0 + 0.2 * t, 1.0, 1.0 - 0.2 * t);
  let l = luma(c);
  return max(mix(vec3f(l), c, 1.0 + f.winS[i]), vec3f(0.0));
}
/*END*/

/*NR*/
fn slot(s : u32, uv : vec2f) -> vec3f { return textureSampleLevel(history, samp, uv, layerFor(s), 0.0).rgb; }
// Temporal noise reduction: the last few frames averaged where nothing moved. Each is compared
// with this one on a small neighbourhood (bilinear taps half a pixel off average 2×2 pixels),
// and counts less the more it differs, so moving things don't smear.
fn temporalNr(uv : vec2f) -> vec3f {
  let k = u32(f.nr.z);
  let hp = f.size.zw * 0.5;
  let c0 = slot(0u, uv);
  let m0 = (slot(0u, uv + hp) + slot(0u, uv - hp)) * 0.5;
  let sigma = 0.012 + 0.05 * f.nr.y;
  var acc = c0;
  var ws = 1.0;
  for (var s = 1u; s < 6u; s++) {
    if (s >= k) { break; }
    let ms = (slot(s, uv + hp) + slot(s, uv - hp)) * 0.5;
    let d = ms - m0;
    let w = exp(-dot(d, d) / (sigma * sigma));
    acc += slot(s, uv) * w;
    ws += w;
  }
  return acc / ws;
}
// Spatial noise reduction: an edge-keeping (bilateral) blur. Brightness is smoothed gently and
// only between similar pixels; colour noise more widely.
fn spatialNr(uv : vec2f, c : vec3f) -> vec3f {
  let amt = f.nr.x;
  let r = f.size.zw * (1.0 + amt * 1.6);
  let sl = 0.025 + 0.07 * amt;
  let sc = 0.06 + 0.22 * amt;
  var accL = c; var wL = 1.0;
  var accC = c; var wC = 1.0;
  for (var i = 0; i < 12; i++) {
    let ring = select(1.0, 2.0, i >= 6);
    let a = f32(i) * 1.0471976 + select(0.0, 0.5235988, i >= 6);
    let s = blended(uv + vec2f(cos(a), sin(a)) * r * ring);
    let d = s - c;
    let e = dot(d, d);
    let w0 = 1.0 / ring;
    let wl = exp(-e / (sl * sl)) * w0;
    let wc = exp(-e / (sc * sc)) * w0;
    accL += s * wl; wL += wl;
    accC += s * wc; wC += wc;
  }
  let lumaPart = accL / wL;
  let colourPart = accC / wC;
  return mix(c, colourPart + vec3f(luma(lumaPart) - luma(colourPart)), min(1.0, 0.6 + amt));
}
/*ENDNR*/

/*FX2*/
// Handheld shake: a wandering offset and a little turn, the picture pushed in so no edge shows.
fn shaken(uv : vec2f) -> vec2f {
  let a = f.fx2.z;
  let t = f.fx1.z;
  let n = vec2f(sin(t * 7.1) * 0.6 + sin(t * 13.3 + 1.7) * 0.3 + sin(t * 23.9 + 0.4) * 0.1,
                sin(t * 6.3 + 2.1) * 0.6 + sin(t * 15.7 + 0.3) * 0.3 + sin(t * 27.1 + 2.9) * 0.1);
  let rot = (sin(t * 5.3 + 0.9) * 0.6 + sin(t * 11.7) * 0.4) * a * 0.012;
  let aspect = f.size.x / f.size.y;
  var p = (uv - 0.5) * (1.0 - a * 0.07);
  p = vec2f(p.x * aspect, p.y);
  p = vec2f(p.x * cos(rot) - p.y * sin(rot), p.x * sin(rot) + p.y * cos(rot));
  p = vec2f(p.x / aspect, p.y);
  return 0.5 + p + n * a * 0.018;
}
// Video tape: each band of lines nudged sideways now and then.
fn vhsUv(uv : vec2f) -> vec2f {
  let a = f.fx2.y;
  let t = f.fx1.z;
  let band = floor(uv.y * 90.0);
  let jit = (hash(vec3f(band, floor(t * 24.0), 3.0)) - 0.5) * 0.004 * a;
  let wave = sin(uv.y * 30.0 + t * 3.0) * 0.0012 * a;
  // A tracking glitch rolling up the frame.
  let roll = fract(1.0 - t * 0.07);
  let near = 1.0 - smoothstep(0.0, 0.03, abs(uv.y - roll));
  return uv + vec2f(jit + wave + near * 0.012 * a, 0.0);
}
fn vhsLook(c : vec3f, uv : vec2f, pix : vec2f) -> vec3f {
  let a = f.fx2.y;
  let t = f.fx1.z;
  // Colour smeared to the right (tape keeps much less colour detail than brightness).
  let d = vec2f(f.size.z * 3.0, 0.0);
  let smear = (blended(uv + d) + blended(uv + d * 2.0) + blended(uv + d * 3.5)) / 3.0;
  var x = smear + vec3f(luma(c) - luma(smear));
  x = mix(vec3f(luma(x)), x, 0.85);
  x = x * vec3f(1.04, 1.0, 0.94) + vec3f(0.02, 0.015, 0.03);
  let scan = 0.92 + 0.08 * sin(pix.y * 3.14159);
  let n = hash(vec3f(pix, t * 50.0)) - 0.5;
  let roll = fract(1.0 - t * 0.07);
  let near = 1.0 - smoothstep(0.0, 0.02, abs(uv.y - roll));
  x = x * scan + n * 0.08 + near * (hash(vec3f(pix * 0.5, t)) * 0.35);
  return mix(c, x, a);
}
fn halo(uv : vec2f, radius : f32, thresh : f32, taps : i32) -> vec3f {
  let aspect = f.size.x / f.size.y;
  var acc = vec3f(0.0);
  for (var i = 0; i < 16; i++) {
    if (i >= taps) { break; }
    let a = f32(i) * 6.2831853 / f32(taps) + 0.3;
    for (var j = 1; j <= 2; j++) {
      let s = min(blended(uv + vec2f(cos(a) / aspect, sin(a)) * radius * f32(j) * 0.6), vec3f(1.0));
      acc += max(s - vec3f(thresh), vec3f(0.0)) / (1.0 - thresh) / f32(j);
    }
  }
  return acc / (f32(taps) * 1.5);
}
/*ENDFX2*/

fn applyLut(c : vec3f) -> vec3f {
  let n = f.blend.w;
  let coord = (c * (n - 1.0) + 0.5) / n;
  let l = textureSampleLevel(lut, samp, coord, 0.0).rgb;
  return mix(c, l, f.g2.w);
}

@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  if (f.blend.y > 0.5) { return vec4f(clamp(blended(in.uv), vec3f(0.0), vec3f(1.0)), 1.0); }
  // Where the picture is sampled (effects that move it change this).
  var uv = in.uv;
  /*FX2*/
  if (f.fx2.z > 0.001) { uv = shaken(uv); }
  if (f.fx2.y > 0.001) { uv = vhsUv(uv); }
  /*ENDFX2*/
  var c = source(uv);
  /*NR*/
  // (Only on the plain picture: motion blur already averages frames.)
  if (f.nr.z > 1.5 && f.blend.x < 1.5 && f.fx0.w < 0.001 && f.fx0.z < 0.001) { c = temporalNr(uv); }
  if (f.nr.x > 0.001) { c = spatialNr(uv, c); }
  /*ENDNR*/
  /*FX2*/
  if (f.fx2.w > 0.001) {
    let o = vec2f(f.fx2.w * 0.008 * (1.0 + 0.3 * sin(f.fx1.z * 2.3)), 0.0);
    c = vec3f(blended(uv + o).r, c.g, blended(uv - o).b);
  }
  /*ENDFX2*/

  // Masks: blur and pixelate replace the picture before grading (so the grade still applies);
  // sharpening and clarity leave those parts alone. Hide fills them at the end.
  var keepDetail = 1.0;
  /*MASKS*/
  let masked = dot(f.maskKind, vec4f(1.0)) > 0.5;
  var mk = vec4f(0.0);
  if (masked) {
    mk = textureSampleLevel(maskTex, samp, in.uv, 0.0);
    for (var i = 0u; i < 4u; i++) {
      let w = mk[i];
      let kind = f.maskKind[i];
      if (w < 0.002 || kind < 0.5 || kind > 2.5) { continue; }
      let amt = f.maskAmt[i];
      if (kind < 1.5) { c = mix(c, maskBlur(uv, amt, in.pos.xy), w); }
      else { c = mix(c, maskPixelate(uv, amt), w); }
      keepDetail *= 1.0 - w;
    }
  }
  /*END*/

  // How much of this pixel is the back lens's (kept in the history's alpha by 360 clips).
  let backShare = textureSampleLevel(history, samp, uv, layerFor(0u), 0.0).a;
  let clarity = mix(f.lens.z, f.lens.w, backShare);
  if (clarity > 0.001) {
    // Local contrast: against the average of a wide ring.
    var wide = vec3f(0.0);
    let cr = vec2f(0.014 * f.size.y / f.size.x, 0.014);
    for (var i = 0; i < 8; i++) {
      let a = f32(i) * 0.7853982;
      wide += blended(uv + vec2f(cos(a), sin(a)) * cr) + blended(uv + vec2f(cos(a + 0.39), sin(a + 0.39)) * cr * 2.2);
    }
    c = max(vec3f(0.0), c + vec3f(luma(c) - luma(wide / 16.0)) * clarity * 0.9 * keepDetail);
  }

  // Unsharp mask against the 4 neighbours.
  let sharpen = f.g2.z + mix(f.lens.x, f.lens.y, backShare);
  if (sharpen > 0.001) {
    let d = f.size.zw;
    let nb = (blended(uv + vec2f(d.x, 0.0)) + blended(uv - vec2f(d.x, 0.0)) +
              blended(uv + vec2f(0.0, d.y)) + blended(uv - vec2f(0.0, d.y))) * 0.25;
    var detail = (c - nb) * sharpen * 1.5;
    // Above 100%, also sharpen at a 2-pixel radius so stronger settings bring out texture,
    // not just pixel-level edges (which would turn into noise).
    if (sharpen > 1.0) {
      let d2 = d * 2.0;
      let nb2 = (blended(uv + vec2f(d2.x, 0.0)) + blended(uv - vec2f(d2.x, 0.0)) +
                 blended(uv + vec2f(0.0, d2.y)) + blended(uv - vec2f(0.0, d2.y))) * 0.25;
      detail += (c - nb2) * (sharpen - 1.0) * 0.8;
    }
    c = clamp(c + detail * keepDetail, vec3f(0.0), vec3f(select(1.0, 8.0, f.fx1.w > 0.5)));
  }

  c = grade(c);
  /*PRO*/
  if (f.pro.x > 0.5) { c = wheels(c); }
  if (f.pro.y > 0.5) { c = curves(c); }
  var qm = 0.0;
  if (f.pro.z > 0.5) { qm = matte(c); c = qualify(c, qm); }
  /*ENDPRO*/
  /*MASKS*/
  if (masked) {
    // Power windows: a second grade inside each colour mask.
    for (var i = 0u; i < 4u; i++) {
      let w = mk[i];
      if (w > 0.002 && f.maskKind[i] > 3.5) { c = mix(c, windowGrade(c, i), w * f.maskAmt[i]); }
    }
  }
  /*END*/
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  if (f.blend.z > 0.5) { c = applyLut(c); }
  /*PRO*/
  if (f.pro.w > 0.001) { c = applyFilm(c); }
  /*ENDPRO*/

  let aspect = f.size.x / f.size.y;

  // Glow: soft light bleeding out of bright areas (a ring of samples around the pixel).
  let glow = f.fx0.y;
  if (glow > 0.001) {
    var bloom = vec3f(0.0);
    let r = vec2f(0.012 / aspect, 0.012);
    for (var i = 0; i < 12; i++) {
      let a = f32(i) * 0.5235988;
      for (var j = 1; j <= 2; j++) {
        let s = min(blended(uv + vec2f(cos(a), sin(a)) * r * f32(j) * 1.6), vec3f(1.0));
        bloom += max(s - vec3f(0.55), vec3f(0.0)) / (0.45 * f32(j));
      }
    }
    c = 1.0 - (1.0 - c) * (1.0 - clamp(bloom / 18.0 * glow * 2.2, vec3f(0.0), vec3f(1.0)));
  }

  /*FX2*/
  // Halation: red-orange light scattered round bright edges; bloom: wide, soft white light.
  if (f.fx2.x > 0.001) {
    let h = halo(uv, 0.025, 0.7, 10);
    c = 1.0 - (1.0 - c) * (1.0 - clamp(vec3f(1.0, 0.32, 0.12) * luma(h) * f.fx2.x * 2.5, vec3f(0.0), vec3f(1.0)));
  }
  if (f.fx3.x > 0.001) {
    let b = halo(uv, 0.05, 0.6, 16);
    c = 1.0 - (1.0 - c) * (1.0 - clamp(b * f.fx3.x * 1.8, vec3f(0.0), vec3f(1.0)));
  }
  if (f.fx2.y > 0.001) { c = vhsLook(c, uv, in.pos.xy); }
  /*ENDFX2*/

  let vig = f.g2.y;
  if (vig > 0.001) {
    let p = (in.uv - 0.5) * vec2f(aspect, 1.0) / (0.5 * sqrt(aspect * aspect + 1.0));
    c *= 1.0 - vig * smoothstep(0.35, 1.05, length(p));
  }

  // Light leak: warm glows drifting slowly in from the edges (screen blend).
  let leak = f.fx1.x;
  if (leak > 0.001) {
    let t = f.fx1.z;
    let p1 = vec2f(-0.1 + 0.25 * sin(t * 0.31), 0.2 + 0.3 * sin(t * 0.23 + 1.0));
    let p2 = vec2f(1.1 + 0.2 * sin(t * 0.27 + 2.0), 0.8 + 0.25 * sin(t * 0.19));
    let q = in.uv * vec2f(aspect, 1.0);
    let l1 = exp(-6.0 * dot(q - p1 * vec2f(aspect, 1.0), q - p1 * vec2f(aspect, 1.0)));
    let l2 = exp(-7.0 * dot(q - p2 * vec2f(aspect, 1.0), q - p2 * vec2f(aspect, 1.0)));
    let light = (vec3f(1.0, 0.45, 0.15) * l1 + vec3f(1.0, 0.25, 0.45) * l2) * leak * (0.75 + 0.25 * sin(t * 1.3));
    c = 1.0 - (1.0 - c) * (1.0 - clamp(light, vec3f(0.0), vec3f(1.0)));
  }

  // Film grain: fresh noise every frame, strongest in the mid-tones.
  let grain = f.fx0.x;
  if (grain > 0.001) {
    let n = hash(vec3f(in.uv * f.size.xy, f.fx1.z * 60.0)) - 0.5;
    let l = luma(c);
    c += vec3f(n * grain * 0.22 * (1.0 - abs(l - 0.5) * 1.2));
  }

  // Half a step of noise, so smooth skies stretched out of a log recording don't band.
  if (f.fx1.w > 0.5) { c += vec3f(hash(vec3f(in.pos.xy, f.fx1.z * 61.0)) + hash(vec3f(in.pos.yx + 31.0, f.fx1.z * 61.0 + 5.0)) - 1.0) * f.mark.z; }

  if (f.mark.x > 0.5) {
    let on = select(1.0 - backShare, backShare, f.mark.x > 1.5);
    c = mix(c, vec3f(0.2, 0.75, 1.0), on * 0.28);
  }

  /*MASKS*/
  if (masked) {
    for (var i = 0u; i < 4u; i++) {
      let w = mk[i];
      if (w > 0.002 && f.maskKind[i] > 2.5 && f.maskKind[i] < 3.5) { c = mix(c, hideColor(i), w * f.maskAmt[i]); }
    }
  }
  /*END*/

  /*PRO*/
  // Showing what the qualifier picks (preview only).
  if (f.q2.w > 0.5) { c = vec3f(qm); }
  /*ENDPRO*/

  // Cinematic bars.
  let bars = f.fx1.y * 0.125;
  if (in.uv.y < bars || in.uv.y > 1.0 - bars) { c = vec3f(0.0); }
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  // Exporting: the values a video file holds (what the browser shows them as, undone).
  if (f.mark.y > 0.01) { c = pow(srgbToLight(c), vec3f(1.0 / f.mark.y)); }
  return vec4f(c, 1.0);
}
`;

/** Optional parts of the finish shader. */
export interface FinishParts {
  /** Masks and power windows (binding 4). */
  masks?: boolean;
  /** Wheels, curves, qualifier, film looks (bindings 5 and 6). */
  pro?: boolean;
  /** Noise reduction. */
  nr?: boolean;
  /** Bloom, halation, VHS, shake, RGB split. */
  fx2?: boolean;
}

/**
 * The finish shader with only the parts a clip uses. The rest is left out: code that is only
 * skipped still makes the whole shader heavier for the GPU, and most clips use none of it.
 */
export function finishWgsl(parts: FinishParts | boolean): string {
  const p = typeof parts === 'boolean' ? { masks: parts } : parts;
  let code = FINISH_WGSL;
  if (!p.masks) code = code.replace(/\/\*MASKS\*\/[\s\S]*?\/\*END\*\//g, '');
  if (!p.pro) code = code.replace(/\/\*PRO\*\/[\s\S]*?\/\*ENDPRO\*\//g, '');
  if (!p.nr) code = code.replace(/\/\*NR\*\/[\s\S]*?\/\*ENDNR\*\//g, '');
  if (!p.fx2) code = code.replace(/\/\*FX2\*\/[\s\S]*?\/\*ENDFX2\*\//g, '');
  return code;
}

/** Bit of each part, for caching pipelines. */
export const finishKey = (p: FinishParts) => (p.masks ? 1 : 0) | (p.pro ? 2 : 0) | (p.nr ? 4 : 0) | (p.fx2 ? 8 : 0);
