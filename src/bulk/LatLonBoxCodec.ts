import { LatLonBox } from "./LatLonBox.js";
import { Logger } from "../core/Logger.js";

/**
 * 八分体路径 ↔ LatLonBox 转换对象。
 */
export class LatLonBoxCodec {
  private static readonly logger = new Logger("LatLonBoxCodec");
  private readonly firstBox: Record<string, LatLonBox> = {
    "": new LatLonBox(90, -90, -180, 180),
    "0": new LatLonBox(0, -90, -180, 0),
    "1": new LatLonBox(0, -90, 0, 180),
    "2": new LatLonBox(90, 0, -180, 0),
    "3": new LatLonBox(90, 0, 0, 180),
    "02": new LatLonBox(0, -90, -180, -90),
    "03": new LatLonBox(0, -90, -90, 0),
    "12": new LatLonBox(0, -90, 0, 90),
    "13": new LatLonBox(0, -90, 90, 180),
    "20": new LatLonBox(90, 0, -180, -90),
    "21": new LatLonBox(90, 0, -90, 0),
    "30": new LatLonBox(90, 0, 0, 90),
    "31": new LatLonBox(90, 0, 90, 180),
  };

  /**
   * 八分体路径转经纬度包围盒。
   * @param octantPath - 输入：`string` — 八分体路径
   * @returns 输出：`LatLonBox` — 北南东西边界
   * @throws {Error} 条件不满足或 I/O 失败时
   */

  fromOctantPath(octantPath: string): LatLonBox {
    return LatLonBoxCodec.logger.measureSync(
      "fromOctantPath",
      () => {
        const key = octantPath.length >= 2 ? octantPath.slice(0, 2) : octantPath;
        let box = this.firstBox[key];
        if (!box) {
          throw new Error(`No first LatLonBox for octant prefix "${key}"`);
        }
        for (const oct of octantPath.slice(2)) {
          box = box.getChild(oct);
        }
        return box;
      },
      { octantPath },
    );
  }
}

export const latLonBoxCodec = new LatLonBoxCodec();
