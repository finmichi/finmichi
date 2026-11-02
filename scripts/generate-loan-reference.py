"""Independent synthetic Decimal oracle. Optional developer tool, never run by tests."""
import argparse
import json
from decimal import Decimal, ROUND_HALF_UP, getcontext
from pathlib import Path

getcontext().prec = 100
D = Decimal
methods = {}
for method in ("annuity", "equal_principal"):
    balance, rate, count = D("1200000"), D("0.021") / 12, 240
    payment = (balance * rate / (1 - (1 + rate) ** -count)).quantize(
        D(".01"), rounding=ROUND_HALF_UP
    )
    base = (balance * 100 // count) / 100
    rows = []
    for i in range(count):
        interest = (balance * rate).quantize(D(".01"), rounding=ROUND_HALF_UP)
        principal = base if method == "equal_principal" else min(
            max(payment - interest, D(0)), balance
        )
        if i == count - 1:
            principal = balance
        balance -= principal
        rows.append({
            "principal": f"{principal:.2f}", "interest": f"{interest:.2f}",
            "payment": f"{principal + interest:.2f}", "closing": f"{balance:.2f}",
        })
    methods[method] = rows
value = {
    "provenance": "Synthetic independent Python Decimal, precision=100, HALF_UP. "
    "P=1200000, annual rate=2.1%, n=240. No runtime Python dependency.",
    "methods": methods,
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--write", action="store_true")
args = parser.parse_args()
path = Path(__file__).resolve().parents[1] / "packages/core/src/fixtures/loan-decimal-reference.json"
if args.write:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
else:
    assert json.loads(path.read_text(encoding="utf-8")) == value
print("PASS independent Decimal synthetic loan reference: 2 methods x 240 periods")
