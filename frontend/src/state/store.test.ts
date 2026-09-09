/**
 * The store's own actions, called directly against `useStore.getState()`
 * -- no rendering, no pointer events, just: does the action do what its
 * name says. Complements geometry/geometry.test.ts (the pure functions
 * underneath) and the plan's Playwright suite (the gestures on top);
 * this tier is for the state changes in between.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PLOT } from "../sample";
import type { SavedProject } from "../api/types";
import { migrateLayout, useStore } from "./store";

beforeEach(() => {
  useStore.getState().newProject();
});

describe("actors sit outside the drawing's own undo history, on purpose", () => {
  it("undo does not remove an actor added a moment before", () => {
    const id = useStore.getState().addActor("Guest", "guest");
    useStore.getState().undo();
    expect(useStore.getState().actors.map((a) => a.id)).toContain(id);
  });

  it("moving a box IS undoable -- the two histories really are different", () => {
    const before = useStore.getState().boxes[0];
    useStore.getState().updateBox(before.id, { left: before.left + 5 });
    expect(useStore.getState().boxes.find((b) => b.id === before.id)?.left).toBe(before.left + 5);
    useStore.getState().undo();
    expect(useStore.getState().boxes.find((b) => b.id === before.id)?.left).toBe(before.left);
  });
});

describe("actor CRUD", () => {
  it("addActor gives each one a different colour, from a fixed rotation, and an empty route", () => {
    const id1 = useStore.getState().addActor("Owner", "served");
    const id2 = useStore.getState().addActor("Guest", "guest");
    const [a1, a2] = useStore.getState().actors;
    expect(a1.id).toBe(id1);
    expect(a2.id).toBe(id2);
    expect(a1.color).not.toBe(a2.color);
    expect(a1.waypoints).toEqual([]);
    expect(a1.visible).toBe(true);
  });

  it("addWaypoint appends in order, removeWaypoint takes out just the one, clearWaypoints empties it", () => {
    const id = useStore.getState().addActor("Owner", "served");
    const [roomA, roomB, roomC] = useStore.getState().boxes;
    useStore.getState().addWaypoint(id, roomA.id);
    useStore.getState().addWaypoint(id, roomB.id);
    useStore.getState().addWaypoint(id, roomC.id);
    expect(useStore.getState().actors[0].waypoints).toEqual([roomA.id, roomB.id, roomC.id]);
    useStore.getState().removeWaypoint(id, 1);
    expect(useStore.getState().actors[0].waypoints).toEqual([roomA.id, roomC.id]);
    useStore.getState().clearWaypoints(id);
    expect(useStore.getState().actors[0].waypoints).toEqual([]);
  });

  it("toggleActorVisible flips just the one actor", () => {
    const id1 = useStore.getState().addActor("Owner", "served");
    const id2 = useStore.getState().addActor("Guest", "guest");
    useStore.getState().toggleActorVisible(id1);
    const actors = useStore.getState().actors;
    expect(actors.find((a) => a.id === id1)?.visible).toBe(false);
    expect(actors.find((a) => a.id === id2)?.visible).toBe(true);
  });

  it("deleteActor removes it, and clears routing if it was the one being recorded", () => {
    const id = useStore.getState().addActor("Owner", "served");
    useStore.getState().setRoutingActor(id);
    expect(useStore.getState().routingActorId).toBe(id);
    useStore.getState().deleteActor(id);
    expect(useStore.getState().actors).toHaveLength(0);
    expect(useStore.getState().routingActorId).toBeNull();
  });

  it("setRoutingActor turns circulation on -- there is nothing to see it recording otherwise", () => {
    // showCirculation is a view preference, not part of the drawing, so
    // newProject() leaves it exactly as another test left it (the same
    // reason it survives a real "New" from the rail) -- pin it off first
    // so this test does not depend on running order.
    useStore.setState({ showCirculation: false });
    const id = useStore.getState().addActor("Owner", "served");
    useStore.getState().setRoutingActor(id);
    expect(useStore.getState().showCirculation).toBe(true);
  });
});

describe("deleting a zone cleans up after itself", () => {
  it("takes the zone's own arrows with it", () => {
    const hostedArrow = useStore.getState().arrows[0];
    expect(hostedArrow).toBeTruthy();
    useStore.getState().deleteBoxes([hostedArrow.hostId]);
    expect(useStore.getState().arrows.some((a) => a.hostId === hostedArrow.hostId)).toBe(false);
  });

  it("drops the zone from any actor's route, without breaking the rest of it", () => {
    const [roomA, roomB] = useStore.getState().boxes;
    const id = useStore.getState().addActor("Owner", "served");
    useStore.getState().addWaypoint(id, roomA.id);
    useStore.getState().addWaypoint(id, roomB.id);
    useStore.getState().deleteBoxes([roomA.id]);
    expect(useStore.getState().actors[0].waypoints).toEqual([roomB.id]);
  });
});

describe("migrateLayout: one place a saved layout, however old, gets read", () => {
  it("defaults every field a layout saved before it existed does not carry", () => {
    const bareBox = { ...useStore.getState().boxes[0] } as Record<string, unknown>;
    delete bareBox.shape;
    delete bareBox.carvedBy;
    delete bareBox.priority;
    delete bareBox.placed;
    const saved = {
      id: "p1",
      name: "old",
      created_at: "",
      updated_at: "",
      boxes: [bareBox],
      arrows: undefined,
      storeys: 1,
      plot: undefined,
      actors: undefined,
    } as unknown as SavedProject;

    const migrated = migrateLayout(saved);
    expect(migrated.arrows).toEqual([]);
    expect(migrated.actors).toEqual([]);
    expect(migrated.plot).toEqual(DEFAULT_PLOT);
    expect(migrated.boxes[0].shape).toBe("rect");
    expect(migrated.boxes[0].carvedBy).toEqual([]);
    expect(migrated.boxes[0].placed).toBe(true);
  });

  it("passes a current layout through with nothing to default", () => {
    const state = useStore.getState();
    const saved = {
      id: "p2",
      name: "current",
      created_at: "",
      updated_at: "",
      boxes: state.boxes,
      arrows: state.arrows,
      storeys: state.storeys,
      plot: state.plot,
      actors: state.actors,
    } as SavedProject;
    const migrated = migrateLayout(saved);
    expect(migrated.boxes).toHaveLength(state.boxes.length);
    expect(migrated.arrows).toEqual(state.arrows);
    expect(migrated.plot).toEqual(state.plot);
  });
});
