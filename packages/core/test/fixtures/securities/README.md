# Synthetic independent securities oracle

All positions, names and prices are invented. `oracle.json` was calculated independently
with Python `Decimal` (precision 100, `ROUND_HALF_UP`), without importing production
TypeScript math. Unit and HTTP→DB tests consume the saved expected values; CI never
requires Python. `cost_removed` describes sale cost only; adjust cost changes are
represented by `cost_before` / `cost_after`. Average cost is display-only at four decimals.

Optional authoring reproduction: `python3 generate-oracle.py`; this is not a test command.
