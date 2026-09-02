import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchPlanetoidMetadata } from "../src/index.js";

test("fetchPlanetoidMetadata from kh.google.com", async () => {
  const meta = await fetchPlanetoidMetadata();
  assert.ok(meta.radius > 6_000_000 && meta.radius < 7_000_000);
  assert.ok(meta.rootNodeMetadata);
  assert.ok((meta.rootNodeMetadata?.epoch ?? 0) > 0);
  console.log(
    `radius=${meta.radius} epoch=${meta.rootNodeMetadata?.epoch} bulkEpoch=${meta.rootNodeMetadata?.bulkMetadataEpoch}`,
  );
});
