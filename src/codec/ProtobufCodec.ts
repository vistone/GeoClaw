import { create, fromBinary, isMessage, toBinary } from "@bufbuild/protobuf";
import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";

import type { BytesLike } from "../core/BytesLike.js";
import { Logger } from "../core/Logger.js";
import { gzipCodec } from "./GzipCodec.js";

/** 编解码选项 */
export type CodecOptions = {
  /** false=不 gunzip；encode 时 true=输出 gzip */
  gzip?: boolean;
};

/**
 * Protobuf 消息编解码对象（基于 @bufbuild/protobuf）。
 */
export class ProtobufCodec {
  private static readonly logger = new Logger("ProtobufCodec");

  /**
   * 解码 flags 位掩码。
   * @param schema - 输入：`Desc` — Protobuf schema
   * @param input - 输入：`ArrayBuffer | Uint8Array | Buffer` — 原始输入
   * @param options - 输入：`undefined | CodecOptions` — 配置选项
   * @returns 输出：`MessageShape` — MessageShape 实例
   */

  decode<Desc extends DescMessage>(
    schema: Desc,
    input: BytesLike,
    options?: CodecOptions,
  ): MessageShape<Desc> {
    return ProtobufCodec.logger.measureSync(
      "decode",
      () => {
        const raw =
          options?.gzip === false
            ? gzipCodec.toUint8Array(input)
            : gzipCodec.gunzipIfNeeded(input);
        ProtobufCodec.logger.debug("protobuf 解码", { bytes: raw.length, type: schema.typeName });
        return fromBinary(schema, raw);
      },
      { type: schema.typeName },
    );
  }

  /**
   * 编码。
   * @param schema - 输入：`Desc` — Protobuf schema
   * @param message - 输入：`MessageInitShape | MessageShape` — 日志消息
   * @param options - 输入：`undefined | CodecOptions` — 配置选项
   * @returns 输出：`Uint8Array` — 字节数组
   */

  encode<Desc extends DescMessage>(
    schema: Desc,
    message: MessageInitShape<Desc> | MessageShape<Desc>,
    options?: CodecOptions,
  ): Uint8Array {
    return ProtobufCodec.logger.measureSync(
      "encode",
      () => {
        const msg = isMessage(message, schema)
          ? message
          : create(schema, message as MessageInitShape<Desc>);
        const bytes = toBinary(schema, msg);
        ProtobufCodec.logger.debug("protobuf 编码", { bytes: bytes.length, type: schema.typeName });
        return options?.gzip ? gzipCodec.gzipBytes(bytes) : bytes;
      },
      { type: schema.typeName },
    );
  }

  /**
   * 执行 forSchema。
   * @param schema - 输入：`Desc` — Protobuf schema
   * @returns 输出：`__object` — __object 实例
   */

  forSchema<Desc extends DescMessage>(schema: Desc) {
    return {
      create: (init?: MessageInitShape<Desc>) => create(schema, init),
      decode: (input: BytesLike, options?: CodecOptions) => this.decode(schema, input, options),
      encode: (message: MessageInitShape<Desc> | MessageShape<Desc>, options?: CodecOptions) =>
        this.encode(schema, message, options),
    };
  }
}

export const protobufCodec = new ProtobufCodec();
