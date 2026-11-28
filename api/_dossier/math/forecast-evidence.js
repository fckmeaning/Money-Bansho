// Out-of-sample results shown next to the forecast. Written by scripts/backtest-forecast.mjs --write.
// Prices: Yahoo daily bars; constants fitted before 2025, everything below measured after.
export const EVIDENCE = {
  "period": [
    "2025-01-01",
    "2026-11-26"
  ],
  "companies": 61,
  "range": {
    "1": {
      "n": 28511,
      "cover80": 0.7938,
      "previousCover80": 0.8221,
      "cover95": 0.9482,
      "previousCover95": 0.9368,
      "skill": 0.0105,
      "skillLow": 0.0062,
      "skillHigh": 0.0158,
      "tailSkill": 0.0305,
      "brier": 0.19848,
      "previousBrier": 0.20101,
      "climatologyBrier": 0.20067,
      "widthChange": -0.0711
    },
    "5": {
      "n": 28267,
      "cover80": 0.7848,
      "previousCover80": 0.8093,
      "cover95": 0.9444,
      "previousCover95": 0.9337,
      "skill": 0.0057,
      "skillLow": 0.0013,
      "skillHigh": 0.011,
      "tailSkill": 0.0202,
      "brier": 0.205,
      "previousBrier": 0.20638,
      "climatologyBrier": 0.20713,
      "widthChange": -0.0538
    },
    "20": {
      "n": 27352,
      "cover80": 0.7813,
      "previousCover80": 0.8016,
      "cover95": 0.9451,
      "previousCover95": 0.931,
      "skill": 0.0065,
      "skillLow": 0.0018,
      "skillHigh": 0.0125,
      "tailSkill": 0.024,
      "brier": 0.20744,
      "previousBrier": 0.20894,
      "climatologyBrier": 0.21464,
      "widthChange": -0.0491
    }
  },
  "close": {
    "1": {
      "n": 28511,
      "cover80": 0.7944,
      "previousCover80": 0.8221,
      "cover95": 0.9483,
      "previousCover95": 0.9368,
      "skill": 0.0086,
      "skillLow": 0.0044,
      "skillHigh": 0.0139,
      "tailSkill": 0.0238,
      "brier": 0.1989,
      "previousBrier": 0.20101,
      "climatologyBrier": 0.20067,
      "widthChange": -0.0762
    },
    "5": {
      "n": 28267,
      "cover80": 0.7895,
      "previousCover80": 0.8093,
      "cover95": 0.9472,
      "previousCover95": 0.9337,
      "skill": 0.0049,
      "skillLow": 0.0009,
      "skillHigh": 0.0099,
      "tailSkill": 0.017,
      "brier": 0.20518,
      "previousBrier": 0.20638,
      "climatologyBrier": 0.20713,
      "widthChange": -0.0481
    },
    "20": {
      "n": 27352,
      "cover80": 0.7915,
      "previousCover80": 0.8016,
      "cover95": 0.9494,
      "previousCover95": 0.931,
      "skill": 0.0053,
      "skillLow": 0.0012,
      "skillHigh": 0.0107,
      "tailSkill": 0.0198,
      "brier": 0.20776,
      "previousBrier": 0.20894,
      "climatologyBrier": 0.21464,
      "widthChange": -0.0309
    }
  },
  "events": {
    "filing": {
      "1": {
        "n": 81,
        "cover80": 0.8148,
        "previousCover80": 0.679,
        "skill": 0.0232,
        "skillLow": -0.0093,
        "skillHigh": 0.0542
      },
      "5": {
        "n": 81,
        "cover80": 0.7778,
        "previousCover80": 0.7037,
        "skill": 0.0133,
        "skillLow": -0.0003,
        "skillHigh": 0.0276
      },
      "20": {
        "n": 77,
        "cover80": 0.7532,
        "previousCover80": 0.7532,
        "skill": 0.0006,
        "skillLow": -0.0283,
        "skillHigh": 0.0265
      }
    },
    "headline": {
      "1": {
        "n": 2225,
        "cover80": 0.7802,
        "previousCover80": 0.8274,
        "skill": 0.0062,
        "skillLow": -0.0016,
        "skillHigh": 0.0155
      },
      "5": {
        "n": 2225,
        "cover80": 0.7942,
        "previousCover80": 0.8252,
        "skill": 0.0146,
        "skillLow": 0.0078,
        "skillHigh": 0.0219
      },
      "20": {
        "n": 2223,
        "cover80": 0.8246,
        "previousCover80": 0.8264,
        "skill": 0.0148,
        "skillLow": -0.0002,
        "skillHigh": 0.0294
      }
    }
  },
  "extremeRatio": 1.7,
  "extreme": {
    "1": {
      "n": 1173,
      "cover80": 0.8636,
      "previousCover80": 0.7127
    },
    "5": {
      "n": 726,
      "cover80": 0.927,
      "previousCover80": 0.8072
    },
    "20": {
      "n": 366,
      "cover80": 0.8388,
      "previousCover80": 0.724
    }
  },
  "links": {
    "pairQuarters": 1765,
    "companies": 59,
    "corrBefore": 0.493,
    "corrAfter": 0.417,
    "held": 0.799,
    "r2": 0.203
  }
};
