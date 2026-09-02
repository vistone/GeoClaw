import assert from "node:assert/strict";
import { test } from "node:test";

import {
  encodeBulkMetadataPb,
  hasChildBulk,
  hasNodeData,
  unpackPathAndFlags,
} from "../src/index.js";
import { NodeMetadata_Flags } from "../src/gen/rocktree_pb.js";

test("encodeBulkMetadataPb root", () => {
  assert.equal(encodeBulkMetadataPb("", 1014), "!1m2!1s!2u1014");
  assert.equal(encodeBulkMetadataPb("0123", 42), "!1m2!1s0123!2u42");
});

test("unpackPathAndFlags roundtrip shape", () => {
  // level=1 (bits 0..1 = 0), octant 5, flags LEAF|NODATA
  // path_id layout after encode reverse:
  // flags << (2 + 3*level) | octants | (level-1)
  const level = 1;
  const octant = 5;
  const flags = NodeMetadata_Flags.LEAF | NodeMetadata_Flags.NODATA;
  const packed = (flags << (2 + 3 * level)) | (octant << 2) | (level - 1);
  const u = unpackPathAndFlags(packed);
  assert.equal(u.level, 1);
  assert.equal(u.path, "5");
  assert.equal(u.flags, flags);
  assert.equal(hasNodeData(u.flags), false);
  assert.equal(hasChildBulk(u.path, u.flags), false);
});

test("hasChildBulk requires path length 4 and not LEAF", () => {
  assert.equal(hasChildBulk("0123", 0), true);
  assert.equal(hasChildBulk("0123", NodeMetadata_Flags.LEAF), false);
  assert.equal(hasChildBulk("012", 0), false);
});
