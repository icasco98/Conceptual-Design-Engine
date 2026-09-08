/**
 * The building in three dimensions, from the same zones the plan edits.
 *
 * Every zone is drawn ONCE, from its own floor to its own ceiling. Nothing
 * here works storey by storey, because a zone's height is its own: a 7 m
 * room is one 7 m volume, not a storey's worth of volume repeated on each
 * floor it happens to reach. (It was exactly that, and read as a stack of
 * boxes.) Storeys only decide where a zone starts and where the floor
 * plates go.
 *
 * Two readings of the same arrangement, chosen with the "Colour by zone"
 * checkbox above:
 *
 *   zones — every zone coloured by its category, the storey you are
 *     editing solid and the rest translucent, with floor plates between
 *     them, so the plan you are editing reads inside the whole;
 *   mass  — the same volumes in one grey, no plates and no colour: the
 *     shape the building makes, which is what massing actually asks. The
 *     only lines are each storey's own outline, so the silhouette reads
 *     without every room joint showing through it.
 *
 * A floor plate is cut around any zone that passes through it, so a tall
 * volume stays continuous rather than being sliced into storeys.
 *
 * Click a zone to select it: the schedule and the plan follow, and the
 * plan switches to that zone's floor if it is not the one on screen.
 * Shift-click adds to the selection. A click on nothing clears it.
 *
 * With "Move zones" ticked above, dragging a zone moves it in plan, on
 * the ground plane through the point you grabbed, snapping to the same
 * grid the plan uses and taking the whole selection with it; the orbit
 * control is switched off only while a zone is under the pointer.
 * Unticked, every drag orbits and the view is safe to turn.
 * Nothing here changes a zone's height or its storey -- a drag in a view
 * you can orbit has no unambiguous up, and the schedule has a height
 * field for that.
 *
 * Three.js is vendored through npm and bundled; nothing is fetched at
 * runtime, so the view works with no connection.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { displayShapes, type DisplayShape } from "../geometry/carve";
import { footprintRings } from "../geometry/footprint";
import { clampGroup, plotBottom, plotRight } from "../geometry/plot";
import { polyOfBox } from "../geometry/poly";
import { liveBoxes, snapToGrid } from "../geometry/snap";
import type { Box, Poly } from "../geometry/types";
import { fillFor } from "../palette";
import { SHEET, STOREY_HEIGHT_M } from "../sample";
import { useStore } from "../state/store";

const SLAB = 0.22;
/** The plot kerb: thin and ankle-high. Enough to read as a boundary from
 *  any angle, low enough never to hide a room behind it. */
const KERB = 0.18;
const KERB_H = 0.35;
/** The one grey the massing volume is made of, lit rather than shaded flat. */
const MASS = "#9aa1a6";
/** A drag longer than this many pixels is an orbit, not a click. */
const CLICK_SLOP_PX = 4;

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

/** A polygon extruded between two heights. The shape is in plan-frame x/y,
 * so it is laid down flat and the extrusion runs up the world's y. */
function prism(poly: Poly, base: number, height: number, holes: Poly[] = []): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  // shape y -> world +z, extrude -> world -y, so turn it down and lift it
  // to put the extrusion's far face at `base`.
  geo.rotateX(Math.PI / 2);
  geo.translate(0, base + height, 0);
  return geo;
}

