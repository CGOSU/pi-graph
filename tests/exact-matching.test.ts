import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers.js";

test("identifier lookup does not depend on searchable word tokens", async () => {
  const f = await fixture({
    "names.ts": `
      export const x = 1, to = 1, $ = 1, _ = 1, $a = 1, _a = 1;
      export class X { y() {} }
      export function readHTTPResponse() {}
      export function read_http_response() {}
    `,
  });
  try {
    const queries = [
      ["x", "x"],
      ["to", "to"],
      ["$", "$"],
      ["_", "_"],
      ["$a", "$a"],
      ["_a", "_a"],
      ["X.y", "X.y"],
      ["readhttpresponse", "readHTTPResponse"],
      ["READHTTPRESPONSE", "readHTTPResponse"],
      ["READ_HTTP_RESPONSE", "read_http_response"],
    ] as const;
    for (const [query, expected] of queries) {
      const { results } = await f.engine.locate({ query });
      assert.equal(results[0]?.name, expected, query);
    }
  } finally {
    await f.cleanup();
  }
});

test("an exact qualified method does not require lexical confidence", async () => {
  const body = Array.from({ length: 100 }, (_, i) => `noise${i}`).join(" ");
  const f = await fixture({
    "names.ts": `
      export class Remote { x() { console.log("${body}"); } }
      export class Other { x() {} }
    `,
  });
  try {
    const { results } = await f.engine.locate({ query: "Remote.x" });
    assert.equal(results[0]?.name, "Remote.x");
    const { results: duplicates } = await f.engine.locate({ query: "x" });
    assert.deepEqual(
      duplicates.map(({ name }) => name),
      ["Other.x", "Remote.x"],
    );
  } finally {
    await f.cleanup();
  }
});

test("exact names preserve original case and combining marks", async () => {
  const accented = "Cafe\u0301";
  const f = await fixture({
    "aa.ts": "export class parser { load() {} }",
    "zz.ts": "export class Parser { load() {} }",
    "unicode.ts": `export function Cafe() {} export function ${accented}() {}`,
  });
  try {
    const { results: methods } = await f.engine.locate({ query: "Parser.load" });
    assert.equal(methods[0]?.name, "Parser.load");
    const { results: functions } = await f.engine.locate({ query: accented });
    assert.equal(functions[0]?.name, accented);
  } finally {
    await f.cleanup();
  }
});
