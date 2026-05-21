import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";

const require = createRequire(import.meta.url);

describe("polyfillUtilIsDate", () => {
  test("restores util.isDate when missing (node-oracledb 5.5 on Node 23+)", async () => {
    const util = require("util") as {
      isDate?: (v: unknown) => boolean;
    };
    const saved = util.isDate;
    try {
      delete util.isDate;
      await import("../src/polyfillUtilIsDate.js");
      assert.equal(typeof util.isDate, "function");
      assert.equal(util.isDate!(new Date()), true);
      assert.equal(util.isDate!("not a date"), false);
    } finally {
      if (saved) util.isDate = saved;
      else delete util.isDate;
    }
  });
});
