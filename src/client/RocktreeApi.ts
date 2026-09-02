import {
  BulkMetadataSchema,
  PlanetoidMetadataSchema,
  type BulkMetadata,
  type NodeKey,
  type PlanetoidMetadata,
  type PlanetoidMetadataRequest,
} from "../gen/rocktree_pb.js";
import { gzipCodec } from "../codec/GzipCodec.js";
import { pbUrlCodec } from "../codec/PbUrlCodec.js";
import { protobufCodec } from "../codec/ProtobufCodec.js";
import { bulkDataParser, type BulkData } from "../bulk/BulkDataParser.js";
import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";
import {
  createWebFetch,
  getWebFetch,
  type WebFetch,
  type WebFetchOptions,
} from "../fetch/WebFetch.js";

export type RocktreeApiOptions = WebFetchOptions & {
  baseUrl?: string;
  webFetch?: WebFetch;
};

export type FetchBulkMetadataArgs = {
  path?: string;
  bulkEpoch?: number;
  nodeKey?: NodeKey;
};

/**
 * Rocktree HTTP API：通过 WebFetch 拉取 kh.google.com 并解码 protobuf。
 */
export class RocktreeApi {
  private static readonly logger = new Logger("RocktreeApi");
  private readonly webFetch: WebFetch;
  private readonly baseUrl: string;

  /**
   * @param options - 输入：`RocktreeApiOptions` — baseUrl、WebFetch、指纹与 header 配置
   */

  constructor(options: RocktreeApiOptions = {}) {
    const { baseUrl, webFetch: injected, ...webFetchOpts } = options;
    this.baseUrl = baseUrl ?? GeoClawConfig.get().getRocktreeBaseUrl();
    this.webFetch = injected ?? createWebFetch(webFetchOpts);
  }

  /**
   * 拉取 PlanetoidMetadata。
   * @param request - 输入：`PlanetoidMetadataRequest` — 预留请求体（当前未用）
   * @returns 输出：`Promise<PlanetoidMetadata>` — 星球元数据
   */

  async fetchPlanetoidMetadata(
    request?: PlanetoidMetadataRequest,
  ): Promise<PlanetoidMetadata> {
    return RocktreeApi.logger.measureAsync("fetchPlanetoidMetadata", async () => {
      void request;
      const url = this.joinUrl(this.baseUrl, "PlanetoidMetadata");
      RocktreeApi.logger.info("请求 PlanetoidMetadata", { url });
      const bytes = gzipCodec.gunzipIfNeeded(await this.webFetch.getBytes(url));
      const meta = protobufCodec.decode(PlanetoidMetadataSchema, bytes, { gzip: false });
      RocktreeApi.logger.info("PlanetoidMetadata 解析成功", {
        radius: meta.radius,
        bulkEpoch: meta.rootNodeMetadata?.epoch,
      });
      return meta;
    });
  }

  /**
   * 拉取 BulkMetadata。
   * @param args - 输入：`FetchBulkMetadataArgs` — path、bulkEpoch 或 nodeKey
   * @returns 输出：`Promise<BulkMetadata>` — 原始 Bulk 消息
   * @throws {Error} 缺少 bulkEpoch 或 HTTP 失败时
   */

  async fetchBulkMetadata(args: FetchBulkMetadataArgs = {}): Promise<BulkMetadata> {
    return RocktreeApi.logger.measureAsync("fetchBulkMetadata", async () => {
      const path = args.nodeKey?.path ?? args.path ?? "";
      let bulkEpoch = args.nodeKey?.epoch ?? args.bulkEpoch;
      if (bulkEpoch === undefined) {
        const planetoid = await this.fetchPlanetoidMetadata();
        bulkEpoch = planetoid.rootNodeMetadata?.epoch;
        if (bulkEpoch === undefined) {
          RocktreeApi.logger.error("缺少 root bulkEpoch");
          throw new Error("PlanetoidMetadata missing rootNodeMetadata.epoch (bulkEpoch)");
        }
      }

      const urlPath = pbUrlCodec.bulkMetadataUrlPath(path, bulkEpoch);
      const url = this.joinUrl(this.baseUrl, urlPath);
      RocktreeApi.logger.info("请求 BulkMetadata", { url, path, bulkEpoch });
      const bytes = gzipCodec.gunzipIfNeeded(await this.webFetch.getBytes(url));
      const bulk = protobufCodec.decode(BulkMetadataSchema, bytes, { gzip: false });
      RocktreeApi.logger.info("BulkMetadata 解析成功", { nodeCount: bulk.nodeMetadata.length });
      return bulk;
    }, { path: args.path, bulkEpoch: args.bulkEpoch });
  }

