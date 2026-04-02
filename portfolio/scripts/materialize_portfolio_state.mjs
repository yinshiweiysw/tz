import { resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import {
  formatShanghaiDate,
  materializePortfolioRoot
} from "./lib/portfolio_state_materializer.mjs";

function parseArgs(argv) {
  const result = {
    date: "",
    user: "",
    portfolioRoot: "",
    seedMissing: true
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
      result[camelize(key)] = true;
      continue;
    }

    result[key] = next;
    result[camelize(key)] = next;
    index += 1;
  }

  if (String(result["seed-missing"] ?? "").trim()) {
    result.seedMissing = String(result["seed-missing"]).trim() !== "false";
  }

  return result;
}

const options = parseArgs(process.argv.slice(2));
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const referenceDate = String(options.date ?? "").trim() || formatShanghaiDate();
const result = await materializePortfolioRoot({
  portfolioRoot,
  accountId,
  referenceDate,
  seedMissing: options.seedMissing !== false
});

console.log(
  JSON.stringify(
    {
      accountId,
      portfolioRoot,
      referenceDate,
      paths: result.paths,
      ensuredChanges: result.ensuredChanges,
      stats: result.stats
    },
    null,
    2
  )
);
