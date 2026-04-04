import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import {
  buildFundsPluginPayload,
  resolveFundsPluginImportPath
} from "./lib/funds_plugin_payload.mjs";
import { runRefreshAccountSidecars } from "./refresh_account_sidecars.mjs";

const execFileAsync = promisify(execFile);
const extensionId = "dhdelcemeednchdmijiocipbjlknndff";
const extensionOptionsUrl = `chrome-extension://${extensionId}/options/options.html`;
const defaultRefreshScopes = "live_funds_snapshot,nightly_confirmed_nav_status";

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

function nowIso() {
  return new Date().toISOString();
}

function escapeAppleScriptText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function buildExtensionSyncJavaScript(payload) {
  const payloadText = JSON.stringify(payload);
  const payloadRawText = JSON.stringify(JSON.stringify(payload, null, 2));

  return `
(() => {
  const payload = ${payloadText};
  const rawPayload = ${payloadRawText};
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.sync) {
      return JSON.stringify({
        ok: true,
        mode: "direct_storage_available",
        fundCount: payload.fundListM.length
      });
    }

    const input = document.querySelector('input[type="file"]');
    if (!input) {
      return JSON.stringify({
        ok: false,
        error: "file_input_not_found"
      });
    }

    const file = new File([rawPayload], "funds-plugin-import.json", {
      type: "application/json"
    });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    window.__codexFundsPluginLastSync = {
      ok: true,
      mode: "dom_file_input_dispatched",
      fundCount: payload.fundListM.length,
      timestamp: new Date().toISOString()
    };

    return JSON.stringify(window.__codexFundsPluginLastSync);
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: String(error)
    });
  }
})()
  `.trim();
}

async function runAppleScript(script) {
  const result = await execFileAsync("osascript", ["-e", script], {
    maxBuffer: 1024 * 1024
  });
  return String(result.stdout ?? "").trim();
}

async function openExtensionOptionsTab() {
  const script = `
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  tell front window
    set newTab to make new tab at end of tabs
    set URL of newTab to "${escapeAppleScriptText(extensionOptionsUrl)}"
    set active tab index to (count of tabs)
  end tell
  delay 1
  return URL of active tab of front window
end tell
  `.trim();

  return runAppleScript(script);
}

async function executeChromeJavaScript(jsCode) {
  const compactJsCode = jsCode.replace(/\s*\n+\s*/g, " ").trim();
  const script = `
set jsCode to "${escapeAppleScriptText(compactJsCode)}"
tell application "Google Chrome"
  return execute active tab of front window javascript jsCode
end tell
  `.trim();

  return runAppleScript(script);
}

async function writeStatus(statusPath, status) {
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

export async function runFundsPluginChromeSync(rawOptions = {}, deps = {}) {
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const portfolioRoot = resolvePortfolioRoot(options);
  const accountId = resolveAccountId(options);
  const outputPath = String(options.output ?? "").trim() || resolveFundsPluginImportPath(options);
  const statusPath =
    String(options.statusPath ?? options["status-path"] ?? "").trim() ||
    buildPortfolioPath(portfolioRoot, "plugin_sync_status.json");
  const refreshScopes =
    String(options.refreshScopes ?? options["refresh-scopes"] ?? "").trim() || defaultRefreshScopes;
  const refreshSidecars = deps.runRefreshAccountSidecars ?? runRefreshAccountSidecars;
  const buildPayload = deps.buildFundsPluginPayload ?? buildFundsPluginPayload;
  const openChromeTab = deps.openExtensionOptionsTab ?? openExtensionOptionsTab;
  const runChromeJavaScript = deps.executeChromeJavaScript ?? executeChromeJavaScript;

  await refreshSidecars({
    ...options,
    portfolioRoot,
    user: accountId,
    scopes: refreshScopes
  });

  const payload = await buildPayload({
    ...options,
    portfolioRoot,
    user: accountId
  });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const baseStatus = {
    status: "pending",
    timestamp: nowIso(),
    error: null,
    accountId,
    portfolioRoot,
    importFile: outputPath,
    extensionId,
    extensionOptionsUrl,
    refreshScopes,
    fundCount: payload.fundListM.length
  };

  try {
    const activeUrl = await openChromeTab();
    const jsResult = await runChromeJavaScript(buildExtensionSyncJavaScript(payload));
    const status = {
      ...baseStatus,
      status: "submitted_to_chrome_extension",
      activeUrl,
      jsResult
    };
    await writeStatus(statusPath, status);
    return status;
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    const needsChromeSetting = message.includes("允许 Apple 事件中的 JavaScript");
    const status = {
      ...baseStatus,
      status: needsChromeSetting ? "needs_chrome_applescript_javascript" : "sync_failed",
      error: message,
      nextStep: needsChromeSetting
        ? "在 Chrome 菜单栏中依次打开“查看”>“开发者”>“允许 Apple 事件中的 JavaScript”，随后重新运行本脚本即可直接写入插件。"
        : "检查 Chrome 是否正在运行、扩展页是否可访问，或稍后重试。"
    };
    await writeStatus(statusPath, status);
    const wrappedError = new Error(message);
    wrappedError.status = status;
    throw wrappedError;
  }
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    const status = await runFundsPluginChromeSync(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    const status = error?.status ?? { status: "sync_failed", error: String(error?.message ?? error) };
    console.log(JSON.stringify(status, null, 2));
    process.exitCode = 1;
  }
}
