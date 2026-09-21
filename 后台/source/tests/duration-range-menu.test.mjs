import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("duration slider stays fixed and cannot drag its canvas node", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("app/components/duration-range-menu.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(component, /createPortal\(/);
  assert.match(component, /panelRef\.current\?\.contains\(target\)/);
  assert.match(component, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(component, /onPointerMove=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(component, /onPointerUp=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(styles, /\.duration-range-panel\s*\{[\s\S]*?position:\s*fixed;/);
});
