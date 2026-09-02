import { Logger } from "../core/Logger.js";

/**
 * Rocktree HTTP pb= 参数编码对象。
 */
export class PbUrlCodec {
  private static readonly logger = new Logger("PbUrlCodec");

  /**
   * 编码 BulkMetadata URL pb 段。
   * @param path - 输入：`string` — 八分体路径
   * @param bulkEpoch - 输入：`number` — BulkMetadata 版本号
   * @returns 输出：`string` — 字符串结果
   * @throws {Error} 条件不满足或 I/O 失败时
   */

  encodeBulkMetadataPb(path: string, bulkEpoch: number): string {
    return PbUrlCodec.logger.measureSync(
      "encodeBulkMetadataPb",
      () => {
        if (!Number.isInteger(bulkEpoch) || bulkEpoch < 0) {
          PbUrlCodec.logger.error("bulkEpoch 非法", { bulkEpoch, path });
          throw new Error(`invalid bulkEpoch: ${bulkEpoch}`);
        }
        const pb = `!1m2!1s${path}!2u${bulkEpoch}`;
        PbUrlCodec.logger.debug("编码 BulkMetadata pb", { path, bulkEpoch, pb });
        return pb;
      },
      { path, bulkEpoch },
    );
  }

  /**
   * 生成 BulkMetadata 相对 URL。
   * @param path - 输入：`string` — 八分体路径
   * @param bulkEpoch - 输入：`number` — BulkMetadata 版本号
   * @returns 输出：`string` — 字符串结果
   */

  bulkMetadataUrlPath(path: string, bulkEpoch: number): string {
    return PbUrlCodec.logger.measureSync(
      "bulkMetadataUrlPath",
      () => `BulkMetadata/pb=${this.encodeBulkMetadataPb(path, bulkEpoch)}`,
      { path, bulkEpoch },
    );
  }
}

export const pbUrlCodec = new PbUrlCodec();