  /**
   * 拉取并解析 BulkData。
   * @param args - 输入：`FetchBulkMetadataArgs` — 请求参数
   * @returns 输出：`Promise<BulkData>` — nodes、octants、bulks 索引
   */

  async fetchBulkData(args: FetchBulkMetadataArgs = {}): Promise<BulkData> {
    return RocktreeApi.logger.measureAsync(
      "fetchBulkData",
      async () => bulkDataParser.parse(await this.fetchBulkMetadata(args)),
    );
  }

  /**
   * 返回底层 WebFetch（可配置 header / 指纹）。
   * @returns 输出：`WebFetch` — HTTP 抓取对象
   */

  getWebFetch(): WebFetch {
    return this.webFetch;
  }

  /**
   * 拼接 base 与 path。
   * @param base - 输入：`string` — 基础 URL
   * @param pathSegment - 输入：`string` — 路径段
   * @returns 输出：`string` — 完整 URL
   */

  private joinUrl(base: string, pathSegment: string): string {
    return `${base.replace(/\/+$/, "")}/${pathSegment.replace(/^\/+/, "")}`;
  }
}

/**
 * 创建 RocktreeApi 实例。
 * @param options - 输入：`RocktreeApiOptions` — baseUrl、WebFetch 与 header 配置
 * @returns 输出：`RocktreeApi` — Rocktree API 实例
 */
export function createRocktreeApi(options: RocktreeApiOptions = {}): RocktreeApi {
  return new RocktreeApi(options);
}

let cachedRocktreeApi: RocktreeApi | undefined;

/**
 * 默认 RocktreeApi 单例（懒加载，读取 geoclaw.yaml）。
 * @returns 输出：`RocktreeApi` — 默认实例
 */
export function getRocktreeApi(): RocktreeApi {
  cachedRocktreeApi ??= new RocktreeApi();
  return cachedRocktreeApi;
}

/** @deprecated 请使用 getRocktreeApi() */
export const rocktreeApi: RocktreeApi = new Proxy({} as RocktreeApi, {
  get(_target, prop) {
    const inst = getRocktreeApi();
    const value = Reflect.get(inst, prop, inst);
    return typeof value === "function" ? value.bind(inst) : value;
  },
});

export const fetchPlanetoidMetadata = (
  options?: RocktreeApiOptions & { request?: PlanetoidMetadataRequest },
) => {
  const { request, ...apiOpts } = options ?? {};
  return new RocktreeApi(apiOpts).fetchPlanetoidMetadata(request);
};

export const fetchBulkMetadata = (
  args?: FetchBulkMetadataArgs,
  options?: RocktreeApiOptions,
) => new RocktreeApi(options).fetchBulkMetadata(args);

export const fetchBulkData = (args?: FetchBulkMetadataArgs, options?: RocktreeApiOptions) =>
  new RocktreeApi(options).fetchBulkData(args);

/** @deprecated 使用 RocktreeApi */
export type RocktreeClientOptions = RocktreeApiOptions;

/** @deprecated 使用 RocktreeApi */
export type RocktreeClient = RocktreeApi;

/** @deprecated 使用 createRocktreeApi */
export const createRocktreeClient = createRocktreeApi;

/** @deprecated 使用 rocktreeApi */
export const rocktreeClient = rocktreeApi;

/** @deprecated 使用 RocktreeApi */
export const RocktreeClient = RocktreeApi;
