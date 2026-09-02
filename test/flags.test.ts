import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeNodeFlags } from "../src/index.js";

test("flags 18 vs 19 differ by RICH3D_LEAF", () => {
  const f18 = decodeNodeFlags(18);
  const f19 = decodeNodeFlags(19);

  assert.deepEqual(f18.names, ["RICH3D_NODATA", "USE_IMAGERY_EPOCH"]);
  assert.deepEqual(f19.names, ["RICH3D_LEAF", "RICH3D_NODATA", "USE_IMAGERY_EPOCH"]);

  assert.equal(f18.rich3dLeaf, false);
  assert.equal(f19.rich3dLeaf, true);
  assert.equal(f18.useImageryEpoch, true);
  assert.equal(f19.useImageryEpoch, true);
  assert.equal(f18.rich3dNodata, true);
  assert.equal(f19.rich3dNodata, true);
});

test("flags 10 = NODATA placeholder octant (0/1/2/3)", () => {
  const f = decodeNodeFlags(10);
  assert.deepEqual(f.names, ["RICH3D_NODATA", "NODATA"]);
  assert.equal(f.nodata, true);
});
