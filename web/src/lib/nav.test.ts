import { test } from "node:test";
import assert from "node:assert/strict";
import { teployNav } from "./nav.server.js";

// Teploy Cloud joins the switcher once TEPLOY_NAV_CLOUD_URL is set.
test("cloud appears in the switcher only when its URL is configured", () => {
  const prev = process.env.TEPLOY_NAV_CLOUD_URL;
  try {
    delete process.env.TEPLOY_NAV_CLOUD_URL;
    assert.equal(teployNav("ship").apps.some((a) => a.key === "cloud"), false);
    process.env.TEPLOY_NAV_CLOUD_URL = "https://cloud.teploy.com";
    const cloud = teployNav("ship").apps.find((a) => a.key === "cloud");
    assert.deepEqual(cloud, { key: "cloud", label: "Cloud", url: "https://cloud.teploy.com" });
  } finally {
    if (prev === undefined) delete process.env.TEPLOY_NAV_CLOUD_URL;
    else process.env.TEPLOY_NAV_CLOUD_URL = prev;
  }
});
