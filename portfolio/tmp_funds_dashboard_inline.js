
      const config = {
        refreshMs: 30000,
        currentAccount: "main",
        availableAccounts: [{"id":"main","label":"主账户"},{"id":"wenge","label":"文哥账户"}],
        currentPayload: null,
        sortMode: loadSortMode(),
        selectedBucket: loadSelectedBucket(),
        summaryCollapsed: loadSummaryCollapsed(),
        pendingCollapsed: loadPanelCollapsed("pendingFold", true)
      };
      const elements = {
        status: document.getElementById("status"),
        accountLabel: document.getElementById("accountLabel"),
        accountSelect: document.getElementById("accountSelect"),
        configHeadlineInline: document.getElementById("configHeadlineInline"),
        summaryBody: document.getElementById("summaryBody"),
        summaryToggleBtn: document.getElementById("summaryToggleBtn"),
        summaryCollapsedNote: document.getElementById("summaryCollapsedNote"),
        totalAssets: document.getElementById("totalAssets"),
        fundMarketValue: document.getElementById("fundMarketValue"),
        fundCountText: document.getElementById("fundCountText"),
        holdingProfit: document.getElementById("holdingProfit"),
        holdingProfitRate: document.getElementById("holdingProfitRate"),
        estimatedDailyPnl: document.getElementById("estimatedDailyPnl"),
        estimatedDailyPnlRate: document.getElementById("estimatedDailyPnlRate"),
        bucketStrip: document.getElementById("bucketStrip"),
        bucketChips: document.getElementById("bucketChips"),
        sortSelect: document.getElementById("sortSelect"),
        holdingsPanel: document.getElementById("holdingsPanel"),
        holdingsSummary: document.getElementById("holdingsSummary"),
        holdingsAsOf: document.getElementById("holdingsAsOf"),
        fundsList: document.getElementById("fundsList"),
        maturedPendingPanel: document.getElementById("maturedPendingPanel"),
        maturedPendingRows: document.getElementById("maturedPendingRows"),
        pendingPanel: document.getElementById("pendingPanel"),
        pendingRows: document.getElementById("pendingRows"),
        pendingFold: document.getElementById("pendingFold"),
        pendingFoldSummary: document.getElementById("pendingFoldSummary"),
        pendingFoldToggle: document.getElementById("pendingFoldToggle"),
        pendingFoldBody: document.getElementById("pendingFoldBody"),
        empty: document.getElementById("empty"),
        refreshBtn: document.getElementById("refreshBtn")
      };

      let loading = false;

      function loadSummaryCollapsed() {
        try {
          return window.localStorage.getItem("funds.dashboard.summaryCollapsed") === "1";
        } catch {}

        return false;
      }

      function saveSummaryCollapsed() {
        try {
          window.localStorage.setItem(
            "funds.dashboard.summaryCollapsed",
            config.summaryCollapsed ? "1" : "0"
          );
        } catch {}
      }

      function loadSortMode() {
        try {
          return window.localStorage.getItem("funds.dashboard.sortMode") || "amount_desc";
        } catch {}

        return "amount_desc";
      }

      function saveSortMode() {
        try {
          window.localStorage.setItem("funds.dashboard.sortMode", String(config.sortMode || "amount_desc"));
        } catch {}
      }

      function loadSelectedBucket() {
        try {
          return window.localStorage.getItem("funds.dashboard.selectedBucket") || "ALL";
        } catch {}

        return "ALL";
      }

      function saveSelectedBucket() {
        try {
          window.localStorage.setItem(
            "funds.dashboard.selectedBucket",
            String(config.selectedBucket || "ALL")
          );
        } catch {}
      }

      function loadPanelCollapsed(key, fallbackValue) {
        try {
          const value = window.localStorage.getItem("funds.dashboard.panel." + key);
          if (value === "1") {
            return true;
          }
          if (value === "0") {
            return false;
          }
        } catch {}

        return fallbackValue;
      }

      function savePanelCollapsed(key, collapsed) {
        try {
          window.localStorage.setItem("funds.dashboard.panel." + key, collapsed ? "1" : "0");
        } catch {}
      }

      function sortBucketGroups(bucketGroups) {
        return bucketGroups.map((group) => ({
          ...group,
          rows: [...(Array.isArray(group?.rows) ? group.rows : [])].sort((left, right) => {
            return Number(right?.amount ?? 0) - Number(left?.amount ?? 0);
          })
        }));
      }

      function getFilteredFundRows(fundRows) {
        if (config.selectedBucket === "ALL") {
          return [...fundRows];
        }

        return fundRows.filter((row) => String(row?.bucketKey ?? "") === config.selectedBucket);
      }

      function getVisibleHoldingRows(fundRows, cashRow) {
        const filteredFunds = getFilteredFundRows(fundRows);
        const sortedFunds = getSortedFundRows(filteredFunds);
        if (config.selectedBucket === "CASH" && cashRow) {
          return [cashRow, ...sortedFunds];
        }
        if (config.selectedBucket === "ALL" && sortedFunds.length === 0 && cashRow) {
          return [cashRow];
        }
        return sortedFunds;
      }

      function getSortedFundRows(fundRows) {
        const rows = [...fundRows];
        switch (config.sortMode) {
          case "estimatedPnl_desc":
            return rows.sort((left, right) => Number(right?.estimatedPnl ?? 0) - Number(left?.estimatedPnl ?? 0));
          case "holdingPnl_asc":
            return rows.sort((left, right) => Number(left?.holdingPnl ?? 0) - Number(right?.holdingPnl ?? 0));
          case "holdingPnl_desc":
            return rows.sort((left, right) => Number(right?.holdingPnl ?? 0) - Number(left?.holdingPnl ?? 0));
          case "amount_desc":
          default:
            return rows.sort((left, right) => Number(right?.amount ?? 0) - Number(left?.amount ?? 0));
        }
      }

      function sortModeLabel(mode) {
        switch (mode) {
          case "estimatedPnl_desc":
            return "按当日收益";
          case "holdingPnl_asc":
            return "按持亏优先";
          case "holdingPnl_desc":
            return "按持盈优先";
          case "amount_desc":
          default:
            return "按市值";
        }
      }

      function renderBucketStrip(bucketGroups, fundRows) {
        if (!bucketGroups.length) {
          elements.bucketStrip.hidden = true;
          elements.bucketChips.innerHTML = "";
          elements.bucketChips.style.removeProperty("--bucket-chip-columns");
          return;
        }

        const validBucketKeys = new Set(bucketGroups.map((group) => String(group?.bucketKey ?? "")));
        if (config.selectedBucket !== "ALL" && !validBucketKeys.has(config.selectedBucket)) {
          config.selectedBucket = "ALL";
          saveSelectedBucket();
        }

        const allAmount = sumNumericValues(fundRows.map((row) => row?.amount));
        const chipsHtml = [
          (
            '<button class="bucket-chip' + (config.selectedBucket === "ALL" ? " active" : "") + '" type="button" data-bucket-filter="ALL">' +
              '<span class="bucket-chip-head">' +
                '<span class="bucket-chip-title">全部</span>' +
                '<span class="bucket-chip-state">筛选关闭</span>' +
              "</span>" +
              '<span class="bucket-chip-meta">' +
                escapeHtml(String(fundRows.length) + "只 · " + formatCurrency(allAmount)) +
              "</span>" +
            "</button>"
          ),
          ...bucketGroups.map((group) => {
            const gapState = bucketGapState(group.currentPct, group.targetPct);
            const active = config.selectedBucket === String(group?.bucketKey ?? "");
            return (
              '<button class="bucket-chip ' + escapeHtml(gapState.tone) + (active ? " active" : "") + '" type="button" data-bucket-filter="' + escapeHtml(String(group?.bucketKey ?? "")) + '">' +
                '<span class="bucket-chip-head">' +
                  '<span class="bucket-chip-title">' + escapeHtml(group.bucketLabel) + "</span>" +
                  '<span class="bucket-chip-state">' + escapeHtml(gapState.label) + "</span>" +
                "</span>" +
                '<span class="bucket-chip-meta">' +
                  escapeHtml(
                    formatPercent(group.currentPct) +
                      " / " +
                      (hasNumericValue(group.targetPct) ? formatPercent(group.targetPct) : "--") +
                      " · " +
                      String(group.fundRowCount ?? 0) +
                      "只"
                  ) +
                "</span>" +
              "</button>"
            );
          })
        ].join("");

        elements.bucketStrip.hidden = false;
        elements.bucketChips.innerHTML = chipsHtml;
        elements.bucketChips.style.setProperty(
          "--bucket-chip-columns",
          String(Math.max(bucketGroups.length + 1, 1))
        );
        elements.sortSelect.value = config.sortMode;
      }

      function renderSummaryCollapsedState() {
        elements.summaryBody.hidden = Boolean(config.summaryCollapsed);
        elements.summaryCollapsedNote.hidden = true;
        elements.summaryToggleBtn.textContent = config.summaryCollapsed ? "展开" : "收起";
      }

      function renderFoldStates() {
        elements.pendingFoldBody.hidden = Boolean(config.pendingCollapsed);
        elements.pendingFoldToggle.textContent = config.pendingCollapsed ? "展开" : "收起";
      }

      function hasNumericValue(value) {
        return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
      }

      function formatCurrency(value) {
        if (!hasNumericValue(value)) {
          return "--";
        }

        return new Intl.NumberFormat("zh-CN", {
          style: "currency",
          currency: "CNY",
          maximumFractionDigits: 2
        }).format(Number(value));
      }

      function formatSignedCurrency(value) {
        if (!hasNumericValue(value)) {
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
        if (!hasNumericValue(value)) {
          return "--";
        }

        return Number(value).toFixed(4);
      }

      function formatSignedPercent(value) {
        if (!hasNumericValue(value)) {
          return "--";
        }

        const number = Number(value).toFixed(2);
        return (Number(value) > 0 ? "+" : "") + number + "%";
      }

      function formatPercent(value) {
        if (!hasNumericValue(value)) {
          return "--";
        }
        return Number(value).toFixed(2) + "%";
      }

      function sumNumericValues(values) {
        return values.reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
      }

      function bucketGapState(currentPct, targetPct) {
        const current = Number(currentPct);
        const target = Number(targetPct);
        if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) {
          return {
            label: "未设目标",
            tone: "balanced"
          };
        }

        const gap = current - target;
        const absGap = Math.abs(gap);
        if (absGap < 0.01) {
          return {
            label: "贴近目标",
            tone: "balanced"
          };
        }

        return {
          label: (gap > 0 ? "超配 " : "低配 ") + formatPercent(absGap),
          tone: gap > 0 ? "over" : "under"
        };
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
        if (!hasNumericValue(value)) {
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

      function buildCashHoldingCard(row) {
        const weightText = hasNumericValue(row.currentWeightPct)
          ? "占组合 " + formatPercent(row.currentWeightPct)
          : "占组合 --";
        const targetText = hasNumericValue(row.bucketTargetPct)
          ? formatPercent(row.bucketTargetPct)
          : "--";
        const cashGapState = bucketGapState(row.currentWeightPct, row.bucketTargetPct);
        const badgesHtml = [row.code, row.bucketLabel ?? "现金", row.category]
          .filter(Boolean)
          .map((part) => '<span class="holding-pill">' + escapeHtml(part) + "</span>")
          .join("");

        return (
          '<div class="all-fund-row">' +
            '<div class="fund-lite-head">' +
              '<div class="all-fund-main">' +
                '<div class="all-fund-name">' + escapeHtml(row.name) + "</div>" +
                '<div class="all-fund-meta">' +
                  badgesHtml +
                  '<span class="holding-time">' + escapeHtml(row.updateTime ?? "账本口径") + "</span>" +
                "</div>" +
              "</div>" +
              '<div class="all-fund-side">' +
                '<div class="all-fund-amount">' + escapeHtml(formatCurrency(row.amount)) + "</div>" +
                '<div class="all-fund-weight">' + escapeHtml(weightText) + "</div>" +
              "</div>" +
            "</div>" +
            '<div class="all-fund-pnl">' +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">现金占比</span>' +
                '<span class="all-fund-pnl-value flat">' + escapeHtml(formatPercent(row.currentWeightPct)) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">现金目标</span>' +
                '<span class="all-fund-pnl-value flat">' + escapeHtml(targetText) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">当前状态</span>' +
                '<span class="all-fund-pnl-value ' + escapeHtml(cashGapState.tone) + '">' + escapeHtml(cashGapState.label) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">资金口径</span>' +
                '<span class="all-fund-pnl-value flat">可用现金</span>' +
              "</div>" +
            "</div>" +
          "</div>'
        );
      }

      function buildFundHoldingCard(row, rowBucketLookup) {
        const key = String(row?.code ?? row?.name ?? "");
        const bucketLabel = rowBucketLookup.get(key) ?? row?.bucketLabel ?? row?.bucket ?? "";
        const badgesHtml = [row.code, bucketLabel, row.category]
          .filter(Boolean)
          .map((part) => '<span class="holding-pill">' + escapeHtml(part) + "</span>")
          .join("");
        const weightText = hasNumericValue(row.currentWeightPct)
          ? "占组合 " + formatPercent(row.currentWeightPct)
          : "占组合 --";

        return (
          '<div class="all-fund-row">' +
            '<div class="fund-lite-head">' +
              '<div class="all-fund-main">' +
                '<div class="all-fund-name">' + escapeHtml(row.name) + "</div>" +
                '<div class="all-fund-meta">' +
                  badgesHtml +
                  '<span class="holding-time">' + escapeHtml(row.updateTime ?? "无估值") + "</span>" +
                "</div>" +
              "</div>" +
              '<div class="all-fund-side">' +
                '<div class="all-fund-amount">' + escapeHtml(formatCurrency(row.amount)) + "</div>" +
                '<div class="all-fund-weight">' + escapeHtml(weightText) + "</div>" +
              "</div>" +
            "</div>" +
            '<div class="all-fund-pnl">' +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">当日收益</span>' +
                '<span class="all-fund-pnl-value ' + toneClass(row.estimatedPnl) + '">' + escapeHtml(formatSignedCurrency(row.estimatedPnl)) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">日涨跌幅</span>' +
                '<span class="all-fund-pnl-value ' + toneClass(row.changePct) + '">' + escapeHtml(formatSignedPercent(row.changePct)) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">持有收益</span>' +
                '<span class="all-fund-pnl-value ' + toneClass(row.holdingPnl) + '">' + escapeHtml(formatSignedCurrency(row.holdingPnl)) + "</span>" +
              "</div>" +
              '<div class="all-fund-pnl-item">' +
                '<span class="all-fund-pnl-label">持有收益率</span>' +
                '<span class="all-fund-pnl-value ' + toneClass(row.holdingPnlRatePct) + '">' + escapeHtml(formatSignedPercent(row.holdingPnlRatePct)) + "</span>" +
              "</div>" +
            "</div>" +
          "</div>'
        );
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
        config.currentPayload = payload;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const fundRows = rows.filter((row) => !row?.isSyntheticCash);
        const cashRow = rows.find((row) => row?.isSyntheticCash) ?? null;
        const bucketGroups = sortBucketGroups(
          Array.isArray(payload?.bucketGroups) ? payload.bucketGroups : []
        )
          .map((group) => {
            const groupRows = Array.isArray(group?.rows) ? group.rows : [];
            const displayRows = groupRows.filter((row) => !row?.isSyntheticCash);
            const syntheticCashCount = groupRows.length - displayRows.length;
            return {
              ...group,
              displayRows,
              fundRowCount: displayRows.length,
              syntheticCashCount
            };
          })
          .filter((group) => group.displayRows.length > 0 || group.syntheticCashCount > 0);
        const pendingRows = Array.isArray(payload?.pendingRows) ? payload.pendingRows : [];
        const maturedPendingRows = Array.isArray(payload?.maturedPendingRows) ? payload.maturedPendingRows : [];
        const rowBucketLookup = new Map();
        for (const group of bucketGroups) {
          for (const row of group.displayRows) {
            const key = String(row?.code ?? row?.name ?? "");
            if (key) {
              rowBucketLookup.set(key, group.bucketLabel);
            }
          }
        }
        const accountId = payload?.accountId ?? config.currentAccount;
        const accountLabel = payload?.accountLabel ?? accountId;
        syncAccountOptions(payload?.availableAccounts ?? config.availableAccounts);
        config.currentAccount = accountId;
        elements.accountSelect.value = accountId;
        elements.accountLabel.textContent = accountLabel;
        renderSummaryCollapsedState();
        renderFoldStates();
        renderBucketStrip(bucketGroups, fundRows);

        const configHeadlineParts = [
          payload?.configuration?.activeProfileLabel,
          hasNumericValue(payload?.configuration?.absoluteEquityCapPct)
            ? "权益上限 " + formatPercent(payload.configuration.absoluteEquityCapPct)
            : "",
          hasNumericValue(payload?.configuration?.maxDrawdownLimitPct)
            ? "回撤目标 " + formatPercent(payload.configuration.maxDrawdownLimitPct)
            : ""
        ].filter(Boolean);
        elements.configHeadlineInline.textContent = configHeadlineParts.join(" · ") || "配置未标注";
        elements.configHeadlineInline.hidden = configHeadlineParts.length === 0;

        elements.totalAssets.textContent = formatCurrency(payload?.summary?.totalPortfolioAssets);
        elements.fundMarketValue.textContent = formatCurrency(payload?.summary?.totalFundAssets);
        elements.fundCountText.textContent =
          String(payload?.summary?.activeFundCount ?? fundRows.length) + " 只基金";
        elements.holdingProfit.textContent = formatSignedCurrency(payload?.summary?.holdingProfit);
        elements.holdingProfit.className =
          "ribbon-value ribbon-value--profit " + toneClass(payload?.summary?.holdingProfit);
        elements.holdingProfitRate.textContent =
          "收益率 " + formatSignedPercent(payload?.summary?.holdingProfitRatePct);
        elements.holdingProfitRate.className =
          "ribbon-sub " + toneClass(payload?.summary?.holdingProfitRatePct);
        elements.estimatedDailyPnl.textContent = formatSignedCurrency(payload?.summary?.estimatedDailyPnl);
        elements.estimatedDailyPnl.className =
          "ribbon-value ribbon-value--profit " + toneClass(payload?.summary?.estimatedDailyPnl);
        elements.estimatedDailyPnlRate.textContent =
          "收益率 " + formatSignedPercent(payload?.summary?.estimatedDailyPnlRatePct);
        elements.estimatedDailyPnlRate.className =
          "ribbon-sub " + toneClass(payload?.summary?.estimatedDailyPnlRatePct);

        const visibleHoldingRows = getVisibleHoldingRows(fundRows, cashRow);
        if (visibleHoldingRows.length > 0) {
          const visibleFundRows = visibleHoldingRows.filter((row) => !row?.isSyntheticCash);
          const cashVisible = visibleHoldingRows.some((row) => row?.isSyntheticCash);
          const visibleHoldingAmount = sumNumericValues(visibleHoldingRows.map((row) => row?.amount));
          const latestQuoteTime =
            payload?.summary?.latestQuoteTime ||
            visibleHoldingRows
              .map((row) => String(row?.updateTime ?? "").trim())
              .filter(Boolean)
              .sort((left, right) => left.localeCompare(right))
              .at(-1) ||
            "暂无盘中估值";
          const activeBucketGroup =
            config.selectedBucket === "ALL"
              ? null
              : bucketGroups.find((group) => String(group?.bucketKey ?? "") === config.selectedBucket) ?? null;
          const holdingsTitle =
            activeBucketGroup?.bucketLabel
              ? activeBucketGroup.bucketLabel +
                " · " +
                (
                  cashVisible
                    ? (visibleFundRows.length > 0 ? String(visibleFundRows.length) + "只基金 + 现金" : "现金头寸")
                    : String(visibleFundRows.length) + "只"
                )
              : "全部基金 · " + String(visibleFundRows.length) + "只";

          elements.holdingsPanel.hidden = false;
          elements.holdingsSummary.textContent =
            holdingsTitle + " · 当前金额 " + formatCurrency(visibleHoldingAmount) + " · " + sortModeLabel(config.sortMode);
          elements.holdingsAsOf.textContent =
            "最新估值 " +
            latestQuoteTime +
            " · 今日更新 " +
            String(payload?.summary?.freshFundCount ?? visibleFundRows.length) +
            (cashVisible ? " 只基金 + 现金" : " 只");

          elements.fundsList.innerHTML = visibleHoldingRows
            .map((row) => row?.isSyntheticCash ? buildCashHoldingCard(row) : buildFundHoldingCard(row, rowBucketLookup))
            .join("");
        } else {
          elements.bucketStrip.hidden = true;
          elements.bucketChips.innerHTML = "";
          elements.holdingsPanel.hidden = true;
          elements.holdingsSummary.textContent = "当前没有 active 基金持仓";
          elements.holdingsAsOf.textContent = "--";
          elements.fundsList.innerHTML = "";
        }

        const pendingCount = maturedPendingRows.length + pendingRows.length;
        const pendingAmount = sumNumericValues([
          ...maturedPendingRows.map((row) => row?.amount),
          ...pendingRows.map((row) => row?.amount)
        ]);

        if (maturedPendingRows.length > 0) {
          elements.maturedPendingPanel.hidden = false;
          elements.maturedPendingRows.innerHTML = maturedPendingRows
            .map((row) =>
              '<div class="pending-item">' +
                escapeHtml(row.name) +
                " · " +
                escapeHtml(formatCurrency(row.amount)) +
                " · 应自 " +
                escapeHtml(row.profitEffectiveOn ?? "--") +
                " 起参与今日收益，待 latest.json 刷新确认" +
              "</div>"
            )
            .join("");
        } else {
          elements.maturedPendingPanel.hidden = true;
          elements.maturedPendingRows.innerHTML = "";
        }

        if (pendingRows.length > 0) {
          elements.pendingPanel.hidden = false;
          elements.pendingRows.innerHTML = pendingRows
            .map((row) =>
              '<div class="pending-item">' +
                escapeHtml(row.name) +
                " · " +
                escapeHtml(formatCurrency(row.amount)) +
                " · 自 " +
                escapeHtml(row.profitEffectiveOn ?? "--") +
                " 起开始计收益" +
              "</div>"
            )
            .join("");
        } else {
          elements.pendingPanel.hidden = true;
          elements.pendingRows.innerHTML = "";
        }

        if (pendingCount > 0) {
          elements.pendingFold.hidden = false;
          elements.pendingFoldSummary.textContent =
            String(pendingCount) + " 笔 · " + formatCurrency(pendingAmount);
        } else {
          elements.pendingFold.hidden = true;
          elements.pendingFoldSummary.textContent = "当前没有待确认申购";
        }

        if (fundRows.length === 0 && !cashRow) {
          elements.empty.hidden = false;
          elements.empty.textContent = "当前没有 active 基金持仓。";
          return;
        }

        elements.empty.hidden = true;
      }

      async function refreshData(manual) {
        if (loading) {
          return;
        }

        loading = true;
        elements.status.textContent = manual ? "手动刷新中..." : "正在刷新实时估值...";

        try {
          const url = new URL("/api/live-funds", window.location.origin);
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
          const unresolved = Number(payload?.summary?.unresolvedFundCount ?? 0);
          const unresolvedText = unresolved > 0 ? "，仍有 " + unresolved + " 只未映射" : "";
          elements.status.textContent =
            "已更新 " + timeText + " · " + Math.round(config.refreshMs / 1000) + " 秒自动刷新" + unresolvedText;
        } catch (error) {
          elements.status.textContent = "刷新失败：" + String(error?.message ?? error);
          if (!elements.fundsList.innerHTML) {
            elements.empty.hidden = false;
            elements.empty.textContent = "实时估值拉取失败，请稍后重试。";
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
      elements.summaryToggleBtn.addEventListener("click", () => {
        config.summaryCollapsed = !config.summaryCollapsed;
        saveSummaryCollapsed();
        renderSummaryCollapsedState();
      });
      elements.pendingFoldToggle.addEventListener("click", () => {
        config.pendingCollapsed = !config.pendingCollapsed;
        savePanelCollapsed("pendingFold", config.pendingCollapsed);
        renderFoldStates();
      });
      elements.bucketChips.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-bucket-filter]");
        if (!chip) {
          return;
        }

        const bucketKey = String(chip.dataset.bucketFilter ?? "ALL") || "ALL";
        if (config.selectedBucket === bucketKey) {
          return;
        }
        config.selectedBucket = bucketKey;
        saveSelectedBucket();
        if (config.currentPayload) {
          render(config.currentPayload);
        }
      });
      elements.sortSelect.addEventListener("change", (event) => {
        const nextMode = String(event.target.value || "amount_desc");
        if (!nextMode) {
          return;
        }
        config.sortMode = nextMode;
        saveSortMode();
        if (config.currentPayload) {
          render(config.currentPayload);
        }
      });
      elements.refreshBtn.addEventListener("click", () => refreshData(true));
      updateAccountUrl(config.currentAccount);
      renderSummaryCollapsedState();
      renderFoldStates();
      refreshData(false);
      window.setInterval(() => refreshData(false), config.refreshMs);
    