import test from "node:test";
import assert from "node:assert/strict";

import { collectEnabledFundCodes } from "./reconcile_confirmed_nav.mjs";

test("collectEnabledFundCodes unions watchlist codes with active OTC position codes", () => {
  const rawSnapshot = {
    positions: [
      {
        code: "007339",
        status: "active",
        execution_type: "OTC"
      },
      {
        code: "019118",
        status: "active",
        execution_type: "OTC"
      },
      {
        code: "513100",
        status: "active",
        execution_type: "EXCHANGE"
      },
      {
        code: "000001",
        status: "inactive",
        execution_type: "OTC"
      }
    ]
  };
  const watchlist = {
    watchlist: [
      { code: "007339" },
      { code: "021482" }
    ]
  };

  assert.deepEqual(collectEnabledFundCodes({ rawSnapshot, watchlist }), [
    "007339",
    "019118",
    "021482"
  ]);
});
