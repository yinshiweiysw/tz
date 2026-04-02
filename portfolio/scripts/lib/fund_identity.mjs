const FUND_IDENTITY_MIGRATIONS = [
  {
    canonical: {
      code: "023764",
      name: "华夏恒生互联网科技业ETF联接(QDII)D"
    },
    aliases: [
      {
        code: "013172",
        name: "华夏恒生互联网科技业ETF联接(QDII)C"
      }
    ]
  }
];

export function normalizeFundName(name) {
  return String(name ?? "")
    .trim()
    .replace(
      /人民币|发起式|发起|联接|ETF|LOF|FOF|指数|股票|混合|持有期|持有|配置|QDII|CNY|人民币A|人民币C|人民币D|人民币E/giu,
      ""
    )
    .replace(/[()（）\[\]【】\s\-_/·.,，:：]/gu, "")
    .toLowerCase()
    .replace(/[acdeh]$/giu, "");
}

function normalizeCode(code) {
  return String(code ?? "").trim();
}

function buildKnownIdentities(spec) {
  return [spec.canonical, ...(Array.isArray(spec.aliases) ? spec.aliases : [])].filter(Boolean);
}

function specMatchesIdentity(spec, identity) {
  const code = normalizeCode(identity?.code);
  const normalizedName = normalizeFundName(identity?.name);

  return buildKnownIdentities(spec).some((item) => {
    const itemCode = normalizeCode(item?.code);
    const itemName = normalizeFundName(item?.name);
    return (code && itemCode && code === itemCode) || (normalizedName && itemName && normalizedName === itemName);
  });
}

export function canonicalizeFundIdentity(identity = {}) {
  const matched = FUND_IDENTITY_MIGRATIONS.find((spec) => specMatchesIdentity(spec, identity));
  if (!matched) {
    return {
      code: normalizeCode(identity?.code) || null,
      name: String(identity?.name ?? "").trim() || null,
      aliases: [...new Set((Array.isArray(identity?.aliases) ? identity.aliases : []).filter(Boolean))]
    };
  }

  return {
    code: matched.canonical.code,
    name: matched.canonical.name,
    aliases: [
      ...new Set(
        [
          matched.canonical.name,
          ...buildKnownIdentities(matched).map((item) => item?.name),
          ...(Array.isArray(identity?.aliases) ? identity.aliases : [])
        ].filter(Boolean)
      )
    ]
  };
}

export function getFundIdentityAliases(identity = {}) {
  const matched = FUND_IDENTITY_MIGRATIONS.find((spec) => specMatchesIdentity(spec, identity));
  if (!matched) {
    const code = normalizeCode(identity?.code);
    const name = String(identity?.name ?? "").trim();
    return code || name ? [{ code: code || null, name: name || null }] : [];
  }

  return buildKnownIdentities(matched).map((item) => ({
    code: normalizeCode(item?.code) || null,
    name: String(item?.name ?? "").trim() || null
  }));
}

export function applyCanonicalFundIdentity(target = {}) {
  const canonical = canonicalizeFundIdentity(target);
  const next = {
    ...target
  };

  if (canonical.code) {
    next.code = canonical.code;
    if (Object.prototype.hasOwnProperty.call(next, "symbol")) {
      next.symbol = canonical.code;
    }
    if (Object.prototype.hasOwnProperty.call(next, "fund_code")) {
      next.fund_code = canonical.code;
    }
  }

  if (canonical.name) {
    next.name = canonical.name;
  }

  if (canonical.aliases.length > 0) {
    next.aliases = [...new Set([...(Array.isArray(target?.aliases) ? target.aliases : []), ...canonical.aliases])];
  }

  return next;
}
