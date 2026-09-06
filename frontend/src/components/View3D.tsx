/**
 * The building in three dimensions, from the same boxes the plan edits.
 *
 * Two readings of the same arrangement, chosen with the "Colour by zone"
 * checkbox above:
 *
 *   zones — every live box on every level extruded to the storey height and
 *     coloured by its zone, the current level solid and the others
 *     translucent, so the plan you are editing reads inside the whole;
 *   mass  — one grey volume per storey, traced from that storey's own
 *     outline. No rooms, no colour: the shape the building makes, which
 *     is the question massing actually asks.
 *
 * A zone that spans several storeys (the stair) is one box in the model
 * and one mass here: drawn once, floor of its lowest storey to ceiling of
 * its highest, with every floor plate it passes through cut around it.
 *
 * The ground is the drawing sheet: there is no site, so nothing else is
 * drawn under the building.
 *
 * Three.js is vendored through npm and bundled; nothing is fetched at
 * runtime, so the view works with no connection.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { displayShapes } from "../geometry/carve";
import { footprintRings } from "../geometry/footprint";
import { polyOfBox } from "../geometry/poly";
import { shaftsPiercing, stairShafts } from "../geometry/shafts";
import { liveBoxes } from "../geometry/snap";
import type { Box } from "../geometry/types";
import { fillFor } from "../palette";
import { SHEET, STOREY_HEIGHT_M } from "../sample";
import { useStore } from "../state/store";

const SLAB = 0.22;
/** The one grey the massing volume is made of, lit rather than shaded flat. */
const MASS = "#9aa1a6";

/** The rectangle the layout occupies, for framing the camera. */
function extentOf(boxes: Box[]): { cx: number; cz: number; span: number } {
  const live = boxes.filter((b) => !b.deleted);
  if (!live.length) return { cx: SHEET.width / 2, cz: SHEET.depth / 2, span: Math.max(SHEET.width, SHEET.depth) };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of live) {
    minX = Math.min(minX, b.left);
    minY = Math.min(minY, b.top);
    maxX = Math.max(maxX, b.left + b.width);
    maxY = Math.max(maxY, b.top + b.height);
  }
  return { cx: (minX + maxX) / 2, cz: (minY + maxY) / 2, span: Math.max(maxX - minX, maxY - minY, 6) };
}

