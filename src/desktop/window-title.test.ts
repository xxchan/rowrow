import { expect, it } from "vitest";
import { windowTitle } from "./window-title.ts";

it("is the page's title, with the server's name only when there are several servers", () => {
  expect(windowTitle("rowrow", "This Mac", false)).toBe("rowrow");
  expect(windowTitle("rowrow · Work", "This Mac", false)).toBe("rowrow · Work");
  expect(windowTitle("rowrow", "This Mac", true)).toBe("rowrow — This Mac");
  // A title that already names the server doesn't say it twice.
  expect(windowTitle("This Mac", "This Mac", true)).toBe("This Mac");
  expect(windowTitle("", "devbox", false)).toBe("rowrow");
});
