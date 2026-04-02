import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import {
  buildDualLedgerPaths,
  formatShanghaiDate,
  materializePortfolioRoot
} from "./lib/portfolio_state_materializer.mjs";

function parseArgs(argv) {
  const result = {
    date: "",
    user: "",
    portfolioRoot: ""
  };
  const camelize = (key) => key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

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
    result[camelize(key)] = next;
    index += 1;
  }

  return result;
}

const options = parseArgs(process.argv.slice(2));
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const referenceDate = String(options.date ?? "").trim() || formatShanghaiDate();
const paths = buildDualLedgerPaths(portfolioRoot);
const result = await materializePortfolioRoot({
  portfolioRoot,
  accountId,
  referenceDate,
  seedMissing: true
});

console.log(
  JSON.stringify(
    {
      accountId,
      portfolioRoot,
      referenceDate,
      executionLedgerPath: paths.executionLedgerPath,
      portfolioStatePath: paths.portfolioStatePath,
      compatibilityLatestPath: paths.latestCompatPath,
      ensuredChanges: result.ensuredChanges,
      stats: result.stats
    },
    null,
    2
  )
);
