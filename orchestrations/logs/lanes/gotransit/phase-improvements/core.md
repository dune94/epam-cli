# Phase Improvement Report: core
_Generated: 2026-08-03T18:49:01.051937+00:00_

- Actual: 11.583 min / $0.624
- Forecast: 4.518 min / $0.1403
- Variance: 7.066 min / $0.4837
- Over threshold (20.0%): True

## Notes
Actual time (11.58 min) and cost ($0.624) significantly exceeded forecasts (4.52 min / $0.14) — roughly 2.6× over on time and 4.4× over on cost. The single story (AMSD-2041) involved integrating Contentstack Live Preview SDK across three shared codelines, which likely introduced more complexity than the forecast accounted for.

## Recommendations
- Forecasts for SDK integration tasks spanning multiple codelines should account for cross-codeline coordination and shared-hook testing overhead.
- Consider breaking multi-codeline stories into per-codeline sub-stories to improve estimate granularity and variance tracking.
