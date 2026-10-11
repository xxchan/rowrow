import { describe, expect, it } from "vitest";
import { clampWidth, draggedWidth, KEY_STEP, keyedWidth, parseWidth } from "./pane-size.ts";

describe("pane widths", () => {
  it("reads a stored width, or the default for nothing or junk", () => {
    expect(parseWidth("640", 520)).toBe(640);
    for (const junk of [null, "", "0", "-40", "12.5", "wide", " 640", "1e3", "99999999999999999999"])
      expect(parseWidth(junk, 520)).toBe(520);
  });

  it("holds a width between the minimum and the room left, the room left winning", () => {
    expect(clampWidth(500, 320, 800)).toBe(500);
    expect(clampWidth(100, 320, 800)).toBe(320);
    expect(clampWidth(900, 320, 800)).toBe(800);
    expect(clampWidth(500.4, 320, 800)).toBe(500);
    // No room for both sides: the other side keeps its own, and the pane gets what's left.
    expect(clampWidth(500, 320, 200)).toBe(200);
    expect(clampWidth(500, 320, -40)).toBe(0);
  });

  it("follows a drag: toward a pane on the right widens it, on the left narrows it", () => {
    expect(draggedWidth(520, 700, 600, "right", 320, 900)).toBe(620);
    expect(draggedWidth(520, 700, 800, "right", 320, 900)).toBe(420);
    expect(draggedWidth(260, 400, 460, "left", 180, 500)).toBe(320);
    expect(draggedWidth(260, 400, 100, "left", 180, 500)).toBe(180);
    expect(draggedWidth(520, 700, 0, "right", 320, 900)).toBe(900);
  });

  it("moves the divider with the arrow keys; Home and End go to the narrowest and the widest", () => {
    expect(keyedWidth("ArrowLeft", 520, "right", 320, 900)).toBe(520 + KEY_STEP);
    expect(keyedWidth("ArrowRight", 520, "right", 320, 900)).toBe(520 - KEY_STEP);
    expect(keyedWidth("ArrowLeft", 260, "left", 180, 500)).toBe(260 - KEY_STEP);
    expect(keyedWidth("ArrowRight", 260, "left", 180, 500)).toBe(260 + KEY_STEP);
    expect(keyedWidth("ArrowRight", 330, "right", 320, 900)).toBe(320);
    expect(keyedWidth("Home", 520, "right", 320, 900)).toBe(320);
    expect(keyedWidth("End", 520, "right", 320, 900)).toBe(900);
    expect(keyedWidth("Home", 520, "right", 320, 200)).toBe(200);
    expect(keyedWidth("ArrowUp", 520, "right", 320, 900)).toBeNull();
    expect(keyedWidth("Enter", 520, "right", 320, 900)).toBeNull();
  });
});
