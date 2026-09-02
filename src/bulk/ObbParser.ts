import { Logger } from "../core/Logger.js";

export type Vec3 = { x: number; y: number; z: number };
export type Mat3 = { elements: number[] };

export type OBB = {
  center: Vec3;
  extents: Vec3;
  orientation: Mat3;
};

/**
 * 有向包围盒（OBB）解包对象。
 */
export class ObbParser {
  private static readonly logger = new Logger("ObbParser");

  /**
   * 解包 OBB 15 字节。
   * @param packed - 输入：`Uint8Array` — 打包字节
   * @param headNodeCenter - 输入：`number[]` — headNodeCenter 参数
   * @param metersPerTexel - 输入：`number` — metersPerTexel 参数
   * @returns 输出：`OBB` — 中心、半轴、旋转矩阵
   * @throws {Error} 条件不满足或 I/O 失败时
   */

  unpack(
    packed: Uint8Array,
    headNodeCenter: readonly number[],
    metersPerTexel: number,
  ): OBB {
    return ObbParser.logger.measureSync(
      "unpack",
      () => {
        if (packed.length !== 15) {
          ObbParser.logger.error("OBB 长度非法", { length: packed.length });
          throw new Error(`Invalid OBB packed size: ${packed.length} (expected 15)`);
        }
        const cx = headNodeCenter[0] ?? 0;
        const cy = headNodeCenter[1] ?? 0;
        const cz = headNodeCenter[2] ?? 0;

        const center: Vec3 = {
          x: this.readInt16LE(packed, 0) * metersPerTexel + cx,
          y: this.readInt16LE(packed, 2) * metersPerTexel + cy,
          z: this.readInt16LE(packed, 4) * metersPerTexel + cz,
        };

        const extents: Vec3 = {
          x: packed[6]! * metersPerTexel,
          y: packed[7]! * metersPerTexel,
          z: packed[8]! * metersPerTexel,
        };

        const euler: Vec3 = {
          x: this.readUint16LE(packed, 9) * (Math.PI / 32768),
          y: this.readUint16LE(packed, 11) * (Math.PI / 65536),
          z: this.readUint16LE(packed, 13) * (Math.PI / 32768),
        };

        const c0 = Math.cos(euler.x);
        const s0 = Math.sin(euler.x);
        const c1 = Math.cos(euler.y);
        const s1 = Math.sin(euler.y);
        const c2 = Math.cos(euler.z);
        const s2 = Math.sin(euler.z);

        return {
          center,
          extents,
          orientation: {
            elements: [
              c0 * c2 - c1 * s0 * s2,
              c1 * c0 * s2 + c2 * s0,
              s2 * s1,
              -c0 * s2 - c2 * c1 * s0,
              c0 * c1 * c2 - s0 * s2,
              c2 * s1,
              s1 * s0,
              -c0 * s1,
              c1,
            ],
          },
        };
      },
      { packedLength: packed.length, metersPerTexel },
    );
  }

  private readInt16LE(data: Uint8Array, offset: number): number {
    const val = data[offset]! | (data[offset + 1]! << 8);
    return val & 0x8000 ? val | 0xffff0000 : val;
  }

  private readUint16LE(data: Uint8Array, offset: number): number {
    return data[offset]! | (data[offset + 1]! << 8);
  }
}

export const obbParser = new ObbParser();
