import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

import { fetchExchangeQuotes, normalizeExchangeQuoteCode } from "./lib/exchange_quotes.mjs";
import {
  buildPortfolioPath,
  portfolioUsersRoot,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { buildExchangeDashboardRow } from "./lib/exchange_dashboard_row.mjs";
import { loadCanonicalPortfolioState } from "./lib/portfolio_state_view.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 8767;
const defaultRefreshMs = 15_000;
const cacheTtlMs = 8_000;

let activePortfolioRoot = resolvePortfolioRoot();
let activeAccountId = resolveAccountId();
const cachedPayloads = new Map();
const inflightPayloadPromises = new Map();

function parseArgs(argv) {
  const result = {
    host: defaultHost,
    port: defaultPort,
    refreshMs: defaultRefreshMs,
    open: false
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

  result.port = Number(result.port) || defaultPort;
  result.refreshMs = Number(result.refreshMs) || defaultRefreshMs;
  result.open = Boolean(result.open);
  return result;
}

function round(value, digits = 2) {
  return Number(Number(value ?? 0).toFixed(digits));
}

function toNumberOrNull(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round(numeric, digits) : null;
}

async function readJson(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

function formatAccountLabel(accountId) {
  if (accountId === "main") {
    return "主账户";
  }
  if (accountId === "wenge") {
    return "文哥账户";
  }
  return `${accountId} 账户`;
}

async function listAvailableAccounts() {
  const accounts = [
    {
      id: "main",
      label: formatAccountLabel("main")
    }
  ];

  try {
    const entries = await readdir(portfolioUsersRoot, { withFileTypes: true });
    const userDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "zh-CN"));

    for (const accountId of userDirs) {
      accounts.push({
        id: accountId,
        label: formatAccountLabel(accountId)
      });
    }
  } catch {
    return accounts;
  }

  return accounts;
}

function pickValidAccountId(requestedAccountId, availableAccounts, fallbackAccountId = activeAccountId) {
  const normalized = resolveAccountId({ user: requestedAccountId || fallbackAccountId });
  const available = new Set(availableAccounts.map((item) => item.id));
  return available.has(normalized) ? normalized : fallbackAccountId;
}

function buildAssetLookup(assetMaster) {
  const lookup = new Map();
  for (const asset of assetMaster?.assets ?? []) {
    const keys = [asset?.symbol, asset?.ticker, asset?.name];
    for (const key of keys) {
      const normalized = String(key ?? "").trim();
      if (normalized) {
        lookup.set(normalized, asset);
      }
    }
  }
  return lookup;
}

function resolveAssetConfig(position, assetLookup) {
  const candidates = [position?.symbol, position?.ticker, position?.code, position?.name];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim();
    if (normalized && assetLookup.has(normalized)) {
      return assetLookup.get(normalized);
    }
  }
  return null;
}

