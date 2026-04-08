from __future__ import annotations


def normalize_fund_name(value: str) -> str:
    text = str(value or "")
    replacements = {
        "（": "(",
        "）": ")",
        " ": "",
        "\u3000": "",
        "(QDII)": "",
        "（QDII）": "",
        "QDII-FOF-LOF": "QDII",
        "QDII-LOF": "QDII",
        "ETF发起式联接": "",
        "ETF发起联接": "",
        "ETF联接": "",
        "ETF发起": "",
        "联接": "",
        "发起式": "",
        "发起": "",
        "人民币": "",
        "混合型": "混合",
        "持有期": "持有",
        "-": "",
        "_": "",
        "/": "",
        ".": "",
        "(": "",
        ")": "",
        "[": "",
        "]": "",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text
