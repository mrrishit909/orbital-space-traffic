// Shaders. Object positions are interpolated on the GPU (cubic Hermite between two propagated samples), so the CPU does no
// per-object work per frame. Earth uses day/night textures split at the real terminator for the scene's time.
import * as THREE from "three";

export const KIND = { payload: 0, rocket_body: 1, debris: 2, unknown: 3 } as const;
export const FLAG = { fleet: 1, selected: 2, secondary: 4 } as const;

const hermite = /* glsl */ `
  attribute vec3 p0; attribute vec3 v0; attribute vec3 p1; attribute vec3 v1;
  uniform float uF; uniform float uDt;
  vec3 hermitePos() {
    float f = uF, f2 = f * f, f3 = f2 * f;
    return (2.0*f3 - 3.0*f2 + 1.0) * p0 + (f3 - 2.0*f2 + f) * uDt * v0 + (-2.0*f3 + 3.0*f2) * p1 + (f3 - f2) * uDt * v1;
  }`;

export function objectsMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uF: { value: 0 }, uDt: { value: 1 }, uScale: { value: 1 }, uReveal: { value: 1 }, uFleetOnly: { value: 0 }, uDim: { value: 0 },
      uColors: { value: [new THREE.Color("#7fb2ff"), new THREE.Color("#ffb454"), new THREE.Color("#b9b2a6"), new THREE.Color("#a0a0a0")] },
      uFleet: { value: new THREE.Color("#5ef2c2") },
    },
    vertexShader: /* glsl */ `
      ${hermite}
      attribute float kind; attribute float flags; attribute float alt;
      uniform float uScale; uniform float uReveal; uniform float uFleetOnly; uniform float uDim;
      varying float vKind; varying float vFlags; varying float vAlpha;
      void main() {
        vec3 p = hermitePos();
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        bool fleet = mod(flags, 2.0) > 0.5;
        bool sel = mod(floor(flags / 2.0), 2.0) > 0.5;
        bool sec = mod(floor(flags / 4.0), 2.0) > 0.5;
        // reveal by altitude band during the intro (LEO first, then MEO, then GEO): uReveal 0..1 sweeps 200 km .. 40,000 km
        float revealAlt = mix(0.2, 40.0, uReveal * uReveal);
        float shown = smoothstep(revealAlt + 0.4, revealAlt - 0.4, alt);
        float a = shown * (uFleetOnly > 0.5 && !fleet ? 0.18 : 1.0) * (1.0 - 0.75 * uDim);
        if (fleet || sel || sec) a = max(a, shown);
        // distance attenuation (depth fog): far objects fade, nothing disappears
        float d = -mv.z;
        a *= clamp(1.25 - d / 220.0, 0.35, 1.0);
        vAlpha = p.x > 1e5 ? 0.0 : a;
        vKind = kind; vFlags = flags;
        float size = kind < 0.5 ? 2.2 : kind < 1.5 ? 2.6 : 1.5;
        if (fleet) size = 3.4;
        if (sec) size = 6.0;
        if (sel) size = 7.0;
        gl_PointSize = size * uScale;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColors[4]; uniform vec3 uFleet;
      varying float vKind; varying float vFlags; varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c);
        bool fleet = mod(vFlags, 2.0) > 0.5;
        bool sel = mod(floor(vFlags / 2.0), 2.0) > 0.5;
        bool sec = mod(floor(vFlags / 4.0), 2.0) > 0.5;
        int k = int(vKind + 0.5);
        // shape carries the type as well as colour: payload = disc, rocket body = square, debris = small dot
        if (k == 1) { if (max(abs(c.x), abs(c.y)) > 0.42) discard; }
        else if (r > 0.5) discard;
        vec3 col = fleet ? uFleet : uColors[k];
        float a = vAlpha;
        if (sel || sec) { // ring marks the selected object and the other party of the open conjunction
          float ring = smoothstep(0.5, 0.42, r) * smoothstep(0.26, 0.34, r);
          col = sel ? vec3(1.0) : vec3(1.0, 0.45, 0.35);
          a = max(ring, smoothstep(0.2, 0.1, r));
        }
        gl_FragColor = vec4(col, a);
      }`,
  });
}

/** Same geometry, each point drawn in a colour that encodes its index (GPU picking). */
export function pickMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uF: { value: 0 }, uDt: { value: 1 }, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      ${hermite}
      attribute float pickId;
      uniform float uScale;
      varying vec3 vId;
      void main() {
        vec3 p = hermitePos();
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        float id = pickId + 1.0;
        vId = vec3(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0)) / 255.0;
        gl_PointSize = 9.0 * uScale;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vId;
      void main() { if (length(gl_PointCoord - 0.5) > 0.5) discard; gl_FragColor = vec4(vId, 1.0); }`,
  });
}

export function earthMaterial(day: THREE.Texture, night: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: { uDay: { value: day }, uNight: { value: night }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uDim: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN;
      void main() { vUv = uv; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uDay; uniform sampler2D uNight; uniform vec3 uSun; uniform float uDim;
      varying vec2 vUv; varying vec3 vN;
      void main() {
        float s = dot(normalize(vN), normalize(uSun));
        float day = smoothstep(-0.08, 0.12, s); // civil-twilight-wide terminator
        vec3 d = texture2D(uDay, vUv).rgb * (0.25 + 0.85 * max(s, 0.0));
        vec3 n = texture2D(uNight, vUv).rgb * vec3(1.0, 0.85, 0.6) * 0.9;
        // day-side haze: a cheap stand-in for Rayleigh scattering, brightest toward the limb (not a physical model)
        float view = 1.0 - abs(dot(normalize(vN), normalize(cameraPosition)));
        vec3 haze = vec3(0.10, 0.20, 0.38) * (0.55 + 0.9 * view) * max(s, 0.0);
        vec3 col = mix(n, d * 1.15 + haze, day);
        gl_FragColor = vec4(col * (1.0 - 0.6 * uDim), 1.0);
      }`,
  });
}

/** Thin limb glow: a view-dependent rim, not a physical scattering model. */
export function atmosphereMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vView;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vView = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; varying vec3 vN; varying vec3 vView;
      void main() {
        float rim = pow(1.0 - abs(dot(vN, vView)), 3.0);
        float lit = 0.25 + 0.75 * smoothstep(-0.3, 0.4, dot(-vN, normalize(uSun)));
        gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * rim * lit, rim * 0.8);
      }`,
  });
}
