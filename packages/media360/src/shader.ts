// WGSL for the reframe pass. Keep in sync with eac.ts / projection.ts (the CPU
// reference implementations that the unit tests cover).

export const REFRAME_WGSL = /* wgsl */ `
struct Tile {
  center : vec4f, // xyz = axis, w = stream index
  right  : vec4f, // xyz = axis
  down   : vec4f, // xyz = axis
  rect   : vec4f, // x, y, size (pixels), unused
};

struct Uniforms {
  m0 : vec4f, m1 : vec4f, m2 : vec4f,   // rows of the camera→footage matrix
  params : vec4f,  // aspect, fov (radians), projection (0 rect, 1 stereo), mode (0 360, 1 flat, 2 raw debug)
  stream : vec4f,  // stream width, stream height, frame aspect (flat mode), show tile overlay
  tiles : array<Tile, 6>,
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

fn cameraRay(ndc : vec2f) -> vec3f {
  let aspect = u.params.x;
  let fov = u.params.y;
  let px = ndc.x * aspect;
  let py = ndc.y;
  if (u.params.z < 0.5) {
    let k = tan(fov * 0.5) / aspect;
    return normalize(vec3f(px * k, py * k, 1.0));
  }
  let k = 2.0 * tan(fov * 0.25) / aspect;
  let x = px * k;
  let y = py * k;
  let r = length(vec2f(x, y));
  if (r < 1e-6) { return vec3f(0.0, 0.0, 1.0); }
  let theta = 2.0 * atan(r * 0.5);
  let s = sin(theta) / r;
  return vec3f(x * s, y * s, cos(theta));
}

fn sampleStreams(stream : f32, uv : vec2f) -> vec4f {
  // Sample both and select: keeps control flow uniform for the external textures.
  let a = textureSampleBaseClampToEdge(tex0, samp, uv);
  let b = textureSampleBaseClampToEdge(tex1, samp, uv);
  return select(a, b, stream > 0.5);
}

fn sampleSphere(dirIn : vec3f) -> vec4f {
  let dir = normalize(dirIn);
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
  // Clamp half a pixel inside the tile so filtering never bleeds into a neighbour.
  let px = clamp(t.rect.x + (es + 1.0) * 0.5 * size, t.rect.x + 0.5, t.rect.x + size - 0.5);
  let py = clamp(t.rect.y + (ev + 1.0) * 0.5 * size, t.rect.y + 0.5, t.rect.y + size - 0.5);
  return sampleStreams(t.center.w, vec2f(px, py) / u.stream.xy);
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
      let inside = p.x >= r.x && p.x < r.x + r.z && p.y >= r.y && p.y < r.y + r.z;
      let edge = min(min(p.x - r.x, r.x + r.z - p.x), min(p.y - r.y, r.y + r.z - p.y));
      if (inside && edge < lw) { col = vec4f(faceColor(i), 1.0); }
    }
  }
  return col;
}

fn flat(ndc : vec2f) -> vec4f {
  // Letterbox the first stream into the canvas.
  let canvasAspect = u.params.x;
  let frameAspect = u.stream.z;
  var uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (canvasAspect > frameAspect) {
    uv.x = (uv.x - 0.5) * canvasAspect / frameAspect + 0.5;
  } else {
    uv.y = (uv.y - 0.5) * frameAspect / canvasAspect + 0.5;
  }
  let c = textureSampleBaseClampToEdge(tex0, samp, clamp(uv, vec2f(0.0), vec2f(1.0)));
  let outside = any(uv < vec2f(0.0)) || any(uv > vec2f(1.0));
  return select(c, vec4f(0.0, 0.0, 0.0, 1.0), outside);
}

@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  let mode = u.params.w;
  if (mode > 1.5) { return rawDebug(in.ndc); }
  if (mode > 0.5) { return flat(in.ndc); }
  let ray = cameraRay(in.ndc);
  let dir = vec3f(dot(u.m0.xyz, ray), dot(u.m1.xyz, ray), dot(u.m2.xyz, ray));
  return vec4f(sampleSphere(dir).rgb, 1.0);
}
`;
