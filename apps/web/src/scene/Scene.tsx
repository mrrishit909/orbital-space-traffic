"use client";
// The globe: Earth at the scene's time, every catalogued object, the selected orbit, and a camera whose targets come from the
// current view. The canvas is a view of the store; it never owns business state.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { gstime, sunPos, jday } from "satellite.js";
import { shortestAngle } from "@orbital/motion";
import { get, select, set, useApp, worker, type Obj } from "../store.ts";
import { advance, clock, orchestrator, telemetry } from "../runtime.ts";
import { isIntro, type View } from "../journey.ts";
import { FLAG, KIND, atmosphereMaterial, earthMaterial, objectsMaterial, pickMaterial } from "./materials.ts";

const EARTH_R = 6.378135; // scene units = 1,000 km
type Cam = [number, number, number, number, number, number]; // target xyz, distance, azimuth, elevation

/** Scene-frame position (1,000 km units) of a TEME vector in km. */
export const sceneOf = (r: number[]) => new THREE.Vector3(r[0] / 1000, r[2] / 1000, -r[1] / 1000);

function sunDir(t: number) {
  const d = new Date(t);
  const jd = jday(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  const s = sunPos(jd).rsun;
  return new THREE.Vector3(s.x, s.z, -s.y).normalize();
}

function camTarget(view: View, chapterF: number): Cam | null {
  const s = get();
  const intro: Cam[] = [[0, 0, 0, 340, 0.9, 0.18], [0, 0, 0, 30, 0.6, 0.28], [0, 0, 0, 21, 0.2, 0.42], [0, 0, 0, 17, -0.4, 0.55]];
  if (isIntro(view)) {
    // scroll-driven: interpolate between chapter cameras by the fractional chapter (reduced motion snaps to whole chapters)
    const i = Math.floor(chapterF), f = chapterF - i, a = intro[Math.min(3, i)], b = intro[Math.min(3, i + 1)];
    const w = f * f * (3 - 2 * f);
    return a.map((x, k) => (k === 3 ? Math.exp(Math.log(x) * (1 - w) + Math.log(b[k]) * w) : x + (b[k] - x) * w)) as Cam;
  }
  if (view === "explore") return [0, 0, 0, 24, 0.5, 0.35];
  const o = s.selected !== null ? s.byNorad.get(s.selected) : undefined;
  if (view === "focus" && o) {
    // fly into the orbital plane: look down the orbit normal from about three orbit radii
    const n = orbitNormal(o);
    if (!n) return null;
    const el = Math.asin(Math.max(-1, Math.min(1, n.y))), az = Math.atan2(n.x, n.z);
    return [0, 0, 0, 3.1 * (EARTH_R + 0.55), az, Math.max(-1.3, Math.min(1.3, el))];
  }
  const c = s.conjunctions.find((x) => x.id === s.conjunctionId);
  if ((view === "encounter" || view === "plan") && c) {
    const p = sceneOf(c.rPrimary);
    const out = p.clone().normalize();
    return [p.x, p.y, p.z, 1.6, Math.atan2(out.x, out.z) + 0.5, Math.asin(out.y) * 0.6 + 0.25];
  }
  return null;
}

function orbitNormal(o: Obj) {
  const incl = o.l2.slice(8, 16), raan = o.l2.slice(17, 25);
  const i = (+incl * Math.PI) / 180, w = (+raan * Math.PI) / 180;
  // orbit normal in TEME from inclination and RAAN, then to scene frame
  const h = [Math.sin(i) * Math.sin(w), -Math.sin(i) * Math.cos(w), Math.cos(i)];
  return Number.isFinite(i) ? new THREE.Vector3(h[0], h[2], -h[1]).normalize() : null;
}

function Stars() {
  // three shells at different distances: they move against each other as the camera turns (parallax), nothing else animates
  const layers = useMemo(() => [1400, 2200, 3200].map((R, k) => {
    const n = 1400 - k * 300, pos = new Float32Array(n * 3);
    let seed = 17 + k;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      pos.set([R * r * Math.cos(th), R * u, R * r * Math.sin(th)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return { g, size: 1.6 - k * 0.35 };
  }), []);
  return <>{layers.map((l, k) => <points key={k} geometry={l.g}><pointsMaterial size={l.size} sizeAttenuation={false} color="#c8d3e6" transparent opacity={0.75} depthWrite={false} /></points>)}</>;
}

function Earth({ lowDetail }: { lowDetail: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const mats = useMemo(() => {
    const L = new THREE.TextureLoader();
    const day = L.load(`${base}/textures/earth-day-${lowDetail ? "1k" : "2k"}.jpg`), night = L.load(`${base}/textures/earth-night-${lowDetail ? "1k" : "2k"}.jpg`);
    day.colorSpace = THREE.SRGBColorSpace; night.colorSpace = THREE.SRGBColorSpace;
    day.anisotropy = 4;
    return { earth: earthMaterial(day, night), atmo: atmosphereMaterial() };
  }, [base, lowDetail]);
  useFrame(() => {
    const t = clock.t || get().window.now;
    if (!t || !mesh.current) return;
    mesh.current.rotation.y = gstime(new Date(t));
    const sun = sunDir(t);
    mats.earth.uniforms.uSun.value.copy(sun);
    mats.atmo.uniforms.uSun.value.copy(sun);
    mats.earth.uniforms.uDim.value = get().view === "encounter" || get().view === "plan" ? 0.3 : 0;
  });
  return (
    <group>
      <mesh ref={mesh} material={mats.earth}><sphereGeometry args={[EARTH_R, lowDetail ? 64 : 128, lowDetail ? 32 : 64]} /></mesh>
      <mesh material={mats.atmo} scale={1.025}><sphereGeometry args={[EARTH_R, 64, 32]} /></mesh>
    </group>
  );
}

interface Buf { t0: number; t1: number; p0: Float32Array; v0: Float32Array; p1: Float32Array; v1: Float32Array }

function Objects() {
  const objects = useApp((s) => s.objects);
  const n = useApp((s) => (s.load.status === "ready" ? s.objects.length + (s.stress ? 50000 - s.objects.length : 0) : 0));
  const selected = useApp((s) => s.selected);
  const cjId = useApp((s) => s.conjunctionId);
  const { gl, camera, size } = useThree();
  const st = useRef<{ cur: Buf | null; next: Buf | null; pending: boolean }>({ cur: null, next: null, pending: false });
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const z = () => new THREE.BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
    for (const k of ["p0", "v0", "p1", "v1"]) g.setAttribute(k, z().setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("position", g.getAttribute("p0"));
    const kind = new Float32Array(Math.max(1, n)), flags = new Float32Array(Math.max(1, n)), alt = new Float32Array(Math.max(1, n)), pick = new Float32Array(Math.max(1, n));
    for (let i = 0; i < n; i++) {
      const o = objects[i] ?? objects[i % Math.max(1, objects.length)];
      kind[i] = o ? KIND[o.type as keyof typeof KIND] ?? 3 : 2;
      flags[i] = i < objects.length && o?.operator === "aurora" ? FLAG.fleet : 0;
      const nRev = o ? +o.l2.slice(52, 63) : 15;
      alt[i] = (Math.cbrt(398600.8 / (nRev * 2 * Math.PI / 86400) ** 2) - 6378.135) / 1000;
      pick[i] = i;
    }
    g.setAttribute("kind", new THREE.BufferAttribute(kind, 1));
    g.setAttribute("flags", new THREE.BufferAttribute(flags, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("alt", new THREE.BufferAttribute(alt, 1));
    g.setAttribute("pickId", new THREE.BufferAttribute(pick, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    g.setDrawRange(0, n);
    st.current = { cur: null, next: null, pending: false };
    return g;
  }, [n, objects]);
  const mat = useMemo(() => objectsMaterial(), []);
  const pmat = useMemo(() => pickMaterial(), []);
  const pickScene = useMemo(() => new THREE.Scene(), []);
  const pickPoints = useMemo(() => new THREE.Points(geo, pmat), [geo, pmat]);
  useEffect(() => { pickScene.clear(); pickScene.add(pickPoints); }, [pickScene, pickPoints]);

  // flags: selected object and the other party of the open conjunction
  useEffect(() => {
    const f = geo.getAttribute("flags") as THREE.BufferAttribute;
    const c = get().conjunctions.find((x) => x.id === cjId);
    const byN = get().byNorad;
    for (let i = 0; i < objects.length; i++) f.array[i] = objects[i].operator === "aurora" ? FLAG.fleet : 0;
    if (selected !== null) { const o = byN.get(selected); if (o) f.array[o.i] = (f.array[o.i] as number) | FLAG.selected; }
    if (c) { const o = byN.get(c.secondaryNorad); if (o) f.array[o.i] = (f.array[o.i] as number) | FLAG.secondary; }
    f.needsUpdate = true;
  }, [geo, selected, cjId, objects]);

  // GPU picking on click: render ids into a 1x1 target under the cursor
  useEffect(() => {
    const target = new THREE.WebGLRenderTarget(1, 1);
    const px = new Uint8Array(4);
    let down: [number, number] | null = null;
    const el = gl.domElement;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || isIntro(get().view)) return;
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) * gl.getPixelRatio(), y = (e.clientY - r.top) * gl.getPixelRatio();
      const cam = camera as THREE.PerspectiveCamera;
      cam.setViewOffset(r.width * gl.getPixelRatio(), r.height * gl.getPixelRatio(), x, y, 1, 1);
      gl.setRenderTarget(target); gl.setClearColor(0, 0); gl.clear();
      gl.render(pickScene, cam);
      gl.readRenderTargetPixels(target, 0, 0, 1, 1, px);
      gl.setRenderTarget(null); cam.clearViewOffset();
      const id = px[0] + px[1] * 256 + px[2] * 65536 - 1;
      if (id >= 0 && id < get().objects.length) select(get().objects[id].norad);
    };
    el.addEventListener("pointerdown", onDown); el.addEventListener("pointerup", onUp);
    return () => { el.removeEventListener("pointerdown", onDown); el.removeEventListener("pointerup", onUp); target.dispose(); };
  }, [gl, camera, pickScene]);

  const request = (t0: number, t1: number) => {
    if (!worker || st.current.pending) return;
    st.current.pending = true;
    const geoAtRequest = geo;
    worker.call<"positions">({ type: "positions", t0, t1 }).then((m) => {
      if (geoAtRequest !== geo) return;
      st.current.pending = false;
      const b = { t0: m.t0, t1: m.t1, p0: m.p0, v0: m.v0, p1: m.p1, v1: m.v1 };
      if (!st.current.cur || clock.t < st.current.cur.t0 || clock.t > st.current.cur.t1) upload(b); else st.current.next = b;
    }).catch(() => { st.current.pending = false; });
  };
  const upload = (b: Buf) => {
    st.current.cur = b; st.current.next = null;
    for (const k of ["p0", "v0", "p1", "v1"] as const) {
      const a = geo.getAttribute(k) as THREE.BufferAttribute;
      (a.array as Float32Array).set(b[k].subarray(0, a.array.length));
      a.needsUpdate = true;
    }
  };

  useFrame(() => {
    const s = get();
    if (!n || !worker) return;
    const t = clock.t || s.window.now;
    const span = Math.max(2000, Math.min(120_000, (s.playing ? s.speed : 1) * 600));
    let cur = st.current.cur;
    if (cur && (t < cur.t0 || t > cur.t1) && st.current.next && t >= st.current.next.t0 && t <= st.current.next.t1) { upload(st.current.next); cur = st.current.cur; }
    if (!cur || t < cur.t0 || t > cur.t1 + span) request(t, t + span);
    else if (t > cur.t0 + 0.5 * (cur.t1 - cur.t0) && !st.current.next) request(cur.t1, cur.t1 + span);
    if (cur) {
      const dt = (cur.t1 - cur.t0) / 1000;
      const f = Math.max(0, Math.min(1.25, (t - cur.t0) / (cur.t1 - cur.t0)));
      for (const m of [mat, pmat]) { m.uniforms.uF.value = f; m.uniforms.uDt.value = dt; m.uniforms.uScale.value = Math.min(2, gl.getPixelRatio()) * (size.width < 700 ? 0.8 : 1); }
    }
    const v = s.view, intro = isIntro(v);
    mat.uniforms.uReveal.value = intro ? orchestrator.get("reveal")?.[0] ?? 0 : 1;
    mat.uniforms.uFleetOnly.value = v === "intro3" ? 1 : 0;
    mat.uniforms.uDim.value = v === "encounter" || v === "plan" ? 1 : 0;
  });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

function Trail() {
  const selected = useApp((s) => s.selected);
  const ready = useApp((s) => s.load.status === "ready");
  const ref = useRef<THREE.BufferGeometry>(null);
  useEffect(() => {
    if (selected === null || !worker || !ready) return;
    let live = true;
    worker.call<"trail">({ type: "trail", norad: selected, t: clock.t || get().window.now, samples: 240 }).then((m) => {
      if (!live || !ref.current) return;
      ref.current.setAttribute("position", new THREE.BufferAttribute(m.points, 3));
      ref.current.computeBoundingSphere();
    });
    return () => { live = false; };
  }, [selected, ready]);
  if (selected === null) return null;
  return <line><bufferGeometry ref={ref} /><lineBasicMaterial color="#ffffff" transparent opacity={0.55} /></line>;
}

function CameraRig() {
  const { camera, gl } = useThree();
  const drag = useRef<{ x: number; y: number } | null>(null);
  const lastView = useRef<View | null>(null);
  const user = useRef<Cam | null>(null); // user's own orbit/zoom on top of the view's camera
  useEffect(() => {
    const el = gl.domElement;
    const down = (e: PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY }; };
    const move = (e: PointerEvent) => {
      if (!drag.current || isIntro(get().view)) return;
      const c = (orchestrator.get("cam") ?? [0, 0, 0, 24, 0, 0]) as Cam;
      const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
      drag.current = { x: e.clientX, y: e.clientY };
      orchestrator.set("cam", [c[0], c[1], c[2], c[3], c[4] - dx * 0.005, Math.max(-1.45, Math.min(1.45, c[5] + dy * 0.005))]);
      user.current = orchestrator.get("cam") as Cam;
    };
    const up = () => { drag.current = null; };
    const wheel = (e: WheelEvent) => {
      if (isIntro(get().view)) return;
      e.preventDefault();
      const c = (orchestrator.get("cam") ?? [0, 0, 0, 24, 0, 0]) as Cam;
      const minD = get().view === "encounter" || get().view === "plan" ? 0.2 : 7.2;
      orchestrator.set("cam", [c[0], c[1], c[2], Math.max(minD, Math.min(400, c[3] * Math.exp(e.deltaY * 0.001))), c[4], c[5]]);
      user.current = orchestrator.get("cam") as Cam;
    };
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || isIntro(get().view) || !e.altKey) return;
      const c = (orchestrator.get("cam") ?? [0, 0, 0, 24, 0, 0]) as Cam;
      const d = { ArrowLeft: [0, -0.08, 0], ArrowRight: [0, 0.08, 0], ArrowUp: [0, 0, 0.06], ArrowDown: [0, 0, -0.06], "=": [0.9, 0, 0], "-": [1.1, 0, 0] }[e.key];
      if (!d) return;
      e.preventDefault();
      orchestrator.set("cam", [c[0], c[1], c[2], d[0] ? c[3] * d[0] : c[3], c[4] + d[1], Math.max(-1.45, Math.min(1.45, c[5] + d[2]))]);
    };
    el.addEventListener("pointerdown", down); window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    el.addEventListener("wheel", wheel, { passive: false }); window.addEventListener("keydown", key);
    return () => { el.removeEventListener("pointerdown", down); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); el.removeEventListener("wheel", wheel); window.removeEventListener("keydown", key); };
  }, [gl]);

  useFrame((_, dt) => {
    const s = get();
    orchestrator.policy.reduced = s.reduced;
    orchestrator.policy.paused = s.motionPaused;
    advance(dt * 1000, performance.now());
    orchestrator.tick(Math.min(100, dt * 1000));
    telemetry.frame(performance.now());
    const chapterF = s.reduced ? Math.round(introScroll.f) : introScroll.f;
    if (lastView.current !== s.view || (isIntro(s.view))) {
      const tgt = camTarget(s.view, chapterF);
      const cur = orchestrator.get("cam") as Cam | undefined;
      if (tgt) {
        if (isIntro(s.view)) orchestrator.set("cam", tgt);
        else if (lastView.current !== s.view) {
          const from = cur ?? tgt;
          tgt[4] = shortestAngle(from[4], tgt[4]);
          orchestrator.to("cam", tgt, s.view === "encounter" ? 2200 : 1600);
        }
      }
      orchestrator.to("reveal", [Math.min(1, Math.max(0, chapterF - 1))], 0);
      lastView.current = s.view;
      user.current = null;
    }
    const c = (orchestrator.get("cam") ?? [0, 0, 0, 340, 0.9, 0.18]) as Cam;
    const [tx, ty, tz, d, az, el] = c;
    camera.position.set(tx + d * Math.cos(el) * Math.sin(az), ty + d * Math.sin(el), tz + d * Math.cos(el) * Math.cos(az));
    camera.lookAt(tx, ty, tz);
    (camera as THREE.PerspectiveCamera).near = Math.max(0.0005, d * 0.01);
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
  });
  return null;
}

/** Scroll position of the intro, as a fractional chapter index 0..3 (written by the Intro component). */
export const introScroll = { f: 0 };

function Telemetry() {
  const { gl } = useThree();
  useEffect(() => {
    requestAnimationFrame(() => telemetry.mark("sceneLoadMs", performance.now())); // ms since navigation start to first frame
    const el = gl.domElement;
    const lost = (e: Event) => { e.preventDefault(); telemetry.contextLost(); set({ webgl: "lost" }); };
    const restored = () => set({ webgl: "ok" });
    el.addEventListener("webglcontextlost", lost); el.addEventListener("webglcontextrestored", restored);
    const iv = setInterval(() => {
      const i = gl.info;
      telemetry.sample({ calls: i.render.calls, triangles: i.render.triangles, points: i.render.points, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0 }, get().objects.length + (get().stress ? 50000 - get().objects.length : 0));
    }, 500);
    const flush = setInterval(() => telemetry.flush(), 30000);
    return () => { clearInterval(iv); clearInterval(flush); el.removeEventListener("webglcontextlost", lost); el.removeEventListener("webglcontextrestored", restored); };
  }, [gl]);
  return null;
}

export default function Scene() {
  const lowDetail = typeof window !== "undefined" && (window.innerWidth < 700 || (navigator.hardwareConcurrency ?? 8) <= 4);
  return (
    <Canvas
      className="globe"
      aria-hidden
      dpr={[1, lowDetail ? 1.5 : 2]}
      gl={{ antialias: !lowDetail, powerPreference: "high-performance", preserveDrawingBuffer: true }}
      camera={{ fov: 42, near: 0.05, far: 6000, position: [0, 0, 340] }}
      onCreated={({ gl, scene, camera }) => {
        gl.setClearColor("#03050a");
        const t0 = performance.now();
        gl.compile(scene, camera);
        telemetry.mark("shaderCompileMs", performance.now() - t0);
      }}
    >
      <Telemetry />
      <Stars />
      <Earth lowDetail={lowDetail} />
      <Objects />
      <Trail />
      <CameraRig />
    </Canvas>
  );
}
