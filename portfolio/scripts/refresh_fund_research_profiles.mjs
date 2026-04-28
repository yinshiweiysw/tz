#!/usr/bin/env node
import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { refreshFundResearchProfiles } from "./lib/fund_research_profile_refresh.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const accountId = resolveAccountId(args.user ?? args.account ?? "main");
  const portfolioRoot = resolvePortfolioRoot({
    user: accountId,
    portfolioRoot: args["portfolio-root"] ?? args.portfolioRoot
  });
  const result = await refreshFundResearchProfiles({
    portfolioRoot,
    limit: Number(args.limit ?? 0) || 0
  });
  const output = {
    accountId,
    portfolioRoot,
    outputPath: result.outputPath,
    syncStatus: result.payload.syncStatus
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
