import assert from "node:assert/strict";
import { add } from "./workspace/src/add.mjs";

const cases = [
  [0, 0, 0],
  [19, 23, 42],
  [-19, 23, 4],
  [19, -23, -4],
  [-19, -23, -42],
  [0.5, 0.25, 0.75],
];

for (const [a, b, expected] of cases) assert.equal(add(a, b), expected);
console.log(JSON.stringify({ hiddenVerifier: "PASS", cases: cases.length }));
