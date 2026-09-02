import {
  BulkMetadataRequestSchema,
  BulkMetadataSchema,
  CopyrightRequestSchema,
  CopyrightsSchema,
  NodeDataRequestSchema,
  NodeDataSchema,
  PlanetoidMetadataRequestSchema,
  PlanetoidMetadataSchema,
  TextureDataRequestSchema,
  TextureDataSchema,
  ViewportMetadataRequestSchema,
  ViewportMetadataSchema,
} from "./gen/rocktree_pb.js";

export type { BytesLike } from "./core/BytesLike.js";
export { Logger, LogLevel, logLevelFromEnv } from "./core/Logger.js";

export {
  BulkMetadataRequestSchema,
  BulkMetadataSchema,
  CopyrightRequestSchema,
  CopyrightsSchema,
  NodeDataRequestSchema,
  NodeDataSchema,
  PlanetoidMetadataRequestSchema,
  PlanetoidMetadataSchema,
  TextureDataRequestSchema,
  TextureDataSchema,
  ViewportMetadataRequestSchema,
  ViewportMetadataSchema,
};
export * from "./gen/rocktree_pb.js";

export { GzipCodec, gzipCodec } from "./codec/GzipCodec.js";
export { PbUrlCodec, pbUrlCodec } from "./codec/PbUrlCodec.js";
export { PathCodec, pathCodec } from "./codec/PathCodec.js";
export type { UnpackedPathAndFlags } from "./codec/PathCodec.js";
export { FlagCodec, flagCodec } from "./codec/FlagCodec.js";
export type { DecodedNodeFlags } from "./codec/FlagCodec.js";
export { ProtobufCodec, protobufCodec } from "./codec/ProtobufCodec.js";
export type { CodecOptions } from "./codec/ProtobufCodec.js";

export { BulkData, BulkDataParser, bulkDataParser } from "./bulk/BulkDataParser.js";
export { NodeHeaderParser, nodeHeaderParser } from "./bulk/NodeHeaderParser.js";
export type { NodeHeader } from "./bulk/NodeHeaderParser.js";
export { ObbParser, obbParser } from "./bulk/ObbParser.js";
export type { OBB, Vec3, Mat3 } from "./bulk/ObbParser.js";
export { LatLonBox } from "./bulk/LatLonBox.js";
export type { LatLon } from "./bulk/LatLonBox.js";
export { LatLonBoxCodec, latLonBoxCodec } from "./bulk/LatLonBoxCodec.js";
export { TextureMetadataParser, textureMetadataParser } from "./bulk/TextureMetadataParser.js";

export {
  WebFetch,
  webFetch,
  createWebFetch,
  EARTH_WEB_CONTEXT_HEADERS,
} from "./fetch/WebFetch.js";
export type { WebFetchOptions, WebFetchGetOptions, TlsFetchFn, FetchTransportTrace, WebFetchResult, ProxyMode } from "./fetch/WebFetch.js";
export { DEFAULT_GEOCLAW_PROXY, resolveProxyUrl } from "./fetch/WebFetch.js";

export {
  TlsFingerprintCodec,
  tlsFingerprintCodec,
  DEFAULT_TLS_FINGERPRINT,
  DEFAULT_TLS_BROWSER_PROFILE,
  BROWSER_TLS_PROFILES,
} from "./fetch/TlsFingerprintCodec.js";
export type {
  TlsFingerprintConfig,
  TlsRequestConfig,
  BrowserProfile,
  BrowserPlatform,
  BrowserEmulationOptions,
} from "./fetch/TlsFingerprintCodec.js";

export {
  HostPinPool,
  khGoogleHostPinPool,
  parseKhGoogleYaml,
} from "./fetch/HostPinPool.js";
export type {
  HostPinPoolOptions,
  HostPinRecord,
  HostPinResolveResult,
} from "./fetch/HostPinPool.js";

export {
  RocktreeApi,
  rocktreeApi,
  createRocktreeApi,
  fetchPlanetoidMetadata,
  fetchBulkMetadata,
  fetchBulkData,
  DEFAULT_ROCKTREE_BASE,
  /** @deprecated 使用 RocktreeApi */
  RocktreeClient,
  /** @deprecated 使用 rocktreeApi */
  rocktreeClient,
  /** @deprecated 使用 createRocktreeApi */
  createRocktreeClient,
} from "./client/RocktreeApi.js";
export type {
  RocktreeApiOptions,
  FetchBulkMetadataArgs,
  /** @deprecated 使用 RocktreeApiOptions */
  RocktreeClientOptions,
} from "./client/RocktreeApi.js";

// --- 向后兼容的函数式 API ---

