import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFundFallbackRequestOptions,
  buildFundPrimaryRequestOptions
} from "./fund.js";

test("buildFundPrimaryRequestOptions caps the primary quote request timeout", () => {
  const options = buildFundPrimaryRequestOptions({ Fcodes: "016482,007339" });

  assert.equal(options.timeout, 5000);
  assert.deepEqual(options.params, { Fcodes: "016482,007339" });
});

test("buildFundFallbackRequestOptions caps optional fallback requests to a shorter timeout", () => {
  const options = buildFundFallbackRequestOptions({ rt: 123 }, "text");

  assert.equal(options.timeout, 3000);
  assert.equal(options.responseType, "text");
  assert.deepEqual(options.params, { rt: 123 });
});
