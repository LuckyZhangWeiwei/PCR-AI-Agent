import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildInfPath } from "../src/lib/buildInfPath.js";

describe("buildInfPath", () => {
  it("uppercases device and lot, appends slot", () => {
    assert.equal(
      buildInfPath("WA03P02G", "NF12551.1N", 3),
      "/data/INF/WA03P02G/NF12551.1N/r_1-3"
    );
  });

  it("uppercases lowercase inputs", () => {
    assert.equal(
      buildInfPath("wa03p02g", "nf12551.1n", 25),
      "/data/INF/WA03P02G/NF12551.1N/r_1-25"
    );
  });

  it("uses INF_STORAGE_ROOT env override", () => {
    const orig = process.env.INF_STORAGE_ROOT;
    process.env.INF_STORAGE_ROOT = "/mnt/data/inf";
    assert.equal(
      buildInfPath("DEV", "LOT", 1),
      "/mnt/data/inf/DEV/LOT/r_1-1"
    );
    if (orig === undefined) delete process.env.INF_STORAGE_ROOT;
    else process.env.INF_STORAGE_ROOT = orig;
  });

  it("strips trailing slash from INF_STORAGE_ROOT", () => {
    const orig = process.env.INF_STORAGE_ROOT;
    process.env.INF_STORAGE_ROOT = "/data/INF/";
    assert.equal(
      buildInfPath("D", "L", 5),
      "/data/INF/D/L/r_1-5"
    );
    if (orig === undefined) delete process.env.INF_STORAGE_ROOT;
    else process.env.INF_STORAGE_ROOT = orig;
  });
});