import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { BytesLike } from "./core/BytesLike.js";
import type { CodecOptions } from "./codec/ProtobufCodec.js";
import { gzipCodec } from "./codec/GzipCodec.js";
import { pbUrlCodec } from "./codec/PbUrlCodec.js";
import { pathCodec } from "./codec/PathCodec.js";
import { flagCodec } from "./codec/FlagCodec.js";
import { protobufCodec } from "./codec/ProtobufCodec.js";
import { bulkDataParser } from "./bulk/BulkDataParser.js";
import { nodeHeaderParser } from "./bulk/NodeHeaderParser.js";
import { obbParser } from "./bulk/ObbParser.js";
import { latLonBoxCodec } from "./bulk/LatLonBoxCodec.js";
import { textureMetadataParser } from "./bulk/TextureMetadataParser.js";
import type { BulkMetadata } from "./gen/rocktree_pb.js";

export const gunzipIfNeeded = (input: BytesLike) => gzipCodec.gunzipIfNeeded(input);
export const gzipBytes = (input: BytesLike) => gzipCodec.gzipBytes(input);
export const toUint8Array = (input: BytesLike) => gzipCodec.toUint8Array(input);

export const encodeBulkMetadataPb = (path: string, bulkEpoch: number) =>
  pbUrlCodec.encodeBulkMetadataPb(path, bulkEpoch);
export const bulkMetadataUrlPath = (path: string, bulkEpoch: number) =>
  pbUrlCodec.bulkMetadataUrlPath(path, bulkEpoch);

export const unpackPathAndFlags = (v: number) => pathCodec.unpackPathAndFlags(v);
export const isBulkPath = (p: string, f: number) => pathCodec.isBulkPath(p, f);
export const canHaveData = (f: number) => pathCodec.canHaveData(f);
export const hasChildBulk = (p: string, f: number) => pathCodec.hasChildBulk(p, f);
export const hasNodeData = (f: number) => pathCodec.hasNodeData(f);
export const joinOctantPath = (a: string, b: string) => pathCodec.joinOctantPath(a, b);

export const decodeNodeFlags = (f: number) => flagCodec.decode(f);

export const decode = <Desc extends DescMessage>(
  schema: Desc,
  input: BytesLike,
  options?: CodecOptions,
) => protobufCodec.decode(schema, input, options);

export const encode = <Desc extends DescMessage>(
  schema: Desc,
  message: MessageInitShape<Desc> | MessageShape<Desc>,
  options?: CodecOptions,
) => protobufCodec.encode(schema, message, options);

export const bulkMetadata = protobufCodec.forSchema(BulkMetadataSchema);
export const nodeData = protobufCodec.forSchema(NodeDataSchema);
export const textureData = protobufCodec.forSchema(TextureDataSchema);
export const viewportMetadata = protobufCodec.forSchema(ViewportMetadataSchema);
export const planetoidMetadata = protobufCodec.forSchema(PlanetoidMetadataSchema);
export const copyrights = protobufCodec.forSchema(CopyrightsSchema);
export const bulkMetadataRequest = protobufCodec.forSchema(BulkMetadataRequestSchema);
export const nodeDataRequest = protobufCodec.forSchema(NodeDataRequestSchema);
export const textureDataRequest = protobufCodec.forSchema(TextureDataRequestSchema);
export const viewportMetadataRequest = protobufCodec.forSchema(ViewportMetadataRequestSchema);
export const planetoidMetadataRequest = protobufCodec.forSchema(PlanetoidMetadataRequestSchema);
export const copyrightRequest = protobufCodec.forSchema(CopyrightRequestSchema);

export const decodeBulkMetadata = bulkMetadata.decode;
export const encodeBulkMetadata = bulkMetadata.encode;
export const decodeNodeData = nodeData.decode;
export const encodeNodeData = nodeData.encode;
export const decodeTextureData = textureData.decode;
export const encodeTextureData = textureData.encode;

export const parseBulkData = (metadata: BulkMetadata) => bulkDataParser.parse(metadata);
export const parseNodeHeader = (parent: BulkMetadata, nm: Parameters<typeof nodeHeaderParser.parse>[1]) =>
  nodeHeaderParser.parse(parent, nm);
export const isDataNode = (h: Parameters<typeof nodeHeaderParser.isDataNode>[0]) =>
  nodeHeaderParser.isDataNode(h);
export const isTraversableNode = (h: Parameters<typeof nodeHeaderParser.isTraversableNode>[0]) =>
  nodeHeaderParser.isTraversableNode(h);
export const isRenderableNode = isDataNode;

export const unpackObb = (
  packed: Uint8Array,
  head: readonly number[],
  mpt: number,
) => obbParser.unpack(packed, head, mpt);

export const octantToLatLonBox = (path: string) => latLonBoxCodec.fromOctantPath(path);

export const unpackTextureFormat = (
  a: number | undefined,
  d: number | undefined,
) => textureMetadataParser.unpackTextureFormat(a, d);

export const unpackImageryEpoch = (
  flags: number,
  imagery: number | undefined,
  def: number | undefined,
) => textureMetadataParser.unpackImageryEpoch(flags, imagery, def);
