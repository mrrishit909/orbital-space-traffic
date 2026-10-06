"use client";
// Encounter frame: centred on the primary at closest approach, axes = the encounter plane (x along the miss, y across it) and the
// relative velocity (z). 1 unit = 100 m. The secondary's straight relative path, the combined covariance (1 and 3 sigma in the
// plane, 1-sigma ellipsoid in 3D) and the hard-body circle are drawn at true scale; only marker sizes are enlarged, and say so.
import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { encounterPlane, mat, type Conjunction } from "@orbital/domain";
import { useApp, get } from "../store.ts";
import { PLAYBACK } from "../journey.ts";
import { encounterClock, stepEncounter } from "./encounterClock.ts";

const U = 100; // metres per scene unit

function eig2(c: [[number, number], [number, number]]) {
  const [[a, b], [, d]] = c, tr = a + d, det = a * d - b * b, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc, ang = Math.atan2(l1 - a, b || 1e-12);
  return { s1: Math.sqrt(l1), s2: Math.sqrt(Math.max(0, l2)), ang: b === 0 ? (a >= d ? 0 : Math.PI / 2) : ang };
}

/** Jacobi eigen-decomposition of a symmetric 3x3 (for the covariance ellipsoid). */
function eig3(A: number[][]) {
  const a = A.map((r) => [...r]), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: V };
}

export function geometry(c: Conjunction) {
  const plane = encounterPlane(c.rPrimary, c.vPrimary, c.rSecondary, c.vSecondary, c.covKm2);
  const [x, y, z] = plane.basis;
  const B = [x, y, z];
  // covariance in the local (x, y, z) basis, m^2
  const C = mat.mul(mat.mul(B as never, c.covKm2), mat.t(B as never)).map((r) => r.map((v) => v * 1e6));
  return { plane, C, missM: plane.missKm * 1000, e2: eig2(plane.cov.map((r) => r.map((v) => v * 1e6)) as never), e3: eig3(C) };
}

function ellipse(s1: number, s2: number, ang: number, k: number, cx: number) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 96; i++) {
    const t = (i / 96) * Math.PI * 2, ex = k * s1 * Math.cos(t), ey = k * s2 * Math.sin(t);
    pts.push(new THREE.Vector3((cx + ex * Math.cos(ang) - ey * Math.sin(ang)) / U, (ex * Math.sin(ang) + ey * Math.cos(ang)) / U, 0));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function Frame({ c, options, chosen }: { c: Conjunction; options: { planeXYm: [number, number] }[]; chosen: 0 | 1 | null }) {
  const g = useMemo(() => geometry(c), [c]);
  const sec = useRef<THREE.Mesh>(null);
  const reduced = useApp((s) => s.reduced);
  const span = (c.relSpeedMs * PLAYBACK.toS) / U; // half-length of the drawn pass, units
  const path = useMemo(() => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(g.missM / U, 0, -span), new THREE.Vector3(g.missM / U, 0, span)]), [g, span]);
  const e1 = useMemo(() => ellipse(g.e2.s1, g.e2.s2, g.e2.ang, 1, g.missM), [g]);
  const e3s = useMemo(() => ellipse(g.e2.s1, g.e2.s2, g.e2.ang, 3, g.missM), [g]);
  const hb = useMemo(() => ellipse(c.hbrM, c.hbrM, 0, 1, 0), [c]);
  const ell = useMemo(() => {
    const m = new THREE.Matrix4();
    const v = g.e3.vectors, s = g.e3.values.map((x) => Math.sqrt(Math.max(0, x)) / U);
    m.set(v[0][0] * s[0], v[0][1] * s[1], v[0][2] * s[2], g.missM / U, v[1][0] * s[0], v[1][1] * s[1], v[1][2] * s[2], 0, v[2][0] * s[0], v[2][1] * s[1], v[2][2] * s[2], 0, 0, 0, 0, 1);
    return m;
  }, [g]);
  const optionPaths = useMemo(() => options.map((o) => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(o.planeXYm[0] / U, o.planeXYm[1] / U, -span), new THREE.Vector3(o.planeXYm[0] / U, o.planeXYm[1] / U, span)])), [options, span]);
  // <line> clashes with the SVG element in JSX typings, so lines are built as objects
  const pathLine = useMemo(() => new THREE.Line(path, new THREE.LineBasicMaterial({ color: "#ff7a59" })), [path]);
  const optionLines = useMemo(() => optionPaths.map((p, k) => new THREE.Line(p, new THREE.LineBasicMaterial({ color: k === 0 ? "#7fb2ff" : "#c792ff", transparent: true }))), [optionPaths]);
  optionLines.forEach((l, k) => { (l.material as THREE.LineBasicMaterial).opacity = chosen === null || chosen === k ? 1 : 0.3; });
  useFrame((st, dt) => {
    stepEncounter(dt * 1000, reduced);
    const tRel = reduced ? 0 : encounterClock.t;
    if (sec.current) sec.current.position.set(g.missM / U, 0, (tRel * c.relSpeedMs) / U);
    const R = Math.max(12, Math.min(45, ((3 * g.e2.s1) / U) * 1.6));
    st.camera.position.set(R * 0.9, R * 0.55, R * 0.8);
    st.camera.lookAt(g.missM / U / 2, 0, 0);
  });
  return (
    <>
      <ambientLight intensity={0.8} />
      <mesh><sphereGeometry args={[0.35, 24, 16]} /><meshBasicMaterial color="#5ef2c2" /></mesh>
      <lineLoop geometry={hb}><lineBasicMaterial color="#ffffff" /></lineLoop>
      <primitive object={pathLine} />
      <mesh ref={sec}><sphereGeometry args={[0.35, 24, 16]} /><meshBasicMaterial color="#ff7a59" /></mesh>
      <lineLoop geometry={e1}><lineBasicMaterial color="#ffd36e" /></lineLoop>
      <lineLoop geometry={e3s}><lineBasicMaterial color="#ffd36e" transparent opacity={0.45} /></lineLoop>
      <mesh matrixAutoUpdate={false} matrix={ell}><sphereGeometry args={[1, 32, 16]} /><meshBasicMaterial color="#ffd36e" transparent opacity={0.08} depthWrite={false} /></mesh>
      {optionLines.map((l, k) => <primitive key={k} object={l} />)}
      <gridHelper args={[60, 30, "#223", "#151a24"]} rotation={[Math.PI / 2, 0, 0]} />
    </>
  );
}

export default function Encounter() {
  const c = useApp((s) => s.conjunctions.find((x) => x.id === s.conjunctionId) ?? null);
  const plan = useApp((s) => s.plan);
  if (!c) return null;
  const options = plan.options ?? [];
  return (
    <Canvas className="encounter-canvas" aria-hidden camera={{ fov: 40, near: 0.05, far: 2000 }} gl={{ preserveDrawingBuffer: true }} onCreated={({ gl }) => gl.setClearColor("#05070c")}>
      <Frame c={c} options={get().view === "plan" ? options : []} chosen={plan.chosen} />
    </Canvas>
  );
}
