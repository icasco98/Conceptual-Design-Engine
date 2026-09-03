/**
 * The building in three dimensions, from the same boxes the plan edits.
 *
 * Two readings of the same arrangement, chosen with the "Colour by zone"
 * checkbox above:
 *
 *   zones — every live box on every level extruded to the storey height and
 *     coloured by its category, the current level solid and the others
 *     translucent, so the plan you are editing reads inside the whole;
 *   mass  — one grey volume per storey, traced from that storey's own
 *     outline. No rooms, no colour: the shape the building makes on the
 *     site, which is the question massing actually asks.
 *
 * The stair is drawn once, floor to top, rather than once per storey, and
 * every floor plate it passes through is cut around it. Vertical
 * circulation is one continuous volume in a building and has to read as
 * one here, not as boxes stacked on each other.
 *
 * Three.js is vendored through npm and bundled; nothing is fetched at
 * runtime, so the view works with no connection.
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { CategoryKey } from "../api/types";
import { displayShapes } from "../geometry/carve";
import { footprintRings } from "../geometry/footprint";
import { polyOfBox } from "../geometry/poly";
import { shaftsPiercing, stairShafts } from "../geometry/shafts";
import { liveBoxes } from "../geometry/resolve";
import type { Box } from "../geometry/types";
import { fillFor } from "../palette";
import { useStore } from "../state/store";

const SLAB = 0.22;
/** The one grey the massing volume is made of, lit rather than shaded flat. */
const MASS = "#9aa1a6";

export function View3D() {
  const project = useStore((s) => s.project);
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);
  const selected = useStore((s) => s.selected);
  const layoutPlan = useStore((s) => s.layoutPlan);
  const envelope = useStore((s) => s.envelope);
  const massing = useStore((s) => s.massing);

  const mount = useRef<HTMLDivElement>(null);
  const scene = useRef<THREE.Scene>();
  const building = useRef<THREE.Group>();
  const renderer = useRef<THREE.WebGLRenderer>();
  const camera = useRef<THREE.PerspectiveCamera>();
  const controls = useRef<OrbitControls>();

  const categories = useMemo(() => {
    const m = new Map<string, CategoryKey>();
    layoutPlan?.assignments.forEach((a) => m.set(a.room_name, a.category));
    return m;
  }, [layoutPlan]);

  const width = project?.site.width_m ?? 20;
  const depth = project?.site.depth_m ?? 20;
  const storeyH = project?.storey_height_m ?? 3;

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

  // Frame the site whenever it changes size.
  useEffect(() => {
    const cam = camera.current;
    const ctl = controls.current;
    if (!cam || !ctl) return;
    const span = Math.max(width, depth);
    cam.position.set(width / 2 + span * 0.9, span * 0.9, depth / 2 + span * 1.1);
    ctl.target.set(width / 2, storeyH * 0.6, depth / 2);
    ctl.update();
  }, [width, depth, storeyH]);

  // Rebuild the building whenever the boxes change.
  useEffect(() => {
    const group = building.current;
    if (!group || !project) return;
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

    // Site and setback line.
    const site = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshLambertMaterial({ color: "#e7e4da" }),
    );
    site.rotation.x = -Math.PI / 2;
    site.position.set(width / 2, -0.01, depth / 2);
    group.add(site);
    if (envelope) {
      const pts = [
        new THREE.Vector3(envelope.left, 0.01, envelope.top),
        new THREE.Vector3(envelope.right, 0.01, envelope.top),
        new THREE.Vector3(envelope.right, 0.01, envelope.bottom),
        new THREE.Vector3(envelope.left, 0.01, envelope.bottom),
        new THREE.Vector3(envelope.left, 0.01, envelope.top),
      ];
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: "#c9a227", dashSize: 0.4, gapSize: 0.25 })));
    }
    // Street edge.
    if (project.site.edges.some((e) => e.position === "front" && e.adjacency === "street")) {
      const street = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.6), new THREE.MeshBasicMaterial({ color: "#c0392b" }));
      street.rotation.x = -Math.PI / 2;
      street.position.set(width / 2, 0.005, -0.3);
      group.add(street);
    }

    const shafts = stairShafts(boxes, project.storeys);

    for (let lv = 0; lv < project.storeys; lv++) {
      const live = liveBoxes(boxes, lv);
      const shapes = displayShapes(live, null);
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
        if (b.roomType === "stair") continue; // drawn once as a shaft below
        const h = storeyH - SLAB;
        const geo = new THREE.BoxGeometry(b.width, h, b.height);
        const color = fillFor(b.roomType, b.kind, categories.get(b.name) ?? categories.get(b.name.replace(/ \d+$/, "")));
        const mat = new THREE.MeshLambertMaterial({
          color,
          transparent: true,
          opacity: current ? 0.55 : 0.16,
        });
        const mesh = new THREE.Mesh(geo, mat);
        const cx = b.left + b.width / 2;
        const cz = b.top + b.height / 2;
        mesh.position.set(cx, y0 + SLAB + h / 2, cz);
        mesh.rotation.y = (-b.rotation * Math.PI) / 180;
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

    // The shaft, once, from the floor of its lowest storey to the ceiling of
    // its highest. Drawn after the rooms so its edges read through them, and
    // only in zones mode — the massing volume already contains it.
    if (massing === "zones") {
      for (const shaft of shafts) {
        const b = shaft.box;
        const h = (shaft.to - shaft.from + 1) * storeyH - SLAB;
        const geo = new THREE.BoxGeometry(b.width, h, b.height);
        const mat = new THREE.MeshLambertMaterial({
          color: fillFor(b.roomType, b.kind, undefined),
          transparent: true,
          // Slightly firmer than a room: it is one object passing through
          // every storey, so it should not fade out on the ones you are not
          // looking at.
          opacity: 0.62,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(b.left + b.width / 2, shaft.from * storeyH + SLAB + h / 2, b.top + b.height / 2);
        mesh.rotation.y = (-b.rotation * Math.PI) / 180;
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
  }, [boxes, level, project, storeyH, width, depth, envelope, categories, selected, massing]);

  return <div className="view3d" ref={mount} />;
}

export type { Box };
