import { gunzipSync, gzipSync } from "node:zlib";

import type { BytesLike } from "../core/BytesLike.js";
import { Logger } from "../core/Logger.js";

const GZIP_MAGIC0 = 0x1f;
const GZIP_MAGIC1 = 0x8b;

/**
 * Gzip 字节编解码对象。
 */
export class GzipCodec {
  private static readonly logger = new Logger("GzipCodec");

  /**
   * 转为 Uint8Array。
   * @param input - 输入：`ArrayBuffer | Uint8Array | Buffer` — 原始输入
   * @returns 输出：`Uint8Array` — 字节数组
   */

  toUint8Array(input: BytesLike): Uint8Array {
    return GzipCodec.logger.measureSync("toUint8Array", () => {
      if (input instanceof Uint8Array) {
        return input;
      }
      return new Uint8Array(input);
    });
  }

  /**
   * 检测 gzip 并解压。
   * @param input - 输入：`ArrayBuffer | Uint8Array | Buffer` — 原始输入
   * @returns 输出：`Uint8Array` — 字节数组
   */

  gunzipIfNeeded(input: BytesLike): Uint8Array {
    return GzipCodec.logger.measureSync("gunzipIfNeeded", () => {
      const bytes = this.toUint8Array(input);
      const isGzip =
        bytes.length >= 2 && bytes[0] === GZIP_MAGIC0 && bytes[1] === GZIP_MAGIC1;
      if (isGzip) {
        GzipCodec.logger.debug("检测到 gzip，执行解压", { length: bytes.length });
        return gunzipSync(bytes);
      }
      return bytes;
    });
  }

  /**
   * gzip 压缩字节。
   * @param input - 输入：`ArrayBuffer | Uint8Array | Buffer` — 原始输入
   * @returns 输出：`Uint8Array` — 字节数组
   */

  gzipBytes(input: BytesLike): Uint8Array {
    return GzipCodec.logger.measureSync("gzipBytes", () => {
      const out = gzipSync(this.toUint8Array(input));
      GzipCodec.logger.debug("gzip 压缩完成", {
        in: input instanceof Uint8Array ? input.length : "buffer",
        out: out.length,
      });
      return out;
    });
  }
}

/** 默认单例 */
export const gzipCodec = new GzipCodec();
