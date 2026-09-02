import type { BulkMetadata, NodeMetadata } from "../gen/rocktree_pb.js";
import { NodeMetadata_Flags } from "../gen/rocktree_pb.js";
import type { DecodedNodeFlags } from "../codec/FlagCodec.js";
import { flagCodec } from "../codec/FlagCodec.js";
import { pathCodec } from "../codec/PathCodec.js";
import { Logger } from "../core/Logger.js";
import type { LatLonBox } from "./LatLonBox.js";
import { latLonBoxCodec } from "./LatLonBoxCodec.js";
import type { OBB } from "./ObbParser.js";
import { obbParser } from "./ObbParser.js";
import { textureMetadataParser } from "./TextureMetadataParser.js";

/** 解析后的节点头 */
export type NodeHeader = {
  path: string;
  relativePath: string;
  parentBulkPath: string;
  flags: number;
  flagBits: DecodedNodeFlags;
  level: number;
  isBulk: boolean;
  canHaveData: boolean;
  metersPerTexel: number;
  textureFormat: number | undefined;
  imageryEpoch: number;
  /** NodeData 用 epoch */
  epoch: number;
  /** 仅 isBulk 时有值 */
  bulkEpoch?: number;
  obb?: OBB;
  latLonBox?: LatLonBox;
  raw: NodeMetadata;
};

/**
 * NodeMetadata → NodeHeader 解析对象。
 */
export class NodeHeaderParser {
  private static readonly logger = new Logger("NodeHeaderParser");

  /**
   * 判断是否为有效数据节点。
   * @param header - 输入：`NodeHeader` — 已解析节点头
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  isDataNode(header: NodeHeader): boolean {
    return NodeHeaderParser.logger.measureSync(
      "isDataNode",
      () => header.canHaveData && header.obb !== undefined,
      { path: header.path },
    );
  }

  /**
   * 判断是否为树遍历节点。
   * @param header - 输入：`NodeHeader` — 已解析节点头
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  isTraversableNode(header: NodeHeader): boolean {
    return NodeHeaderParser.logger.measureSync(
      "isTraversableNode",
      () =>
        (header.canHaveData || (header.flags & NodeMetadata_Flags.LEAF) === 0) &&
        header.obb !== undefined,
      { path: header.path },
    );
  }

  /**
   * 解析单条 NodeMetadata 为 NodeHeader。
   * @param parentBulk - 输入：`BulkMetadata` — 所属 Bulk
   * @param metadata - 输入：`NodeMetadata` — 单条节点元数据
   * @returns 输出：`NodeHeader` — 单节点解析头
   */

  parse(parentBulk: BulkMetadata, metadata: NodeMetadata): NodeHeader {
    return NodeHeaderParser.logger.measureSync(
      "parse",
      () => {
        const unpacked = pathCodec.unpackPathAndFlags(metadata.pathAndFlags);
        const parentBulkPath = parentBulk.headNodeKey?.path ?? "";
        const path = pathCodec.joinOctantPath(parentBulkPath, unpacked.path);
        const flags = unpacked.flags;
        const level = path.length;
        const isBulk = pathCodec.isBulkPath(path, flags);
        const canData = pathCodec.canHaveData(flags);

        const metersPerTexel = metadata.metersPerTexel !== 0
          ? metadata.metersPerTexel
          : (parentBulk.metersPerTexel[unpacked.level - 1] ?? 0);

        const textureFormat = textureMetadataParser.unpackTextureFormat(
          metadata.availableTextureFormats || undefined,
          parentBulk.defaultAvailableTextureFormats || undefined,
        );

        const imageryEpoch = textureMetadataParser.unpackImageryEpoch(
          flags,
          metadata.imageryEpoch || undefined,
          parentBulk.defaultImageryEpoch || undefined,
        );

        const epoch =
          metadata.epoch !== 0 ? metadata.epoch : (parentBulk.headNodeKey?.epoch ?? 0);

        let bulkEpoch: number | undefined;
        if (isBulk) {
          bulkEpoch =
            metadata.bulkMetadataEpoch !== 0
              ? metadata.bulkMetadataEpoch
              : (parentBulk.headNodeKey?.epoch ?? 0);
        }

        let obb: OBB | undefined;
        let latLonBox: LatLonBox | undefined;
        if (metadata.orientedBoundingBox.length === 15) {
          obb = obbParser.unpack(
            metadata.orientedBoundingBox,
            parentBulk.headNodeCenter,
            metersPerTexel,
          );
          latLonBox = latLonBoxCodec.fromOctantPath(path);
        }

        NodeHeaderParser.logger.debug("解析 NodeHeader", { path, flags, isBulk, epoch, bulkEpoch });

        return {
          path,
          relativePath: unpacked.path,
          parentBulkPath,
          flags,
          flagBits: flagCodec.decode(flags),
          level,
          isBulk,
          canHaveData: canData,
          metersPerTexel,
          textureFormat,
          imageryEpoch,
          epoch,
          ...(bulkEpoch !== undefined ? { bulkEpoch } : {}),
          obb,
          latLonBox,
          raw: metadata,
        };
      },
      { pathAndFlags: metadata.pathAndFlags },
    );
  }
}

export const nodeHeaderParser = new NodeHeaderParser();
