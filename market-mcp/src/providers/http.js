import axios from "axios";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

export const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
  }
});

export function parsePossiblyWrappedJson(payload) {
  if (typeof payload !== "string") {
    return payload;
  }

  const text = payload.trim();
  if (!text) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch {}

  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start !== -1 && end !== -1 && end > start) {
    const inner = text.slice(start + 1, end);
    return JSON.parse(inner);
  }

  throw new Error("Unable to parse upstream response as JSON");
}
