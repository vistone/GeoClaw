import { fetchPlanetoidMetadata } from "../src/index.js";

const meta = await fetchPlanetoidMetadata();
console.log(
  JSON.stringify(
    meta,
    (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v),
    2,
  ),
);
