import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchBulkData,
  fetchPlanetoidMetadata,
  Texture_Format,
  unpackObb,
  octantToLatLonBox,
} from "../src/index.js";

test("parseBulkData mirrors earth-3d BulkData structure", async () => {
  const planetoid = await fetchPlanetoidMetadata();
  const bulkEpoch = planetoid.rootNodeMetadata!.epoch;
  const bulk = await fetchBulkData({ path: "", bulkEpoch });

  assert.ok(bulk.bulks.size > 0, "should index child bulks");
  assert.equal(bulk.nodes.size, 120, "effective data nodes must be 120");
  assert.equal(bulk.octants.size, 124, "traversable octants include NODATA placeholders");
  assert.equal(bulk.headNodeKey?.epoch, bulkEpoch);
  assert.equal(bulk.headNodeCenter.length, 3);

  for (const [path, header] of bulk.bulks) {
    assert.equal(path, header.path);
    assert.equal(header.path.length % 4, 0);
    assert.equal(header.isBulk, true);
    assert.ok(header.bulkEpoch !== undefined && header.bulkEpoch > 0, `bulk ${path} needs bulkEpoch`);
    assert.ok(header.epoch > 0, `bulk ${path} needs epoch`);
  }

  for (const path of ["0", "1", "2", "3"]) {
    assert.equal(bulk.nodes.has(path), false, `NODATA octant ${path} is not an effective node`);
    assert.equal(bulk.octants.has(path), true, `NODATA octant ${path} stays in octants for walk`);
  }

  let withImagery = 0;
  for (const [, header] of bulk.nodes) {
    assert.equal(header.canHaveData, true);
    assert.ok(header.obb, "nodes map requires OBB");
    assert.ok(header.latLonBox, "nodes map requires latLonBox");
    if (!header.isBulk) {
      assert.equal(header.bulkEpoch, undefined, `non-bulk ${header.path} must not have bulkEpoch`);
    }
    if (header.path === "036") {
      assert.equal(header.isBulk, false);
      assert.equal(header.bulkEpoch, undefined);
      assert.equal(header.epoch, bulkEpoch);
    }
    if (header.textureFormat !== undefined) {
      assert.ok(
        header.textureFormat === Texture_Format.CRN_DXT1 ||
          header.textureFormat === Texture_Format.JPG,
      );
    }
    if (header.imageryEpoch !== 0) withImagery++;
  }

  console.log(
    `headers=${bulk.nodeMetadata.length} bulks=${bulk.bulks.size} nodes=${bulk.nodes.size} octants=${bulk.octants.size} imageryEpochSet=${withImagery}`,
  );

  // sample absolute path geometry
  const sample = [...bulk.nodes.values()][0]!;
  const box = octantToLatLonBox(sample.path);
  assert.ok(box.n >= box.s);
  assert.ok(box.e >= box.w || sample.path.startsWith("0") || sample.path.startsWith("2"));
});

test("unpackObb rejects wrong size", () => {
  assert.throws(() => unpackObb(new Uint8Array(10), [0, 0, 0], 1));
});
