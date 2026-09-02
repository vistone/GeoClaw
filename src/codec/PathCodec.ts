import { NodeMetadata_Flags } from "../gen/rocktree_pb.js";
import { Logger } from "../core/Logger.js";

/** path_and_flags 解包结果 */
export type UnpackedPathAndFlags = {
  /** 相对本 Bulk 的八分体路径（'0'..'7'） */
  path: string;
  /** 相对层级 = path.length */
  level: number;
  /** flags 位掩码 */
  flags: number;
};

/**
 * 八分体 path_and_flags 编解码对象。
 */
export class PathCodec {
  private static readonly logger = new Logger("PathCodec");

  /**
   * 解包 path_and_flags 为路径与标志位。
   * @param pathAndFlags - 输入：`number` — path_and_flags 打包字段
   * @returns 输出：`UnpackedPathAndFlags` — path、level、flags 三字段
   */

  unpackPathAndFlags(pathAndFlags: number): UnpackedPathAndFlags {
    return PathCodec.logger.measureSync("unpackPathAndFlags", () => {
      let pathId = pathAndFlags >>> 0;
      const level = 1 + (pathId & 3);
      pathId >>>= 2;
      let path = "";
      for (let i = 0; i < level; i++) {
        path += String(pathId & 7);
        pathId >>>= 3;
      }
      return { path, level, flags: pathId };
    }, { pathAndFlags });
  }

  /**
   * 判断绝对路径是否为子 Bulk 节点。
   * @param absolutePath - 输入：`string` — 绝对八分体路径
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  isBulkPath(absolutePath: string, flags: number): boolean {
    return PathCodec.logger.measureSync(
      "isBulkPath",
      () =>
        absolutePath.length > 0 &&
        absolutePath.length % 4 === 0 &&
        (flags & NodeMetadata_Flags.LEAF) === 0,
      { absolutePath, flags },
    );
  }

  /**
   * 判断节点是否可含几何数据。
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  canHaveData(flags: number): boolean {
    return PathCodec.logger.measureSync(
      "canHaveData",
      () => (flags & NodeMetadata_Flags.NODATA) === 0,
      { flags },
    );
  }

  /**
   * 拼接父路径与相对八分体段。
   * @param basePath - 输入：`string` — 父路径前缀
   * @param relativePath - 输入：`string` — 相对八分体路径
   * @returns 输出：`string` — 字符串结果
   */

  joinOctantPath(basePath: string, relativePath: string): string {
    return PathCodec.logger.measureSync(
      "joinOctantPath",
      () => `${basePath}${relativePath}`,
      { basePath, relativePath },
    );
  }

  /**
   * 判断相对路径是否指向子 Bulk。
   * @param relativePath - 输入：`string` — 相对八分体路径
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  hasChildBulk(relativePath: string, flags: number): boolean {
    return PathCodec.logger.measureSync(
      "hasChildBulk",
      () => relativePath.length === 4 && (flags & NodeMetadata_Flags.LEAF) === 0,
      { relativePath, flags },
    );
  }

  /**
   * 判断 flags 是否允许节点数据。
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  hasNodeData(flags: number): boolean {
    return PathCodec.logger.measureSync("hasNodeData", () => this.canHaveData(flags), { flags });
  }
}

export const pathCodec = new PathCodec();
