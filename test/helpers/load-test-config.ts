import { GeoClawConfig } from "../../src/core/GeoClawConfig.js";

/**
 * 测试前加载 fixture 配置（可通过 GEOCLAW_CONFIG 覆盖）。
 */
export function loadTestConfig(): void {
  process.env.GEOCLAW_CONFIG ??= "test/fixtures/geoclaw.test.yaml";
  GeoClawConfig.reset();
  GeoClawConfig.load();
}

loadTestConfig();
