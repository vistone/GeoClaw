import { NodeMetadata_Flags } from "../gen/rocktree_pb.js";
import { Logger } from "../core/Logger.js";

/** flags 解码结果 */
export type DecodedNodeFlags = {
  raw: number;
  rich3dLeaf: boolean;
  rich3dNodata: boolean;
  leaf: boolean;
  nodata: boolean;
  useImageryEpoch: boolean;
  /** 置位标志名列表（如 18 vs 19 差 RICH3D_LEAF） */
  names: string[];
};

const FLAG_BITS: { bit: NodeMetadata_Flags; name: string }[] = [
  { bit: NodeMetadata_Flags.RICH3D_LEAF, name: "RICH3D_LEAF" },
  { bit: NodeMetadata_Flags.RICH3D_NODATA, name: "RICH3D_NODATA" },
  { bit: NodeMetadata_Flags.LEAF, name: "LEAF" },
  { bit: NodeMetadata_Flags.NODATA, name: "NODATA" },
  { bit: NodeMetadata_Flags.USE_IMAGERY_EPOCH, name: "USE_IMAGERY_EPOCH" },
];

/**
 * NodeMetadata.flags 位掩码解码对象。
 */
export class FlagCodec {
  private static readonly logger = new Logger("FlagCodec");

  /**
   * 解码 flags 位掩码。
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`DecodedNodeFlags` — 各 flags 布尔字段与 names 列表
   */

  decode(flags: number): DecodedNodeFlags {
    return FlagCodec.logger.measureSync("decode", () => {
      const names: string[] = [];
      for (const { bit, name } of FLAG_BITS) {
        if ((flags & bit) !== 0) names.push(name);
      }
      return {
        raw: flags,
        rich3dLeaf: (flags & NodeMetadata_Flags.RICH3D_LEAF) !== 0,
        rich3dNodata: (flags & NodeMetadata_Flags.RICH3D_NODATA) !== 0,
        leaf: (flags & NodeMetadata_Flags.LEAF) !== 0,
        nodata: (flags & NodeMetadata_Flags.NODATA) !== 0,
        useImageryEpoch: (flags & NodeMetadata_Flags.USE_IMAGERY_EPOCH) !== 0,
        names,
      };
    }, { flags });
  }
}

export const flagCodec = new FlagCodec();