export function View3D() {
  const boxes = useStore((s) => s.boxes);
  const recommended = useStore((s) => s.recommended);
  const storeys = useStore((s) => s.storeys);
  const level = useStore((s) => s.level);
  const selected = useStore((s) => s.selected);
  const massing = useStore((s) => s.massing);
  const autoCarve = useStore((s) => s.autoCarve);
  const plot = useStore((s) => s.plot);

  const mount = useRef<HTMLDivElement>(null);
  const building = useRef<THREE.Group>();
  const renderer = useRef<THREE.WebGLRenderer>();
  const camera = useRef<THREE.PerspectiveCamera>();
  const controls = useRef<OrbitControls>();
  /** Frames the current layout; kept in a ref so the resize observer,
   * created once, always calls the latest one. */
  const frameRef = useRef<() => void>(() => {});

  const storeyH = STOREY_HEIGHT_M;

  // Scene, camera, renderer, and picking: once.
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

    building.current = group;
    renderer.current = r;
    camera.current = cam;
    controls.current = ctl;

    // ---- pointer: a zone under the cursor is grabbed and moved, anything
    // else orbits. A grab that never travels is a click, and selects.
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane();
    const onPlane = new THREE.Vector3();
    let down: { x: number; y: number; id: string | null } | null = null;
    let drag: { ids: string[]; snapshot: Box[]; x0: number; z0: number; moved: boolean } | null = null;
    let queued: PointerEvent | null = null;
    let frame = 0;

    const ndc = (e: PointerEvent) => {
      const rect = r.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    /** The nearest zone under the pointer, and where on it. */
    const pick = (e: PointerEvent): { id: string; point: THREE.Vector3 } | null => {
      ray.setFromCamera(ndc(e), cam);
      for (const hit of ray.intersectObjects(group.children, false)) {
        const id = hit.object.userData.boxId as string | undefined;
        if (id) return { id, point: hit.point }; // else: the ground, a plate, an outline
      }
      return null;
    };

    const onDown = (e: PointerEvent) => {
      const hit = pick(e);
      down = { x: e.clientX, y: e.clientY, id: hit?.id ?? null };
      // Shift is for adding to the selection, so it never starts a move;
      // nor does anything, unless moving in 3D has been turned on.
      const store = useStore.getState();
      if (!hit || e.shiftKey || !store.moveIn3D) return;
      const ids = store.selected.includes(hit.id) ? [hit.id, ...store.selected.filter((s) => s !== hit.id)] : [hit.id];
      plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), hit.point);
      drag = { ids, snapshot: store.boxes, x0: hit.point.x, z0: hit.point.z, moved: false };
      ctl.enabled = false;
    };

    const applyDrag = () => {
      frame = 0;
      const e = queued;
      queued = null;
      if (!e || !drag) return;
      ray.setFromCamera(ndc(e), cam);
      if (!ray.ray.intersectPlane(plane, onPlane)) return;
      // World x is the plan's x and world z is the plan's y: the prism
      // helper lays each shape down that way.
      let dx = onPlane.x - drag.x0;
      let dy = onPlane.z - drag.z0;
      const ids = new Set(drag.ids);
      const lead = drag.snapshot.find((b) => b.id === drag!.ids[0])!;
      if (!lead.rotation) {
        dx = snapToGrid(lead.left + dx) - lead.left;
        dy = snapToGrid(lead.top + dy) - lead.top;
      }
      // The plot binds here exactly as it does on the plan: a zone pushed
      // across the site line in 3D stops against the kerb.
      useStore.getState().setBoxes(
        clampGroup(
          drag.snapshot.map((b) => (ids.has(b.id) ? { ...b, left: b.left + dx, top: b.top + dy } : b)),
          ids,
          useStore.getState().plot,
        ),
      );
    };

    const onMove = (e: PointerEvent) => {
      if (!drag || !down) return;
      if (!drag.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= CLICK_SLOP_PX) return;
      if (!drag.moved) useStore.getState().remember();
      drag.moved = true;
      queued = e;
      if (!frame) frame = requestAnimationFrame(applyDrag);
    };

    const onUp = (e: PointerEvent) => {
      const start = down;
      const gesture = drag;
      down = null;
      drag = null;
      ctl.enabled = true;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
        applyDrag();
      }
      if (gesture?.moved) {
        const store = useStore.getState();
        store.commitBoxes(store.boxes);
        return;
      }
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return; // orbited
      const store = useStore.getState();
      const box = start.id ? store.boxes.find((b) => b.id === start.id) : undefined;
      if (!box) {
        store.select(null);
        return;
      }
      // Show the floor the zone starts on, so what you picked is on the
      // plan and in the schedule beside it.
      if (box.level > store.level || store.level > box.levelTo) store.setLevel(box.level);
      store.select(box.id, e.shiftKey);
    };

    r.domElement.addEventListener("pointerdown", onDown);
    r.domElement.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);

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
      if (frame) cancelAnimationFrame(frame);
      r.domElement.removeEventListener("pointerdown", onDown);
      r.domElement.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
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

  // Rebuild whenever the zones change.
  useEffect(() => {
    const group = building.current;
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    }

    // The ground: the sheet, stretched to hold the plot if the plot is
    // the larger of the two, so a site is never drawn off the edge of it.
    const gw = Math.max(SHEET.width, plotRight(plot));
    const gd = Math.max(SHEET.depth, plotBottom(plot));
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(gw, gd),
      new THREE.MeshLambertMaterial({ color: "#e7e4da" }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(gw / 2, -0.01, gd / 2);
    group.add(ground);

    // The plot: a paler slab over the ground, and while it binds a low
    // kerb around it, so the boundary reads as an edge in three
    // dimensions rather than as a line someone drew on the plan.
    const site = new THREE.Mesh(
      new THREE.PlaneGeometry(plot.width, plot.depth),
      new THREE.MeshLambertMaterial({ color: plot.on ? "#f2efe6" : "#ebe8de" }),
    );
    site.rotation.x = -Math.PI / 2;
    site.position.set(plot.left + plot.width / 2, 0, plot.top + plot.depth / 2);
    group.add(site);
    if (plot.on) {
      const kerbMat = new THREE.MeshLambertMaterial({ color: "#6f7a72" });
      const walls: [number, number, number, number][] = [
        [plot.width + KERB, KERB, plot.left + plot.width / 2, plot.top],
        [plot.width + KERB, KERB, plot.left + plot.width / 2, plotBottom(plot)],
        [KERB, plot.depth + KERB, plot.left, plot.top + plot.depth / 2],
        [KERB, plot.depth + KERB, plotRight(plot), plot.top + plot.depth / 2],
      ];
      for (const [w, d, cx, cz] of walls) {
        const kerb = new THREE.Mesh(new THREE.BoxGeometry(w, KERB_H, d), kerbMat);
        kerb.position.set(cx, KERB_H / 2, cz);
        group.add(kerb);
      }
    }

    // Each storey's drawn shapes, computed once: the carve on a storey
    // depends on what else is on that storey.
    const perLevel = new Map<number, DisplayShape[]>();
    for (let lv = 0; lv < storeys; lv++) perLevel.set(lv, displayShapes(liveBoxes(boxes, lv), autoCarve));
    /** A zone's outline, taken from the storey it stands on. */
    const pageOf = (b: Box): Poly => perLevel.get(b.level)?.find((s) => s.id === b.id)?.page ?? polyOfBox(b);

    // Not deleted, and actually on the plan -- a zone waiting in the
    // schedule's "To place" list (placed === false) has no position and
    // is invisible everywhere geometry is drawn, same as liveBoxes.
    const live = boxes.filter((b) => !b.deleted && b.placed !== false);

    // ---- the volumes: one per zone, floor to ceiling, whatever its height
    for (const b of live) {
      const base = b.level * storeyH + SLAB;
      const height = Math.max(0.3, b.heightM - SLAB);
      const geo = prism(pageOf(b), base, height);
      // A zone reaching the storey on screen is drawn solid; the rest are
      // faint, so the floor you are editing stands out inside the whole.
      const onScreen = b.level <= level && level <= b.levelTo;
      const isSel = selected.includes(b.id);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshLambertMaterial({
          color: massing === "mass" ? MASS : fillFor(b.roomType, b.kind),
          transparent: massing === "zones",
          opacity: massing === "mass" ? 1 : onScreen ? (isSel ? 0.72 : 0.55) : 0.16,
        }),
      );
      mesh.userData.boxId = b.id;
      group.add(mesh);
      if (massing === "zones") {
        group.add(
          new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            new THREE.LineBasicMaterial({
              color: isSel ? "#0b0b0b" : "#333333",
              transparent: true,
              opacity: isSel ? 1 : onScreen ? 0.9 : 0.25,
            }),
          ),
        );
      }
    }

    // ---- the storeys: floor plates in zones mode, outlines in mass mode
    for (let lv = 0; lv < storeys; lv++) {
      const onThis = liveBoxes(boxes, lv);
      if (!onThis.length) continue;
      const rings = footprintRings((perLevel.get(lv) ?? []).map((s) => s.page));
      const y0 = lv * storeyH;

      if (massing === "mass") {
        // The silhouette, storey by storey, and nothing else: no plates
        // and no room joints to break the volume up.
        for (const ring of rings) {
          group.add(
            new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(
                ring.concat([ring[0]]).map((pt) => new THREE.Vector3(pt[0], y0 + 0.01, pt[1])),
              ),
              new THREE.LineBasicMaterial({ color: "#5c6469" }),
            ),
          );
        }
        continue;
      }

      // A plate is cut around every zone that passes through it -- a plate
      // with no opening would slice a tall volume into stacked boxes.
      const holes = onThis.filter((b) => b.level < lv).map(pageOf);
      for (const ring of rings) {
        group.add(
          new THREE.Mesh(prism(ring, y0, SLAB, holes), new THREE.MeshLambertMaterial({ color: "#d9d4c7" })),
        );
      }
    }
  }, [boxes, storeys, level, storeyH, selected, massing, autoCarve, plot]);

  return <div className="view3d" ref={mount} />;
}

export type { Box };