async function buildExchangePayload(refreshMs, requestedAccountId) {
  const availableAccounts = await listAvailableAccounts();
  const accountId = pickValidAccountId(requestedAccountId, availableAccounts, activeAccountId);
  const portfolioRoot = resolvePortfolioRoot({ user: accountId });
  const assetMasterPath = buildPortfolioPath(portfolioRoot, "config/asset_master.json");
  const [latestView, assetMaster] = await Promise.all([
    loadCanonicalPortfolioState({ portfolioRoot }),
    readJson(assetMasterPath)
  ]);
  const latest = latestView.payload;

  const assetLookup = buildAssetLookup(assetMaster);
  const exchangePositions = (latest?.positions ?? [])
    .filter((item) => item?.status === "active" && item?.execution_type === "EXCHANGE")
    .sort((left, right) => Number(right?.amount ?? 0) - Number(left?.amount ?? 0));

  const quoteMap = await fetchExchangeQuotes(
    exchangePositions.map((item) => item?.ticker ?? item?.symbol ?? item?.code).filter(Boolean)
  );

  const rows = exchangePositions.map((position) => {
    const assetConfig = resolveAssetConfig(position, assetLookup);
    const quoteKey = normalizeExchangeQuoteCode(position?.ticker ?? position?.symbol ?? position?.code);
    return buildExchangeDashboardRow(position, assetConfig, quoteMap.get(quoteKey) ?? null);
  });

  const investedRows = rows.filter((row) => row.positionState === "invested");

  return {
    generatedAt: new Date().toISOString(),
    accountId,
    accountLabel: formatAccountLabel(accountId),
    portfolioRoot,
    availableAccounts,
    refreshMs,
    snapshotDate: latest?.snapshot_date ?? null,
    summary: {
      totalMarketValue: toNumberOrNull(rows.reduce((sum, row) => sum + Number(row?.marketValue ?? 0), 0)),
      totalUnrealizedPnl: toNumberOrNull(rows.reduce((sum, row) => sum + Number(row?.unrealizedPnl ?? 0), 0)),
      estimatedDailyPnl: toNumberOrNull(
        rows
          .filter((row) => row?.isComparableToday === true)
          .reduce((sum, row) => sum + Number(row?.dailyPnl ?? 0), 0)
      ),
      exchangeAssetCount: rows.length,
      investedAssetCount: investedRows.length,
      quoteAvailableCount: rows.filter((row) => row.quoteAvailable).length
    },
    rows
  };
}

async function getExchangePayload(refreshMs, requestedAccountId, force = false) {
  const availableAccounts = await listAvailableAccounts();
  const accountId = pickValidAccountId(requestedAccountId, availableAccounts, activeAccountId);
  const cacheKey = `${accountId}:exchange`;
  const now = Date.now();
  const cachedEntry = cachedPayloads.get(cacheKey);

  if (!force && cachedEntry && now - cachedEntry.cachedAt < cacheTtlMs) {
    return cachedEntry.payload;
  }

  if (!force && inflightPayloadPromises.has(cacheKey)) {
    return inflightPayloadPromises.get(cacheKey);
  }

  const inflightPayloadPromise = buildExchangePayload(refreshMs, accountId)
    .then((payload) => {
      cachedPayloads.set(cacheKey, {
        payload,
        cachedAt: Date.now()
      });
      return payload;
    })
    .finally(() => {
      inflightPayloadPromises.delete(cacheKey);
    });

  inflightPayloadPromises.set(cacheKey, inflightPayloadPromise);
  return inflightPayloadPromise;
}

