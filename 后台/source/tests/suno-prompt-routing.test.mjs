import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../app/lib/kernel-executors.ts", import.meta.url),
  "utf8",
);

test("Suno receives connected upstream text as clean lyrics", () => {
  assert.match(
    source,
    /function sunoLyricsPrompt\([\s\S]*?modelResponseText\(input\.output\)[\s\S]*?upstreamLyrics\.join\("\\n\\n"\)/,
  );
  assert.match(
    source,
    /runningHubSunoBody\([\s\S]*?sunoLyricsPrompt\(node, inputs\)/,
  );
});

test("Suno falls back to lyrics entered directly in the music node", () => {
  assert.match(
    source,
    /function sunoLyricsPrompt\([\s\S]*?return node\.prompt\.trim\(\)/,
  );
});
