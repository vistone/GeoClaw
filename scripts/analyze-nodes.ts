import {
  fetchBulkData,
  fetchPlanetoidMetadata,
  NodeMetadata_Flags,
} from "../src/index.js";

async function main() {
  const planetoid = await fetchPlanetoidMetadata();
  const bulk = await fetchBulkData({
    path: "",
    bulkEpoch: planetoid.rootNodeMetadata!.epoch,
  });

  let canData = 0;
  let noData = 0;
  const outliers: unknown[] = [];

  for (const h of bulk.nodeMetadata) {
    const nd = (h.flags & NodeMetadata_Flags.NODATA) !== 0;
    const lf = (h.flags & NodeMetadata_Flags.LEAF) !== 0;
    if (!nd) canData++;
    else {
      noData++;
      outliers.push({
        path: h.path,
        flags: h.flags,
        leaf: lf,
        isBulk: h.isBulk,
        hasObb: !!h.obb,
        inNodes: bulk.nodes.has(h.path),
        inBulks: bulk.bulks.has(h.path),
        earth3dRule: (h.canHaveData || !lf) && !!h.obb,
      });
    }
  }

  // also count what can_have_data && obb would be
  let dataWithObb = 0;
  for (const h of bulk.nodeMetadata) {
    if (h.canHaveData && h.obb) dataWithObb++;
  }

  console.log(
    JSON.stringify(
      {
        headers: bulk.nodeMetadata.length,
        nodesMap: bulk.nodes.size,
        octantsMap: bulk.octants.size,
        bulksMap: bulk.bulks.size,
        canHaveData: canData,
        canHaveDataAndObb: dataWithObb,
        noData,
        outliers,
      },
      null,
      2,
    ),
  );
}

main();