function htmlPage({ refreshMs, initialAccountId, availableAccounts }) {
  const optionHtml = availableAccounts
    .map(
      (item) =>
        `<option value="${item.id}"${item.id === initialAccountId ? " selected" : ""}>${item.label}</option>`
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>场内持仓看板</title>
    <style>
      :root {
        --bg: #f2f5f9;
        --panel: rgba(255, 255, 255, 0.94);
        --line: rgba(15, 23, 42, 0.1);
        --ink: #17212b;
        --muted: #64748b;
        --up: #d33f49;
        --down: #1f8b4c;
        --accent: #1d4ed8;
        --shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "SF Pro Display", "PingFang SC", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(29, 78, 216, 0.12), transparent 28%),
          linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
      }

      .shell {
        width: min(96vw, 1080px);
        margin: 18px auto;
      }

      .window {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
        overflow: hidden;
      }

      .topbar {
        padding: 18px 18px 14px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.95), rgba(245, 248, 252, 0.95));
      }

      .eyebrow {
        font-size: 11px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--muted);
      }

      h1 {
        margin: 6px 0 8px;
        font-size: 28px;
        line-height: 1;
      }

      .subline {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }

      .toolbar {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        margin-top: 14px;
        flex-wrap: wrap;
      }

      .toolbar-left {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }

      .status {
        font-size: 12px;
        color: var(--muted);
      }

      .account-picker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid rgba(29, 78, 216, 0.12);
        background: rgba(255, 255, 255, 0.85);
        color: var(--muted);
        font-size: 12px;
        font-weight: 600;
      }

      .account-picker select {
        border: 0;
        background: transparent;
        color: var(--ink);
        font-size: 12px;
        font-weight: 700;
        outline: none;
        cursor: pointer;
      }

      .btn {
        border: 1px solid rgba(29, 78, 216, 0.14);
        background: rgba(29, 78, 216, 0.08);
        color: var(--accent);
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }

      .btn:hover {
        background: rgba(29, 78, 216, 0.12);
      }

      .summary {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 10px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--line);
      }

      .metric {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 12px;
        background: rgba(255, 255, 255, 0.72);
      }

      .metric-label {
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 6px;
      }

      .metric-value {
        font-size: 18px;
        font-weight: 700;
      }

      .table-wrap {
        max-height: min(74vh, 860px);
        overflow: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      thead th {
        position: sticky;
        top: 0;
        background: rgba(248, 251, 255, 0.96);
        z-index: 1;
        font-size: 12px;
        font-weight: 700;
        color: var(--muted);
        text-align: right;
        padding: 12px 10px;
        border-bottom: 1px solid var(--line);
        white-space: nowrap;
      }

      thead th:first-child,
      tbody td:first-child {
        text-align: left;
      }

      tbody tr {
        border-bottom: 1px solid rgba(15, 23, 42, 0.06);
      }

      tbody tr:hover {
        background: rgba(29, 78, 216, 0.03);
      }

      tbody td {
        padding: 12px 10px;
        text-align: right;
        vertical-align: middle;
        font-size: 13px;
      }

      .asset-name {
        font-weight: 700;
        line-height: 1.35;
      }

      .asset-sub {
        color: var(--muted);
        font-size: 11px;
        margin-top: 3px;
      }

      .up {
        color: var(--up);
      }

      .down {
        color: var(--down);
      }

      .flat {
        color: var(--muted);
      }

      .warn {
        color: #b45309;
      }

      .empty {
        padding: 24px 18px 30px;
        color: var(--muted);
        text-align: center;
      }

      .footer {
        padding: 12px 18px 16px;
        font-size: 12px;
        color: var(--muted);
        border-top: 1px solid var(--line);
      }

      @media (max-width: 840px) {
        .summary {
          grid-template-columns: 1fr 1fr;
        }

        .shell {
          width: 100vw;
          margin: 0;
        }

        .window {
          border-radius: 0;
          border-left: 0;
          border-right: 0;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="window">
        <div class="topbar">
          <div class="eyebrow">Exchange Live View</div>
          <h1>场内持仓看板</h1>
          <div class="subline">当前账户：<span id="accountLabel">${formatAccountLabel(initialAccountId)}</span>。这里只读取 <code>execution_type = EXCHANGE</code> 的仓位，行情走 go-stock 风格的证券报价链路，不再复用基金估值接口。</div>
          <div class="toolbar">
            <div class="toolbar-left">
              <label class="account-picker">
                <span>账户</span>
                <select id="accountSelect">${optionHtml}</select>
              </label>
              <div class="status" id="status">准备连接场内行情链路...</div>
            </div>
            <button class="btn" id="refreshBtn" type="button">立即刷新</button>
          </div>
        </div>

        <div class="summary">
          <div class="metric">
            <div class="metric-label">场内市值</div>
            <div class="metric-value" id="totalMarketValue">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">浮动盈亏</div>
            <div class="metric-value" id="totalUnrealizedPnl">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">估算日盈亏</div>
            <div class="metric-value" id="estimatedDailyPnl">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">场内标的数</div>
            <div class="metric-value" id="exchangeAssetCount">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">有行情覆盖</div>
            <div class="metric-value" id="quoteAvailableCount">--</div>
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>证券名称</th>
                <th>最新价</th>
                <th>持仓股数</th>
                <th>可卖股数</th>
                <th>持仓市值</th>
                <th>成本价</th>
                <th>浮动盈亏</th>
                <th>日涨跌/日盈亏</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody id="rows"></tbody>
          </table>
        </div>

        <div class="empty" id="empty" hidden>正在加载场内行情...</div>
        <div class="footer">默认每 ${Math.round(refreshMs / 1000)} 秒自动刷新一次；每次刷新都会读取 <code>state/portfolio_state.json</code> 的场内仓位，再拉取实时证券报价；<code>latest.json</code> 仅保留兼容展示用途。</div>
      </div>
    </div>

    <script>
      const config = {
        refreshMs: ${JSON.stringify(refreshMs)},
        currentAccount: ${JSON.stringify(initialAccountId)},
        availableAccounts: ${JSON.stringify(availableAccounts)}
      };
      const elements = {
        status: document.getElementById("status"),
        accountLabel: document.getElementById("accountLabel"),
        accountSelect: document.getElementById("accountSelect"),
        totalMarketValue: document.getElementById("totalMarketValue"),
        totalUnrealizedPnl: document.getElementById("totalUnrealizedPnl"),
        estimatedDailyPnl: document.getElementById("estimatedDailyPnl"),
        exchangeAssetCount: document.getElementById("exchangeAssetCount"),
        quoteAvailableCount: document.getElementById("quoteAvailableCount"),
        rows: document.getElementById("rows"),
        empty: document.getElementById("empty"),
        refreshBtn: document.getElementById("refreshBtn")
      };

      let loading = false;

      function formatCurrency(value) {
        if (!Number.isFinite(Number(value))) {
          return "--";
        }
        return new Intl.NumberFormat("zh-CN", {
          style: "currency",
          currency: "CNY",
          maximumFractionDigits: 2
        }).format(Number(value));
      }

      function formatSignedCurrency(value) {
        if (!Number.isFinite(Number(value))) {
          return "--";
        }
        const number = Number(value);
        const formatted = formatCurrency(Math.abs(number));
        if (number > 0) {
          return "+" + formatted;
        }
        if (number < 0) {
          return "-" + formatted;
        }
        return formatted;
      }

      function formatPrice(value) {
        if (!Number.isFinite(Number(value))) {
          return "--";
        }
        return Number(value).toFixed(4);
      }

      function formatShares(value) {
        if (!Number.isFinite(Number(value))) {
          return "--";
        }
        return new Intl.NumberFormat("zh-CN", {
          maximumFractionDigits: 0
        }).format(Number(value));
      }

      function formatSignedPercent(value) {
        if (!Number.isFinite(Number(value))) {
          return "--";
        }
        const number = Number(value).toFixed(2);
        return (Number(value) > 0 ? "+" : "") + number + "%";
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function toneClass(value) {
        if (!Number.isFinite(Number(value))) {
          return "flat";
        }
        if (Number(value) > 0) {
          return "up";
        }
        if (Number(value) < 0) {
          return "down";
        }
        return "flat";
      }

      function syncAccountOptions(accounts) {
        if (!Array.isArray(accounts) || accounts.length === 0) {
          return;
        }

        const currentOptions = Array.from(elements.accountSelect.options).map((option) => option.value);
        const nextOptions = accounts.map((item) => item.id);
        const changed =
          currentOptions.length !== nextOptions.length ||
          currentOptions.some((value, index) => value !== nextOptions[index]);

        if (changed) {
          elements.accountSelect.innerHTML = accounts
            .map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + '</option>')
            .join("");
        }

        config.availableAccounts = accounts;
        elements.accountSelect.value = config.currentAccount;
      }

      function updateAccountUrl(accountId) {
        const url = new URL(window.location.href);
        url.searchParams.set("account", accountId);
        window.history.replaceState(null, "", url);
      }

      function render(payload) {
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const accountId = payload?.accountId ?? config.currentAccount;
        const accountLabel = payload?.accountLabel ?? accountId;
        syncAccountOptions(payload?.availableAccounts ?? config.availableAccounts);
        config.currentAccount = accountId;
        elements.accountSelect.value = accountId;
        elements.accountLabel.textContent = accountLabel;
        elements.totalMarketValue.textContent = formatCurrency(payload?.summary?.totalMarketValue);
        elements.totalUnrealizedPnl.textContent = formatSignedCurrency(payload?.summary?.totalUnrealizedPnl);
        elements.totalUnrealizedPnl.className = "metric-value " + toneClass(payload?.summary?.totalUnrealizedPnl);
        elements.estimatedDailyPnl.textContent = formatSignedCurrency(payload?.summary?.estimatedDailyPnl);
        elements.estimatedDailyPnl.className = "metric-value " + toneClass(payload?.summary?.estimatedDailyPnl);
        elements.exchangeAssetCount.textContent = String(payload?.summary?.exchangeAssetCount ?? "--");
        elements.quoteAvailableCount.textContent =
          String(payload?.summary?.quoteAvailableCount ?? "--") + "/" + String(payload?.summary?.exchangeAssetCount ?? "--");

        if (rows.length === 0) {
          elements.rows.innerHTML = "";
          elements.empty.hidden = false;
          elements.empty.textContent = "当前没有 active 场内仓位。";
          return;
        }

        elements.empty.hidden = true;
        elements.rows.innerHTML = rows
          .map((row) => {
            const meta = [
              row.symbol,
              row.category,
              row.settlementRule,
              Number.isFinite(Number(row.lotSize)) ? row.lotSize + "股/手" : null,
              row.signalProxySymbol ? "信号代理 " + row.signalProxySymbol : null,
              row.positionState === "shell" ? "空仓壳位" : null
            ]
              .filter(Boolean)
              .join(" · ");

            const dayCell = [
              '<div class="' + toneClass(row.changePercent) + '">' + escapeHtml(formatSignedPercent(row.changePercent)) + "</div>",
              '<div class="asset-sub ' + toneClass(row.dailyPnl) + '">' + escapeHtml(formatSignedCurrency(row.dailyPnl)) + "</div>"
            ].join("");
            const quoteMeta = row?.marketNote
              ? '<div class="asset-sub warn">' + escapeHtml(row.marketNote) + "</div>"
              : "";

            return (
              "<tr>" +
                "<td>" +
                  '<div class="asset-name">' + escapeHtml(row.name) + "</div>" +
                  '<div class="asset-sub">' + escapeHtml(meta || "--") + "</div>" +
                "</td>" +
                '<td class="' + toneClass(row.changePercent) + '">' + escapeHtml(formatPrice(row.lastPrice)) + "</td>" +
                "<td>" + escapeHtml(formatShares(row.shares)) + "</td>" +
                "<td>" + escapeHtml(formatShares(row.sellableShares)) + "</td>" +
                "<td>" + escapeHtml(formatCurrency(row.marketValue)) + "</td>" +
                "<td>" + escapeHtml(formatPrice(row.costPrice)) + "</td>" +
                "<td>" +
                  '<div class="' + toneClass(row.unrealizedPnl) + '">' + escapeHtml(formatSignedCurrency(row.unrealizedPnl)) + "</div>" +
                  '<div class="asset-sub ' + toneClass(row.unrealizedPnlPct) + '">' + escapeHtml(formatSignedPercent(row.unrealizedPnlPct)) + "</div>" +
                "</td>" +
                "<td>" + dayCell + "</td>" +
                '<td class="' + (row.quoteAvailable ? "flat" : "warn") + '">' +
                  '<div>' + escapeHtml(row.quoteTimestamp ?? "无行情") + "</div>" +
                  quoteMeta +
                "</td>" +
              "</tr>"
            );
          })
          .join("");
      }

      async function refreshData(manual) {
        if (loading) {
          return;
        }

        loading = true;
        elements.status.textContent = manual ? "手动刷新中..." : "正在刷新场内行情...";

        try {
          const url = new URL("/api/live-exchange", window.location.origin);
          url.searchParams.set("ts", String(Date.now()));
          url.searchParams.set("account", config.currentAccount);
          const response = await fetch(url, {
            cache: "no-store"
          });

          if (!response.ok) {
            throw new Error("HTTP " + response.status);
          }

          const payload = await response.json();
          render(payload);
          const generatedAt = new Date(payload.generatedAt);
          const timeText = Number.isFinite(generatedAt.getTime())
            ? generatedAt.toLocaleString("zh-CN", { hour12: false })
            : payload.generatedAt;
          elements.status.textContent =
            "已更新 " +
            timeText +
            " · " +
            Math.round(config.refreshMs / 1000) +
            " 秒自动刷新 · 行情覆盖 " +
            String(payload?.summary?.quoteAvailableCount ?? 0) +
            "/" +
            String(payload?.summary?.exchangeAssetCount ?? 0);
        } catch (error) {
          elements.status.textContent = "刷新失败：" + String(error?.message ?? error);
          if (!elements.rows.innerHTML) {
            elements.empty.hidden = false;
            elements.empty.textContent = "场内行情拉取失败，请稍后重试。";
          }
        } finally {
          loading = false;
        }
      }

      elements.accountSelect.addEventListener("change", (event) => {
        config.currentAccount = event.target.value;
        updateAccountUrl(config.currentAccount);
        refreshData(true);
      });
      elements.refreshBtn.addEventListener("click", () => refreshData(true));
      updateAccountUrl(config.currentAccount);
      refreshData(false);
      window.setInterval(() => refreshData(false), config.refreshMs);
    </script>
  </body>
</html>`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

async function maybeOpenBrowser(url, shouldOpen) {
  if (!shouldOpen) {
    return;
  }

  spawn("open", [url], {
    detached: true,
    stdio: "ignore"
  }).unref();
}

const args = parseArgs(process.argv.slice(2));
activePortfolioRoot = resolvePortfolioRoot(args);
activeAccountId = resolveAccountId(args);

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${args.host}:${args.port}`);

  try {
    if (requestUrl.pathname === "/api/live-exchange") {
      const force = requestUrl.searchParams.get("force") === "1";
      const requestedAccountId = requestUrl.searchParams.get("account") || activeAccountId;
      const payload = await getExchangePayload(args.refreshMs, requestedAccountId, force);
      sendJson(response, 200, payload);
      return;
    }

    if (requestUrl.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      const availableAccounts = await listAvailableAccounts();
      const initialAccountId = pickValidAccountId(
        requestUrl.searchParams.get("account"),
        availableAccounts,
        activeAccountId
      );
      sendHtml(
        response,
        htmlPage({
          refreshMs: args.refreshMs,
          initialAccountId,
          availableAccounts
        })
      );
      return;
    }

    sendJson(response, 404, {
      error: "not_found",
      path: requestUrl.pathname
    });
  } catch (error) {
    sendJson(response, 500, {
      error: "exchange_live_dashboard_failed",
      message: String(error?.message ?? error)
    });
  }
});

server.on("error", (error) => {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        host: args.host,
        port: args.port,
        error: String(error?.message ?? error)
      },
      null,
      2
    )
  );
  process.exit(1);
});

server.listen(args.port, args.host, async () => {
  const url = `http://${args.host}:${args.port}`;
  await maybeOpenBrowser(url, args.open);
  console.log(
    JSON.stringify(
      {
        status: "listening",
        accountId: activeAccountId,
        portfolioRoot: activePortfolioRoot,
        host: args.host,
        port: args.port,
        url,
        refreshMs: args.refreshMs
      },
      null,
      2
    )
  );
});
