import { Logger } from "../core/Logger.js";

export type LatLon = { lat: number; lon: number };

const OCTANT: Record<string, [number, number, number]> = {
  "0": [0, 0, 0],
  "1": [1, 0, 0],
  "2": [0, 1, 0],
  "3": [1, 1, 0],
  "4": [0, 0, 1],
  "5": [1, 0, 1],
  "6": [0, 1, 1],
  "7": [1, 1, 1],
};

/**
 * 经纬度包围盒值对象（对齐 earth-3d LatLonBox）。
 */
export class LatLonBox {
  private static readonly logger = new Logger("LatLonBox");

  /**
   * 构造实例。
   * @param n - 输入：`number` — n 参数
   * @param s - 输入：`number` — s 参数
   * @param w - 输入：`number` — w 参数
   * @param e - 输入：`number` — e 参数
   * @returns 输出：`LatLonBox` — LatLonBox 实例
   */

  constructor(
    public n: number,
    public s: number,
    public w: number,
    public e: number,
  ) {}

  /**
   * 计算包围盒中心点。
   * @returns 输出：`LatLon` — lat 与 lon
   */

  midPoint(): LatLon {
    return LatLonBox.logger.measureSync("midPoint", () => ({
      lat: (this.n + this.s) / 2,
      lon: (this.w + this.e) / 2,
    }));
  }

  /**
   * 按八分体字符取子包围盒。
   * @param octant - 输入：`string` — octant 参数
   * @returns 输出：`LatLonBox` — 北南东西边界
   * @throws {Error} 条件不满足或 I/O 失败时
   */

  getChild(octant: string): LatLonBox {
    return LatLonBox.logger.measureSync(
      "getChild",
      () => {
        const xyz = OCTANT[octant];
        if (!xyz) throw new Error(`Invalid octant: ${octant}`);
        const octX = xyz[0];
        const octY = xyz[1];

        let { n, s, w, e } = this;
        const mid = { lat: (this.n + this.s) / 2, lon: (this.w + this.e) / 2 };

        if (octY === 0) n = mid.lat;
        else if (octY === 1) s = mid.lat;
        else throw new Error("Invalid y");

        if (n === 90 || s === -90) {
          return new LatLonBox(n, s, w, e);
        }

        if (octX === 0) e = mid.lon;
        else if (octX === 1) w = mid.lon;
        else throw new Error("Invalid x");

        return new LatLonBox(n, s, w, e);
      },
      { octant },
    );
  }

  /**
   * 判断两包围盒是否相交。
   * @param a - 输入：`LatLonBox` — a 参数
   * @param b - 输入：`LatLonBox` — b 参数
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  static isOverlapping(a: LatLonBox, b: LatLonBox): boolean {
    return LatLonBox.logger.measureSync("isOverlapping", () => {
      const n = Math.min(a.n, b.n);
      const s = Math.max(a.s, b.s);
      const w = Math.max(a.w, b.w);
      const e = Math.min(a.e, b.e);
      return n >= s && w <= e;
    });
  }
}
