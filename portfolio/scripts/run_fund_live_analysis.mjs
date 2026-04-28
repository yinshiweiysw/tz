#!/usr/bin/env node
import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import {
  persistFundLiveAnalysisSnapshot,
  runFundLiveAnalysis
} from "./lib/fund_live_analyzer.mjs";

function parseArgs(argv) {
  const result = {
    mode: "live",
    scope: "deep_dive"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
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
  const portfolioRoot = resolvePortfolioRoot({ user: accountId, portfolioRoot: args["portfolio-root"] });
  const snapshot = await runFundLiveAnalysis({
    portfolioRoot,
    accountId,
    mode: String(args.mode ?? "live"),
    scope: String(args.scope ?? "deep_dive"),
    limit: args.limit === undefined ? null : Number(args.limit)
  });
  const outputPath = await persistFundLiveAnalysisSnapshot({
    portfolioRoot,
    snapshot
  });
  const result = {
    portfolioRoot,
    accountId,
    outputPath,
    snapshot
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
