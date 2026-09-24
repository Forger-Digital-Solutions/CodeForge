import { add } from "../src/add.mjs";

if (add(2, 3) !== 5 || add(-4, 7) !== 3) {
  throw new Error("add must return the sum of its arguments");
}
