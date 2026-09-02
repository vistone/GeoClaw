import { NodeMetadata_Flags, Texture_Format } from "../gen/rocktree_pb.js";
import { Logger } from "../core/Logger.js";

const PREFERRED_FORMATS = [Texture_Format.CRN_DXT1, Texture_Format.JPG] as const;

/**
 * 节点纹理/影像元数据解析对象。
 */
export class TextureMetadataParser {
  private static readonly logger = new Logger("TextureMetadataParser");

  /**
   * 从位掩码选取纹理格式。
   * @param availableTextureFormats - 输入：`undefined | number` — availableTextureFormats 参数
   * @param defaultAvailableTextureFormats - 输入：`undefined | number` — defaultAvailableTextureFormats 参数
   * @returns 输出：`undefined | number` — undefined | number 实例
   */

  unpackTextureFormat(
    availableTextureFormats: number | undefined,
    defaultAvailableTextureFormats: number | undefined,
  ): number | undefined {
    return TextureMetadataParser.logger.measureSync("unpackTextureFormat", () => {
      const available = availableTextureFormats || defaultAvailableTextureFormats || 0;
      for (const format of PREFERRED_FORMATS) {
        if (available & (1 << (format - 1))) {
          TextureMetadataParser.logger.debug("选用纹理格式", { format });
          return format;
        }
      }
      TextureMetadataParser.logger.warn("无可用纹理格式", { available });
      return undefined;
    });
  }

  /**
   * 解析 imagery epoch。
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @param imageryEpoch - 输入：`undefined | number` — imageryEpoch 参数
   * @param defaultImageryEpoch - 输入：`undefined | number` — defaultImageryEpoch 参数
   * @returns 输出：`number` — 数值结果
   */

  unpackImageryEpoch(
    flags: number,
    imageryEpoch: number | undefined,
    defaultImageryEpoch: number | undefined,
  ): number {
    return TextureMetadataParser.logger.measureSync(
      "unpackImageryEpoch",
      () => {
        if ((flags & NodeMetadata_Flags.USE_IMAGERY_EPOCH) === 0) {
          return 0;
        }
        return imageryEpoch || defaultImageryEpoch || 0;
      },
      { flags },
    );
  }
}

export const textureMetadataParser = new TextureMetadataParser();
