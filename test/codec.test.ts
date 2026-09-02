import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Dataset,
  decodeBulkMetadata,
  decodeNodeData,
  encodeBulkMetadata,
  encodeNodeData,
  gunzipIfNeeded,
  gzipBytes,
  NodeMetadata_Flags,
  Texture_Format,
  bulkMetadata,
  nodeData,
} from "../src/index.js";

test("BulkMetadata roundtrip", () => {
  const original = bulkMetadata.create({
    headNodeKey: { path: "0", epoch: 123 },
    headNodeCenter: [1, 2, 3],
    metersPerTexel: [16, 8, 4],
    defaultImageryEpoch: 9,
    nodeMetadata: [
      {
        pathAndFlags: NodeMetadata_Flags.LEAF | (5 << 5),
        epoch: 123,
        metersPerTexel: 4.5,
        availableTextureFormats: 1 << (Texture_Format.JPG - 1),
      },
    ],
  });

  const bytes = encodeBulkMetadata(original);
  const decoded = decodeBulkMetadata(bytes);

  assert.equal(decoded.headNodeKey?.path, "0");
  assert.equal(decoded.headNodeKey?.epoch, 123);
  assert.deepEqual([...decoded.headNodeCenter], [1, 2, 3]);
  assert.equal(decoded.nodeMetadata.length, 1);
  assert.equal(decoded.nodeMetadata[0]?.epoch, 123);
});

test("BulkMetadata gzip roundtrip", () => {
  const bytes = encodeBulkMetadata(
    {
      headNodeKey: { path: "040", epoch: 1 },
      defaultImageryEpoch: 2,
    },
    { gzip: true },
  );
  assert.equal(bytes[0], 0x1f);
  assert.equal(bytes[1], 0x8b);

  const decoded = decodeBulkMetadata(bytes);
  assert.equal(decoded.headNodeKey?.path, "040");
  assert.equal(decoded.defaultImageryEpoch, 2);

  const plain = gunzipIfNeeded(bytes);
  assert.notEqual(plain[0], 0x1f);
});

test("NodeData roundtrip with mesh bytes", () => {
  const vertices = new Uint8Array([1, 2, 3, 4]);
  const original = nodeData.create({
    matrixGlobeFromMesh: Array.from({ length: 16 }, (_, i) => i),
    nodeKey: { path: "0123", epoch: 7 },
    copyrightIds: [10, 20],
    meshes: [
      {
        meshId: 0,
        vertices,
        texture: [{ format: Texture_Format.JPG, width: 256, height: 256, data: [new Uint8Array([0xff, 0xd8])] }],
      },
    ],
  });

  const bytes = encodeNodeData(original);
  const decoded = decodeNodeData(gzipBytes(bytes));

  assert.equal(decoded.nodeKey?.path, "0123");
  assert.equal(decoded.meshes.length, 1);
  assert.deepEqual([...decoded.meshes[0]!.vertices], [...vertices]);
  assert.equal(decoded.meshes[0]!.texture[0]?.format, Texture_Format.JPG);
  assert.deepEqual([...decoded.copyrightIds], [10, 20]);
});

test("Dataset enum wire values", () => {
  assert.equal(Dataset.RT_3D, 0);
  assert.equal(Dataset.RT_HYBRID, 1);
  assert.equal(Dataset.RT_TIME_MACHINE, 2);
});
