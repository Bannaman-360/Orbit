// Finishing pass: motion blur (frame blending), sharpen, colour grade, LUT, vignette.
// Reads the reframed history layers and writes the final image.

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
};

@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var history : texture_2d_array<f32>;
@group(0) @binding(2) var lut : texture_3d<f32>;
@group(0) @binding(3) var<uniform> f : Finish;

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

fn applyLut(c : vec3f) -> vec3f {
  let n = f.blend.w;
  let coord = (c * (n - 1.0) + 0.5) / n;
  let l = textureSampleLevel(lut, samp, coord, 0.0).rgb;
  return mix(c, l, f.g2.w);
}

@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  if (f.blend.y > 0.5) { return vec4f(clamp(blended(in.uv), vec3f(0.0), vec3f(1.0)), 1.0); }
  var c = source(in.uv);

  // How much of this pixel is the back lens's (kept in the history's alpha by 360 clips).
  let backShare = textureSampleLevel(history, samp, in.uv, layerFor(0u), 0.0).a;
  let clarity = mix(f.lens.z, f.lens.w, backShare);
  if (clarity > 0.001) {
    // Local contrast: against the average of a wide ring.
    var wide = vec3f(0.0);
    let cr = vec2f(0.014 * f.size.y / f.size.x, 0.014);
    for (var i = 0; i < 8; i++) {
      let a = f32(i) * 0.7853982;
      wide += blended(in.uv + vec2f(cos(a), sin(a)) * cr) + blended(in.uv + vec2f(cos(a + 0.39), sin(a + 0.39)) * cr * 2.2);
    }
    c = max(vec3f(0.0), c + vec3f(luma(c) - luma(wide / 16.0)) * clarity * 0.9);
  }

  // Unsharp mask against the 4 neighbours.
  let sharpen = f.g2.z + mix(f.lens.x, f.lens.y, backShare);
  if (sharpen > 0.001) {
    let d = f.size.zw;
    let nb = (blended(in.uv + vec2f(d.x, 0.0)) + blended(in.uv - vec2f(d.x, 0.0)) +
              blended(in.uv + vec2f(0.0, d.y)) + blended(in.uv - vec2f(0.0, d.y))) * 0.25;
    var detail = (c - nb) * sharpen * 1.5;
    // Above 100%, also sharpen at a 2-pixel radius so stronger settings bring out texture,
    // not just pixel-level edges (which would turn into noise).
    if (sharpen > 1.0) {
      let d2 = d * 2.0;
      let nb2 = (blended(in.uv + vec2f(d2.x, 0.0)) + blended(in.uv - vec2f(d2.x, 0.0)) +
                 blended(in.uv + vec2f(0.0, d2.y)) + blended(in.uv - vec2f(0.0, d2.y))) * 0.25;
      detail += (c - nb2) * (sharpen - 1.0) * 0.8;
    }
    c = clamp(c + detail, vec3f(0.0), vec3f(select(1.0, 8.0, f.fx1.w > 0.5)));
  }

  c = grade(c);
  if (f.blend.z > 0.5) { c = applyLut(c); }

  let aspect = f.size.x / f.size.y;

  // Glow: soft light bleeding out of bright areas (a ring of samples around the pixel).
  let glow = f.fx0.y;
  if (glow > 0.001) {
    var bloom = vec3f(0.0);
    let r = vec2f(0.012 / aspect, 0.012);
    for (var i = 0; i < 12; i++) {
      let a = f32(i) * 0.5235988;
      for (var j = 1; j <= 2; j++) {
        let s = min(blended(in.uv + vec2f(cos(a), sin(a)) * r * f32(j) * 1.6), vec3f(1.0));
        bloom += max(s - vec3f(0.55), vec3f(0.0)) / (0.45 * f32(j));
      }
    }
    c = 1.0 - (1.0 - c) * (1.0 - clamp(bloom / 18.0 * glow * 2.2, vec3f(0.0), vec3f(1.0)));
  }

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

  // Cinematic bars.
  let bars = f.fx1.y * 0.125;
  if (in.uv.y < bars || in.uv.y > 1.0 - bars) { c = vec3f(0.0); }
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  // Exporting: the values a video file holds (what the browser shows them as, undone).
  if (f.mark.y > 0.01) { c = pow(srgbToLight(c), vec3f(1.0 / f.mark.y)); }
  return vec4f(c, 1.0);
}
`;
