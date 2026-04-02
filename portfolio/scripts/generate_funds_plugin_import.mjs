import { writeFile } from "node:fs/promises";
import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import {
  buildFundsPluginPayload,
  resolveFundsPluginImportPath
} from "./lib/funds_plugin_payload.mjs";

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    result[key] = next ?? "";
    index += 1;
  }

  return result;
}

const options = parseArgs(process.argv.slice(2));
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const outputPath = resolveFundsPluginImportPath(options);
const config = await buildFundsPluginPayload(options);

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      accountId,
      portfolioRoot,
      outputPath,
      funds: config.fundListM.length
    },
    null,
    2
  )
);
