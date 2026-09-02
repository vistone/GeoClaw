import { fetchBulkData, fetchPlanetoidMetadata } from "../src/index.js";

const planetoid = await fetchPlanetoidMetadata();
const bulkEpoch = planetoid.rootNodeMetadata?.epoch;
if (bulkEpoch === undefined) throw new Error("missing bulkEpoch");

const bulk = await fetchBulkData({ path: "", bulkEpoch });

const sampleBulks = [...bulk.bulks.values()].slice(0, 5).map((h) => ({
  path: h.path,
  epoch: h.epoch,
  ...(h.bulkEpoch !== undefined ? { bulkEpoch: h.bulkEpoch } : {}),
  flags: h.flags,
  flagNames: h.flagBits.names,
  metersPerTexel: h.metersPerTexel,
  textureFormat: h.textureFormat,
  imageryEpoch: h.imageryEpoch,
}));

const sampleNodes = [...bulk.nodes.values()].slice(0, 5).map((h) => ({
  path: h.path,
  epoch: h.epoch,
  ...(h.bulkEpoch !== undefined ? { bulkEpoch: h.bulkEpoch } : {}),
  flags: h.flags,
  flagNames: h.flagBits.names,
  metersPerTexel: h.metersPerTexel,
  textureFormat: h.textureFormat,
  imageryEpoch: h.imageryEpoch,
  obbCenter: h.obb?.center,
  latLonBox: h.latLonBox
    ? { n: h.latLonBox.n, s: h.latLonBox.s, w: h.latLonBox.w, e: h.latLonBox.e }
    : undefined,
}));

console.log(
  JSON.stringify(
    {
      headNodeKey: bulk.headNodeKey,
      headNodeCenter: bulk.headNodeCenter,
      defaultImageryEpoch: bulk.defaultImageryEpoch,
      metersPerTexel: bulk.metersPerTexel,
      headerCount: bulk.nodeMetadata.length,
      bulkCount: bulk.bulks.size,
      nodeCount: bulk.nodes.size,
      octantCount: bulk.octants.size,
      sampleBulks,
      sampleNodes,
    },
    null,
    2,
  ),
);