export function View3D() {
  const boxes = useStore((s) => s.boxes);
  const recommended = useStore((s) => s.recommended);
  const storeys = useStore((s) => s.storeys);
  const level = useStore((s) => s.level);
  const selected = useStore((s) => s.selected);
  const massing = useStore((s) => s.massing);

  const mount = useRef<HTMLDivElement>(null);
  const scene = useRef<THREE.Scene>();
  const building = useRef<THREE.Group>();
  const renderer = useRef<THREE.WebGLRenderer>();
  const camera = useRef<THREE.PerspectiveCamera>();
  const controls = useRef<OrbitControls>();
  /** Frames the current layout; kept in a ref so the resize observer,
   * created once, always calls the latest one. */
  const frameRef = useRef<() => void>(() => {});

  const storeyH = STOREY_HEIGHT_M;

  // Scene, camera, renderer: once.
  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const s = new THREE.Scene();
    s.background = new THREE.Color("#f4f3ee");
    const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(r.domElement);
    const ctl = new OrbitControls(cam, r.domElement);
    ctl.enableDamping = true;
    ctl.maxPolarAngle = Math.PI / 2 - 0.02;

    s.add(new THREE.HemisphereLight("#ffffff", "#c8c2b4", 1.1));
    const sun = new THREE.DirectionalLight("#ffffff", 1.4);
    sun.position.set(30, 50, 20);
    s.add(sun);

    const group = new THREE.Group();
    s.add(group);

    scene.current = s;
    building.current = group;
    renderer.current = r;
    camera.current = cam;
    controls.current = ctl;

    let alive = true;
    const resize = () => {
      const w = el.clientWidth || 600;
      const h = el.clientHeight || 480;
      r.setSize(w, h, false);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      frameRef.current();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const loop = () => {
      if (!alive) return;
      ctl.update();
      r.render(s, cam);
      requestAnimationFrame(loop);
    };
    loop();
    return () => {
      alive = false;
      ro.disconnect();
      ctl.dispose();
      r.dispose();
      el.removeChild(r.domElement);
    };
  }, []);

  // Frame the layout when a new one is loaded, or the pane changes shape
  // -- not on every edit, which would snatch the view away from wherever
  // you had orbited it to.
  useEffect(() => {
    frameRef.current = () => {
      const cam = camera.current;
      const ctl = controls.current;
      if (!cam || !ctl) return;
      const { cx, cz, span } = extentOf(recommended);
      // Far enough that the span fits the narrower of the two fields of
      // view: a tall pane has less horizontal field than vertical.
      const vFov = (cam.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * cam.aspect);
      const fit = Math.min(vFov, hFov);
      const dist = (span * 0.75) / Math.tan(fit / 2);
      const dir = new THREE.Vector3(0.75, 0.62, 0.95).normalize();
      const target = new THREE.Vector3(cx, storeyH * 0.6, cz);
      cam.position.copy(target).addScaledVector(dir, dist);
      ctl.target.copy(target);
      ctl.update();
    };
    frameRef.current();
  }, [recommended, storeyH]);

  // Rebuild the building whenever the boxes change.
  useEffect(() => {
    const group = building.current;
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }

    // The sheet, as the ground.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(SHEET.width, SHEET.depth),
      new THREE.MeshLambertMaterial({ color: "#e7e4da" }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(SHEET.width / 2, -0.01, SHEET.depth / 2);
    group.add(ground);

    const shafts = stairShafts(boxes);

    for (let lv = 0; lv < storeys; lv++) {
      const live = liveBoxes(boxes, lv);
      const shapes = displayShapes(live);
      const y0 = lv * storeyH;
      const current = lv === level;

      const rings = footprintRings(shapes.map((s) => s.page));

      if (massing === "mass") {
        // One solid per storey, the storey's own outline taken to full
        // height. Stacked they read as a single volume, because each
        // storey's top face is buried under the next storey's base.
        for (const ring of rings) {
          const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p[0], p[1])));
          const geo = new THREE.ExtrudeGeometry(shape, { depth: storeyH, bevelEnabled: false });
          const solid = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: MASS }));
          solid.rotation.x = Math.PI / 2;
          solid.position.set(0, y0 + storeyH, 0);
          group.add(solid);
          // Only the storey's outline is drawn, so the volume keeps its
          // silhouette without the room joints showing through it.
          const outline = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(
              ring.concat([ring[0]]).map((pt) => new THREE.Vector3(pt[0], y0 + storeyH + 0.005, pt[1])),
            ),
            new THREE.LineBasicMaterial({ color: "#5c6469" }),
          );
          group.add(outline);
        }
        continue;
      }

      // Slab from the level's own outline, with a void where a stair comes
      // up through it — a floor plate with no opening would slice the shaft
      // into the stacked boxes this is meant to stop.
      const voids = shaftsPiercing(shafts, lv);
      for (const ring of rings) {
        const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p[0], p[1])));
        for (const v of voids) {
          shape.holes.push(new THREE.Path(polyOfBox(v.box).map((p) => new THREE.Vector2(p[0], p[1]))));
        }
        const geo = new THREE.ExtrudeGeometry(shape, { depth: SLAB, bevelEnabled: false });
        const slab = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: "#d9d4c7" }));
        slab.rotation.x = Math.PI / 2; // shape y -> world +z; extrude -> world -y
        slab.position.set(0, y0, 0);
        group.add(slab);
      }

      for (const b of live) {
        if (b.levelTo > b.level) continue; // one mass, drawn once below
        // The room's drawn shape -- rectangle minus whatever carves it,
        // rotation already applied -- extruded to the zone's own height,
        // so a carved room reads as carved in three dimensions too.
        const page = shapes.find((s) => s.id === b.id)?.page ?? polyOfBox(b);
        const h = Math.max(0.3, b.heightM - SLAB);
        const shape = new THREE.Shape(page.map((p) => new THREE.Vector2(p[0], p[1])));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const color = fillFor(b.roomType, b.kind);
        const mat = new THREE.MeshLambertMaterial({
          color,
          transparent: true,
          opacity: current ? 0.55 : 0.16,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = Math.PI / 2; // shape y -> world +z; extrude -> world -y
        mesh.position.set(0, y0 + SLAB + h, 0);
        group.add(mesh);
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: selected.includes(b.id) ? "#000000" : "#333333", transparent: true, opacity: current ? 0.9 : 0.25 }),
        );
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        group.add(edges);
      }
    }

    // Each spanning zone once, from the floor of its lowest storey to the
    // ceiling of its highest. Drawn after the rooms so its edges read
    // through them, and only in zones mode — the massing volume already
    // contains it.
    if (massing === "zones") {
      for (const shaft of shafts) {
        const b = shaft.box;
        const h = Math.max(0.3, b.heightM - SLAB);
        const page = displayShapes(liveBoxes(boxes, shaft.from)).find((s) => s.id === b.id)?.page ?? polyOfBox(b);
        const shape = new THREE.Shape(page.map((p) => new THREE.Vector2(p[0], p[1])));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mat = new THREE.MeshLambertMaterial({
          color: fillFor(b.roomType, b.kind),
          transparent: true,
          // Slightly firmer than a room: it is one object passing through
          // every storey, so it should not fade out on the ones you are not
          // looking at.
          opacity: 0.62,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = Math.PI / 2;
        mesh.position.set(0, shaft.from * storeyH + SLAB + h, 0);
        group.add(mesh);
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({
            color: selected.includes(b.id) ? "#000000" : "#333333",
            transparent: true,
            opacity: 0.9,
          }),
        );
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        group.add(edges);
      }
    }
  }, [boxes, storeys, level, storeyH, selected, massing]);

  return <div className="view3d" ref={mount} />;
}

export type { Box };
