# Portfolio Users

- 默认主账户仍然位于 `/Users/yinshiwei/codex/tz/portfolio`
- 额外账户位于 `/Users/yinshiwei/codex/tz/portfolio_users/<account_id>`
- 不传账户时，所有脚本继续默认读取主账户
- 传 `--user <account_id>` 或环境变量 `PORTFOLIO_USER=<account_id>` 时，脚本切换到对应账户根目录

示例：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_portfolio_user.mjs --user friend_a
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/generate_fund_signals_matrix.py --user friend_a
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/calculate_quant_metrics.py --user friend_a
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs --user friend_a
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs --user friend_a
```
