import type { BulkMetadata, NodeKey } from "../gen/rocktree_pb.js";
import { Logger } from "../core/Logger.js";
import { nodeHeaderParser, type NodeHeader } from "./NodeHeaderParser.js";

/**
 * BulkMetadata 解析结果，含 nodes、octants、bulks 三类索引。
 * 集合语义见 DEVELOPMENT.md §6；具体数量由真实 Bulk 决定，不在注释中写死。
 */
export class BulkData {
  private static readonly logger = new Logger("BulkData");

  readonly headNodeKey: NodeKey | undefined;
  readonly headNodeCenter: number[];
  readonly metersPerTexel: number[];
  readonly defaultImageryEpoch: number;
  readonly defaultAvailableTextureFormats: number;
  readonly defaultAvailableViewDependentTextures: number;
  readonly defaultAvailableViewDependentTextureFormats: number;

  readonly nodeMetadata: NodeHeader[];
  readonly bulks: Map<string, NodeHeader>;
  readonly nodes: Map<string, NodeHeader>;
  readonly octants: Map<string, NodeHeader>;
  readonly raw: BulkMetadata;

  /**
   * 从 BulkMetadata 构建 nodes、octants、bulks 索引。
   * @param metadata - 输入：`BulkMetadata` — 原始 Bulk protobuf 消息
   */

  constructor(metadata: BulkMetadata) {
    this.raw = metadata;
    this.headNodeKey = metadata.headNodeKey;
    this.headNodeCenter = [...metadata.headNodeCenter];
    this.metersPerTexel = [...metadata.metersPerTexel];
    this.defaultImageryEpoch = metadata.defaultImageryEpoch;
    this.defaultAvailableTextureFormats = metadata.defaultAvailableTextureFormats;
    this.defaultAvailableViewDependentTextures = metadata.defaultAvailableViewDependentTextures;
    this.defaultAvailableViewDependentTextureFormats =
      metadata.defaultAvailableViewDependentTextureFormats;

    this.nodeMetadata = [];
    this.bulks = new Map();
    this.nodes = new Map();
    this.octants = new Map();

    for (const nm of metadata.nodeMetadata) {
      const header = nodeHeaderParser.parse(metadata, nm);
      this.nodeMetadata.push(header);
      if (header.isBulk) {
        this.bulks.set(header.path, header);
      }
      if (nodeHeaderParser.isTraversableNode(header)) {
        this.octants.set(header.path, header);
      }
      if (nodeHeaderParser.isDataNode(header)) {
        this.nodes.set(header.path, header);
      }
    }

    BulkData.logger.info("Bulk 解析完成", {
      headers: this.nodeMetadata.length,
      bulks: this.bulks.size,
      nodes: this.nodes.size,
      octants: this.octants.size,
    });
  }
}

/**
 * BulkMetadata 解析门面对象，负责调用 BulkData 构建索引。
 */
export class BulkDataParser {
  private static readonly logger = new Logger("BulkDataParser");

  /**
   * 解析 BulkMetadata 为 BulkData。
   * @param metadata - 输入：`BulkMetadata` — 原始 Bulk protobuf 消息
   * @returns 输出：`BulkData` — nodes、octants、bulks 三类 Map 索引
   */

  parse(metadata: BulkMetadata): BulkData {
    BulkDataParser.logger.debug("开始解析 BulkMetadata");
    return BulkDataParser.logger.measureSync(
      "parse",
      () => new BulkData(metadata),
      { nodeCount: metadata.nodeMetadata.length, includes: "BulkData.construct" },
    );
  }
}

export const bulkDataParser = new BulkDataParser();
