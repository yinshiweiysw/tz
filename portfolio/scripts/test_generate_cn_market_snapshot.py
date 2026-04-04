import unittest
import importlib.util
from pathlib import Path
import sys
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.append(str(SCRIPT_DIR))

MODULE_PATH = SCRIPT_DIR / "generate_cn_market_snapshot.py"


def load_snapshot_module(module_name="generate_cn_market_snapshot_test"):
    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeFrame:
    def __init__(self, rows):
        self._rows = rows
        self.empty = len(rows) == 0

    def iterrows(self):
        for index, row in enumerate(self._rows):
            yield index, row

    def tail(self, count):
        return FakeFrame(self._rows[-count:])

    @property
    def iloc(self):
        rows = self._rows

        class _ILoc:
            def __getitem__(self, index):
                return rows[index]

        return _ILoc()

    def __getitem__(self, key):
        return [row.get(key) for row in self._rows]


class FakeAk:
    def stock_hsgt_fund_flow_summary_em(self):
        return FakeFrame(
            [
                {
                    "交易日": "2026-04-02",
                    "板块": "港股通(沪)",
                    "资金方向": "南向",
                    "相关指数": "恒生指数",
                    "指数涨跌幅": -0.7,
                    "上涨数": 243,
                    "持平数": 35,
                    "下跌数": 314,
                    "成交净买额": 110.84,
                    "交易状态": 3,
                },
                {
                    "交易日": "2026-04-02",
                    "板块": "港股通(深)",
                    "资金方向": "南向",
                    "相关指数": "恒生指数",
                    "指数涨跌幅": -0.7,
                    "上涨数": 243,
                    "持平数": 35,
                    "下跌数": 314,
                    "成交净买额": 87.44,
                    "交易状态": 3,
                },
            ]
        )

    def stock_hsgt_fund_min_em(self, symbol="北向资金"):
        if symbol != "南向资金":
            raise AssertionError(f"unexpected symbol {symbol}")
        return FakeFrame(
            [
                {"时间": "14:59", "南向资金": 180.0, "港股通(沪)": 101.0, "港股通(深)": 79.0},
                {"时间": "15:00", "南向资金": 198.28, "港股通(沪)": 110.84, "港股通(深)": 87.44},
            ]
        )


class FakeAkRawIntraday(FakeAk):
    def stock_hsgt_fund_min_em(self, symbol="北向资金"):
        if symbol != "南向资金":
            raise AssertionError(f"unexpected symbol {symbol}")
        return FakeFrame(
            [
                {"时间": "14:59", "南向资金": 1800000.0, "港股通(沪)": 1010000.0, "港股通(深)": 790000.0},
                {"时间": "15:00", "南向资金": 1982767.59, "港股通(沪)": 1108386.42, "港股通(深)": 874381.17},
            ]
        )


class SouthboundFlowTest(unittest.TestCase):
    def test_import_does_not_reexec_python_runtime(self):
        with patch("os.execve", side_effect=AssertionError("execve should not run during import")):
            load_snapshot_module("generate_cn_market_snapshot_import_guard")

    def test_fetch_southbound_flow_builds_channel_and_intraday_summary(self):
        module = load_snapshot_module("generate_cn_market_snapshot_summary")
        result = module.fetch_southbound_flow(FakeAk())

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["latest_date"], "2026-04-02")
        self.assertAlmostEqual(result["latest_summary_net_buy_100m_hkd"], 198.28, places=2)
        self.assertAlmostEqual(result["latest_intraday_net_inflow_100m_hkd"], 198.28, places=2)
        self.assertEqual(result["channels"][0]["channel"], "港股通(沪)")
        self.assertEqual(result["channels"][1]["channel"], "港股通(深)")

    def test_fetch_southbound_flow_normalizes_raw_intraday_units_to_100m(self):
        module = load_snapshot_module("generate_cn_market_snapshot_units")
        result = module.fetch_southbound_flow(FakeAkRawIntraday())

        self.assertEqual(result["status"], "ok")
        self.assertAlmostEqual(result["latest_intraday_net_inflow_100m_hkd"], 198.28, places=2)
        self.assertAlmostEqual(result["sh_connect_net_inflow_100m_hkd"], 110.84, places=2)
        self.assertAlmostEqual(result["sz_connect_net_inflow_100m_hkd"], 87.44, places=2)


if __name__ == "__main__":
    unittest.main()
