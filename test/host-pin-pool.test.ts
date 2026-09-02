import assert from "node:assert/strict";
import { test } from "node:test";

import { HostPinPool, parseKhGoogleYaml } from "../src/fetch/HostPinPool.js";

const SAMPLE_YAML = `
ipv4:
  - ip: 1.1.1.1
    city: A
  - ip: 2.2.2.2
    city: B
ipv6:
  - ip: 2001:db8::1
    city: C
`;

test("parseKhGoogleYaml 解析 ipv4 与 ipv6", () => {
  const parsed = parseKhGoogleYaml(SAMPLE_YAML);
  assert.equal(parsed.ipv4.length, 2);
  assert.equal(parsed.ipv6.length, 1);
  assert.equal(parsed.all.length, 3);
  assert.equal(parsed.ipv4[0]?.ip, "1.1.1.1");
  assert.equal(parsed.ipv6[0]?.ip, "2001:db8::1");
});

test("HostPinPool 轮询 IP", () => {
  const pool = new HostPinPool({
    hostname: "kh.google.com",
    ips: ["1.1.1.1", "2.2.2.2", "2001:db8::1"],
  });

  assert.equal(pool.nextIp(), "1.1.1.1");
  assert.equal(pool.nextIp(), "2.2.2.2");
  assert.equal(pool.nextIp(), "2001:db8::1");
  assert.equal(pool.nextIp(), "1.1.1.1");
});

test("HostPinPool.resolveForUrl 仅匹配配置域名", () => {
  const pool = new HostPinPool({ hostname: "kh.google.com", ips: ["9.9.9.9"] });

  const hit = pool.resolveForUrl("https://kh.google.com/rt/earth/PlanetoidMetadata");
  assert.ok(hit);
  assert.equal(hit.pinnedIp, "9.9.9.9");
  assert.deepEqual(hit.dns.hosts?.["kh.google.com"], ["9.9.9.9"]);

  assert.equal(pool.resolveForUrl("https://example.com/"), undefined);
});

test("HostPinPool 加载 kh.google.com.yaml", () => {
  const pool = new HostPinPool({
    hostname: "kh.google.com",
    yamlPath: "config/kh.google.com.yaml",
  });
  const size = pool.size();
  assert.ok(size >= 3000, `expected 3000+ IPs, got ${size}`);
});
