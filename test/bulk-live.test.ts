import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchBulkMetadata,
  fetchPlanetoidMetadata,
  unpackPathAndFlags,
  hasChildBulk,
  hasNodeData,
} from "../src/index.js";

test("fetchBulkMetadata root from kh.google.com", async () => {
  const planetoid = await fetchPlanetoidMetadata();
  const bulkEpoch = planetoid.rootNodeMetadata!.epoch;
  const bulk = await fetchBulkMetadata({ path: "", bulkEpoch });

  assert.ok(bulk.nodeMetadata.length > 0);
  assert.equal(bulk.headNodeKey?.epoch, bulkEpoch);
  assert.equal(bulk.headNodeCenter.length, 3);

  let childBulks = 0;
  let dataNodes = 0;
  for (const nm of bulk.nodeMetadata) {
    const { path, flags } = unpackPathAndFlags(nm.pathAndFlags);
    if (hasChildBulk(path, flags)) childBulks++;
    if (hasNodeData(flags)) dataNodes++;
  }

  assert.ok(childBulks > 0, "root bulk should list child bulks");
  console.log(
    `rawNodes=${bulk.nodeMetadata.length} childBulks=${childBulks} dataNodes=${dataNodes}`,
  );
});
