import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeFundIdentity,
  getFundIdentityAliases
} from "./fund_identity.mjs";

test("canonicalizeFundIdentity upgrades legacy C share class to canonical D share class", () => {
  const canonical = canonicalizeFundIdentity({
    code: "013172",
    name: "华夏恒生互联网科技业ETF联接(QDII)C"
  });

  assert.equal(canonical.code, "023764");
  assert.equal(canonical.name, "华夏恒生互联网科技业ETF联接(QDII)D");
  assert.ok(canonical.aliases.includes("华夏恒生互联网科技业ETF联接(QDII)C"));
});

test("getFundIdentityAliases returns both legacy and canonical fund identities", () => {
  const aliases = getFundIdentityAliases({
    code: "023764",
    name: "华夏恒生互联网科技业ETF联接(QDII)D"
  });

  assert.ok(aliases.some((item) => item.code === "023764"));
  assert.ok(aliases.some((item) => item.code === "013172"));
  assert.ok(
    aliases.some((item) => item.name === "华夏恒生互联网科技业ETF联接(QDII)C")
  );
});
