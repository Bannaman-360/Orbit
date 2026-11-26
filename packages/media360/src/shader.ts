// WGSL for the reframe pass. Keep in sync with eac.ts / projection.ts (the CPU
// reference implementations that the unit tests cover).

import { INPUT_WGSL } from './inputColor';
import { LENS_WGSL } from './lensMatch';

export const REFRAME_WGSL = /* wgsl */ `
struct Tile {
  center : vec4f, // xyz = axis, w = stream index
  right  : vec4f, // xyz = axis
  down   : vec4f, // xyz = axis
  rect   : vec4f, // x, y, size (pixels), lens-overlap gap in the middle (pixels, 0 = whole face)
};

struct Uniforms {
  m0 : vec4f, m1 : vec4f, m2 : vec4f,   // rows of the camera→footage matrix; w: m0 mask bars (1), m1 rolling-shutter rows, m2 stitched 360 picture (equirectangular)
  params : vec4f,  // aspect, fov (radians), lens k (see projection.ts), mode (0 360, 1 flat, 2 raw debug, 3 flat through its lens)
  stream : vec4f,  // stream width, stream height, frame aspect (flat mode), show tile overlay
  src0 : vec4f,    // source lens polynomial c0..c3 (see sourceLens.ts)
  src1 : vec4f,    // c4, kind (1 = linear), 1 / radius at half the field of view, widest angle
  src2 : vec4f,    // unstretched aspect, stretch, output scale x, y (flat mode: pan x, y)
  src3 : vec4f,    // output lens (1 = the source's own, 0 = lens family), zoom, quarter turns, picture aspect
  gp : array<vec4f, 5>,    // GoPro lens: poly1..4 | poly5, poly6, 1/zoom, widest radius | mapX 0..3 | mapX 4..7 | mapY
  tiles : array<Tile, 6>,
  rows : array<vec4f, 27>, // 9 camera→footage matrices, top row of the picture to bottom
  col0 : vec4f, // input colour (see inputColor.ts): on, browser gamma, browser wide, range fix
  col1 : vec4f, // curve, log base, gain, wide camera colours
  col2 : vec4f, // output gamma, dither, noise seed
  lensF0 : vec4f, lensF1 : vec4f, // front lens: brightness, contrast, veil, saturation | warmth, tint, on (see lensMatch.ts)
  lensB0 : vec4f, lensB1 : vec4f, // back lens
};

@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex0 : texture_external;
@group(0) @binding(2) var tex1 : texture_external;
@group(0) @binding(3) var<uniform> u : Uniforms;

struct VsOut { @builtin(position) pos : vec4f, @location(0) ndc : vec2f };

@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  // Fullscreen triangle.
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o : VsOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.ndc = p[i];
  return o;
}

const PI = 3.14159265358979;
${INPUT_WGSL}

// Lens family r(θ): tan(kθ)/k (k>0), θ (k=0), sin(kθ)/k (k<0). See projection.ts.
fn lensForward(k : f32, theta : f32) -> f32 {
  if (abs(k) < 1e-4) { return theta; }
  if (k > 0.0) { return tan(k * theta) / k; }
  return sin(k * theta) / k;
}

// Returns θ, or -1 outside the lens's image circle.
fn lensInverse(k : f32, r : f32) -> f32 {
  if (abs(k) < 1e-4) { return r; }
  if (k > 0.0) { return atan(k * r) / k; }
  let s = -k * r;
  if (s > 1.0) { return -1.0; }
  return asin(s) / -k;
}

// Camera-space ray, w = 0 when the pixel is outside the image circle.
fn cameraRay(ndc : vec2f) -> vec4f {
  let aspect = u.params.x;
  let fov = u.params.y;
  let k = u.params.z;
  let R = lensForward(k, fov * 0.5);
  let x = ndc.x * R;
  let y = ndc.y * R / aspect;
  let r = length(vec2f(x, y));
  if (r < 1e-7) { return vec4f(0.0, 0.0, 1.0, 1.0); }
  let theta = lensInverse(k, r);
  if (theta < 0.0 || theta > PI) { return vec4f(0.0, 0.0, 1.0, 0.0); }
  let s = sin(theta) / r;
  return vec4f(x * s, y * s, cos(theta), 1.0);
}

fn sampleStreams(stream : f32, uv : vec2f) -> vec4f {
  // Sample both and select: keeps control flow uniform for the external textures.
  let a = textureSampleBaseClampToEdge(tex0, samp, uv);
  let b = textureSampleBaseClampToEdge(tex1, samp, uv);
  return select(a, b, stream > 0.5);
}

${LENS_WGSL}
// A stitched 360 picture: longitude across, latitude down, wrapping round at the back.
fn sampleEquirect(dir : vec3f) -> vec4f {
  let lon = atan2(dir.x, dir.z);
  let lat = asin(clamp(dir.y, -1.0, 1.0));
  let x = (lon / (2.0 * PI) + 0.5) * u.stream.x;
  let v = 0.5 - lat / PI;
  let c = textureSampleBaseClampToEdge(tex0, samp, vec2f(x / u.stream.x, v));
  // Within half a pixel of the seam, the neighbour is on the other side.
  let a = textureSampleBaseClampToEdge(tex0, samp, vec2f(0.5 / u.stream.x, v));
  let b = textureSampleBaseClampToEdge(tex0, samp, vec2f(1.0 - 0.5 / u.stream.x, v));
  let left = min(x, u.stream.x - x);
  let own = select(b, a, x < u.stream.x * 0.5);
  let other = select(a, b, x < u.stream.x * 0.5);
  return select(c, mix(other, own, 0.5 + left), left < 0.5);
}

// The sphere's colour there, and how much of it is the back lens's (a).
fn sampleSphere(dirIn : vec3f) -> vec4f {
  let dir = normalize(dirIn);
  if (u.m2.w > 0.5) { return vec4f(inputColor(sampleEquirect(dir)).rgb, 0.0); }
  var best = 0u;
  var bestDot = -2.0;
  for (var i = 0u; i < 6u; i++) {
    let d = dot(dir, u.tiles[i].center.xyz);
    if (d > bestDot) { bestDot = d; best = i; }
  }
  let t = u.tiles[best];
  let s = dot(dir, t.right.xyz) / bestDot;
  let v = dot(dir, t.down.xyz) / bestDot;
  let es = (4.0 / PI) * atan(s);
  let ev = (4.0 / PI) * atan(v);
  let size = t.rect.z;
  let gap = t.rect.w;
  // Clamp half a pixel inside the tile so filtering never bleeds into a neighbour.
  let py = clamp(t.rect.y + (ev + 1.0) * 0.5 * size, t.rect.y + 0.5, t.rect.y + size - 0.5);
  let stream = t.center.w;
  if (gap < 0.5) {
    let px = clamp(t.rect.x + (es + 1.0) * 0.5 * size, t.rect.x + 0.5, t.rect.x + size - 0.5);
    let isBack = t.center.z < 0.0;
    return vec4f(fromLens(stream, vec2f(px, py) / u.stream.xy, isBack), select(0.0, 1.0, isBack));
  }
  // Split face: two halves, one per lens. Each shows its 45° in about (size − gap) / 2 pixels
  // and carries on for about gap pixels past the midline; crossfade between them there (see eac.ts).
  let half = size * 0.5 - gap * 31.0 / 64.0;
  let mid = t.rect.x + (size + gap) * 0.5;
  let xl = clamp(t.rect.x + (es + 1.0) * half, t.rect.x + 0.5, mid - 0.5);
  let xr = clamp(t.rect.x + size + gap - half + es * half, mid + 0.5, t.rect.x + size + gap - 0.5);
  let band = ((size + gap) * 0.5 - half) / half; // overlap half-width in es units
  let w = smoothstep(-band, band, es);
  // The half towards the front (+z) is the front lens's.
  let rightFront = t.right.z > 0.0;
  let a = fromLens(stream, vec2f(xl, py) / u.stream.xy, rightFront);
  let b = fromLens(stream, vec2f(xr, py) / u.stream.xy, !rightFront);
  return vec4f(mix(a, b, w), select(w, 1.0 - w, rightFront));
}

fn faceColor(i : u32) -> vec3f {
  var c = array<vec3f, 6>(
    vec3f(1.0, 0.3, 0.3), vec3f(0.3, 1.0, 0.3), vec3f(0.3, 0.5, 1.0),
    vec3f(1.0, 1.0, 0.3), vec3f(1.0, 0.3, 1.0), vec3f(0.3, 1.0, 1.0));
  return c[i];
}

fn rawDebug(ndc : vec2f) -> vec4f {
  // Stream 0 on the top half, stream 1 on the bottom half.
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let stream = select(0.0, 1.0, uv.y >= 0.5);
  let suv = vec2f(uv.x, fract(uv.y * 2.0));
  var col = sampleStreams(stream, suv);
  if (u.stream.w > 0.5) {
    let p = suv * u.stream.xy;
    let lw = u.stream.x / 600.0;
    for (var i = 0u; i < 6u; i++) {
      let t = u.tiles[i];
      if (abs(t.center.w - stream) > 0.5) { continue; }
      let r = t.rect;
      let tw = r.z + r.w;
      let inside = p.x >= r.x && p.x < r.x + tw && p.y >= r.y && p.y < r.y + r.z;
      let edge = min(min(p.x - r.x, r.x + tw - p.x), min(p.y - r.y, r.y + r.z - p.y));
      if (inside && edge < lw) { col = vec4f(faceColor(i), 1.0); }
      // Dashed lines bounding the lens-overlap strip.
      let m0 = r.x + r.z * 0.5;
      let onStrip = r.w > 0.5 && (abs(p.x - m0) < lw * 0.5 || abs(p.x - m0 - r.w) < lw * 0.5);
      if (inside && onStrip && fract(p.y / 40.0) < 0.5) { col = vec4f(faceColor(i), 1.0); }
    }
  }
  return col;
}

// --- Regular clips seen through their own lens (CPU reference: sourceLens.ts) ---

fn srcRadius(t : f32) -> f32 {
  if (u.src1.y > 0.5) { return tan(t); }
  let q = t * t;
  return t * (u.src0.x + q * (u.src0.y + q * (u.src0.z + q * (u.src0.w + q * u.src1.x))));
}
fn srcAngle(r : f32) -> f32 {
  if (u.src1.y > 0.5) { return atan(r); }
  let m = u.src1.w;
  if (r >= srcRadius(m)) { return m; }
  var t = min(m, r / u.src0.x);
  for (var i = 0; i < 6; i++) {
    let q = t * t;
    let d = u.src0.x + q * (3.0 * u.src0.y + q * (5.0 * u.src0.z + q * (7.0 * u.src0.w + q * 9.0 * u.src1.x)));
    t = clamp(t - (srcRadius(t) - r) / max(1e-4, d), 0.0, m);
  }
  return t;
}
// GoPro's own lens (src1.y = 2); see GoProLens in sourceLens.ts.
fn gpPlane(p : vec2f) -> vec2f {
  let a = p.x * 0.5;
  let b = p.y * 0.5;
  let a2 = a * a;
  let b2 = b * b;
  let m = u.gp[2];
  let n = u.gp[3];
  let x = a * (m.x + a2 * (m.y + a2 * (m.z + a2 * (m.w + a2 * (n.x + a2 * (n.y + a2 * n.z))))) + n.w * b2);
  let y = b * (u.gp[4].x + u.gp[4].y * b2 + u.gp[4].z * a2 + u.gp[4].w * a2 * a2);
  return vec2f(2.0 * x * u.src2.x, 2.0 * y);
}
fn gpTheta(r : f32) -> f32 {
  let p = u.gp[0];
  let q = u.gp[1];
  return r * (p.x + r * (p.y + r * (p.z + r * (p.w + r * (q.x + r * q.y)))));
}
fn gpSlope(r : f32) -> f32 {
  let p = u.gp[0];
  let q = u.gp[1];
  return p.x + r * (2.0 * p.y + r * (3.0 * p.z + r * (4.0 * p.w + r * (5.0 * q.x + r * 6.0 * q.y))));
}
fn gpRadius(theta : f32) -> f32 {
  let m = u.gp[1].w;
  if (theta >= gpTheta(m)) { return m; }
  var r = min(m, theta / u.gp[0].x);
  for (var i = 0; i < 6; i++) { r = clamp(r - (gpTheta(r) - theta) / max(1e-3, gpSlope(r)), 0.0, m); }
  return r;
}
// Direction → picture point (xy) and how far it missed (z; more than a little = outside).
fn gpPicture(dir : vec3f) -> vec3f {
  let s = length(dir.xy);
  let theta = atan2(s, dir.z);
  let k = gpRadius(theta) / u.gp[1].z / max(s, 1e-7);
  let t = dir.xy * k;
  var p = clamp(vec2f(t.x / u.src2.x, t.y), vec2f(-1.0), vec2f(1.0));
  let h = 1e-3;
  for (var i = 0; i < 8; i++) {
    let c = gpPlane(p);
    let jx = (gpPlane(p + vec2f(h, 0.0)) - c) / h;
    let jy = (gpPlane(p + vec2f(0.0, h)) - c) / h;
    let det = jx.x * jy.y - jy.x * jx.y;
    if (abs(det) < 1e-5) { break; }
    let e = t - c;
    let d = vec2f(jy.y * e.x - jy.x * e.y, jx.x * e.y - jx.y * e.x) / det;
    p = clamp(p + clamp(d, vec2f(-0.4), vec2f(0.4)), vec2f(-1.01), vec2f(1.01));
  }
  return vec3f(p, length(gpPlane(p) - t) + max(0.0, theta - u.src1.w));
}

fn stretchX(x : f32) -> f32 { let a = u.src2.y; return x * (a + (1.0 - a) * x * x); }
fn unstretchX(x : f32) -> f32 {
  let a = u.src2.y;
  if (a > 0.9999) { return x; }
  var v = x;
  for (var i = 0; i < 6; i++) { v -= (stretchX(v) - x) / max(0.05, a + 3.0 * (1.0 - a) * v * v); }
  return v;
}

// View ray for an output point through the source's own lens or the chosen one. w = 0: nothing there.
fn flatRay(ndc : vec2f) -> vec4f {
  let n = ndc * u.src2.zw;
  if (u.src3.x > 0.5) {
    let p = n * u.src3.y;
    if (u.src1.y > 1.5) {
      let g = gpPlane(clamp(p, vec2f(-1.02), vec2f(1.02)));
      let gr = length(g);
      if (gr < 1e-7) { return vec4f(0.0, 0.0, 1.0, 1.0); }
      let gt = gpTheta(min(u.gp[1].w, gr * u.gp[1].z));
      return vec4f(g * (sin(gt) / gr), cos(gt), 1.0);
    }
    let q = vec2f(unstretchX(p.x), p.y / u.src2.x);
    let r = length(q);
    if (r < 1e-7) { return vec4f(0.0, 0.0, 1.0, 1.0); }
    let t = srcAngle(r / u.src1.z);
    let s = sin(t) / r;
    return vec4f(q * s, cos(t), 1.0);
  }
  let k = u.params.z;
  let R = lensForward(k, u.params.y * 0.5);
  let q = vec2f(n.x * R, n.y * R / u.src3.w);
  let r = length(q);
  if (r < 1e-7) { return vec4f(0.0, 0.0, 1.0, 1.0); }
  let t = lensInverse(k, r);
  if (t < 0.0 || t > PI) { return vec4f(0.0, 0.0, 1.0, 0.0); }
  let s = sin(t) / r;
  return vec4f(q * s, cos(t), 1.0);
}

// The stored picture may be turned (cameras held upright or upside down).
fn turnUv(uv : vec2f) -> vec2f {
  let q = u.src3.z;
  if (q > 2.5) { return vec2f(1.0 - uv.y, uv.x); }
  if (q > 1.5) { return vec2f(1.0 - uv.x, 1.0 - uv.y); }
  if (q > 0.5) { return vec2f(uv.y, 1.0 - uv.x); }
  return uv;
}

// A ray turned by the camera→footage matrix of picture row v (0 top … 1 bottom).
fn rowTurn(ray : vec3f, v : f32) -> vec3f {
  let x = clamp(v, 0.0, 1.0) * 8.0;
  let i = u32(min(x, 7.0));
  let f = x - f32(i);
  let a = i * 3u;
  let b = a + 3u;
  let p = vec3f(dot(u.rows[a].xyz, ray), dot(u.rows[a + 1u].xyz, ray), dot(u.rows[a + 2u].xyz, ray));
  let q = vec3f(dot(u.rows[b].xyz, ray), dot(u.rows[b + 1u].xyz, ray), dot(u.rows[b + 2u].xyz, ray));
  return normalize(mix(p, q, f));
}

// Row (0 top … 1 bottom, as read off the sensor) where a direction lands in the stored picture.
fn rowOf(dir : vec3f) -> f32 {
  if (u.src1.y > 1.5) { return turnUv(vec2f(0.5, 0.5) + gpPicture(dir).xy * vec2f(0.5, -0.5)).y; }
  let s = length(dir.xy);
  let r = srcRadius(min(atan2(s, dir.z), u.src1.w)) * u.src1.z;
  let d = select(vec2f(0.0), dir.xy / s, s > 1e-7);
  let uv = vec2f(stretchX(r * d.x) * 0.5 + 0.5, 0.5 - r * d.y * u.src2.x * 0.5);
  return turnUv(uv).y;
}

fn throughLens(dir : vec3f) -> vec4f {
  if (u.src1.y > 1.5) {
    let g = gpPicture(dir);
    let guv = vec2f(0.5, 0.5) + g.xy * vec2f(0.5, -0.5);
    let gc = textureSampleBaseClampToEdge(tex0, samp, turnUv(clamp(guv, vec2f(0.0), vec2f(1.0))));
    return select(inputColor(gc), vec4f(0.0, 0.0, 0.0, 1.0), g.z > 0.004 || any(abs(g.xy) > vec2f(1.002)));
  }
  let s = length(dir.xy);
  let theta = atan2(s, dir.z);
  let r = srcRadius(min(theta, u.src1.w)) * u.src1.z;
  let d = select(vec2f(0.0), dir.xy / s, s > 1e-7);
  let p = vec2f(stretchX(r * d.x), r * d.y * u.src2.x);
  let uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  // Soft one-pixel edge, so a border that does show is clean.
  let c = textureSampleBaseClampToEdge(tex0, samp, turnUv(clamp(uv, vec2f(0.0), vec2f(1.0))));
  let out = any(abs(p) > vec2f(1.002)) || theta > u.src1.w;
  return select(inputColor(c), vec4f(0.0, 0.0, 0.0, 1.0), out);
}

fn flat(ndc : vec2f) -> vec4f {
  // Fit (letterbox) or fill (crop) the first stream into the canvas.
  let canvasAspect = u.params.x;
  let frameAspect = u.stream.z;
  var uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let fill = u.stream.w > 0.5; // crop to fill instead of letterboxing
  // (Filled: src2.xy picks which part of the picture is shown, −1…1 across and down.)
  if ((canvasAspect > frameAspect) != fill) {
    let k = canvasAspect / frameAspect;
    uv.x = (uv.x - 0.5) * k + 0.5;
    if (fill) { uv.x += u.src2.x * (1.0 - k) * 0.5; }
  } else {
    let k = frameAspect / canvasAspect;
    uv.y = (uv.y - 0.5) * k + 0.5;
    if (fill) { uv.y += u.src2.y * (1.0 - k) * 0.5; }
  }
  let c = textureSampleBaseClampToEdge(tex0, samp, turnUv(clamp(uv, vec2f(0.0), vec2f(1.0))));
  let outside = any(uv < vec2f(0.0)) || any(uv > vec2f(1.0));
  return select(inputColor(c), vec4f(0.0, 0.0, 0.0, 1.0), outside);
}

@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  pixel = in.pos.xy;
  let mode = u.params.w;
  if (mode > 2.5) {
    let f4 = flatRay(in.ndc);
    var fd = vec3f(dot(u.m0.xyz, f4.xyz), dot(u.m1.xyz, f4.xyz), dot(u.m2.xyz, f4.xyz));
    if (u.m1.w > 0.5) {
      // Rolling shutter: each row was read at its own moment. Find the row, then look again.
      fd = rowTurn(f4.xyz, rowOf(fd));
      fd = rowTurn(f4.xyz, rowOf(fd));
    }
    let n = in.ndc * u.src2.zw;
    if (u.m0.w > 0.5 && any(abs(n) > vec2f(1.0))) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    return vec4f(throughLens(fd).rgb * f4.w, 1.0);
  }
  if (mode > 1.5) { return rawDebug(in.ndc); }
  if (mode > 0.5) { return flat(in.ndc); }
  // (360 footage can also be drawn as another camera's lens would see it: used for testing.)
  var ray4 = cameraRay(in.ndc);
  if (u.src3.x > 1.5) { ray4 = flatRay(in.ndc); }
  let ray = ray4.xyz;
  var dir = vec3f(dot(u.m0.xyz, ray), dot(u.m1.xyz, ray), dot(u.m2.xyz, ray));
  if (u.src3.x > 1.5 && u.m1.w > 0.5) { dir = rowTurn(ray, 0.5 - in.ndc.y * 0.5); }
  let c = sampleSphere(dir);
  return vec4f(c.rgb * ray4.w, c.a);
}
`;
