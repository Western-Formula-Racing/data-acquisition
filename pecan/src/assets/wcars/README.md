# WFR25 cell-level characterisation data

These two CSVs are the **per-cell** characterisation measurements for the WFR25 Li-ion cells, used by `pecan/src/lib/wcars/batteryModel.ts` to predict pack voltage and sag from SoC / current / temperature.

## `ocv.csv` — Open-Circuit Voltage vs SoC (per cell)

- Format: `SoC,OCV,Temperature_C` — 3 columns, 57 rows
- Tested at **~25 °C** (all rows in 24.9–25.5 °C range)
- SoC range: 0.027 → 0.949 (charge direction; upper end not measured)
- OCV range: 3.115 V (empty) → 4.113 V (full)
- Model applies this curve at the **per-cell** level; multiply by 100 to get the 100S pack voltage

## `dcir.csv` — DC Internal Resistance (R₀) vs SoC and Temperature

- Format: `SoC,R0_Ohms,Temperature_C` — 3 columns, 400 rows
- SoC range: 0.0 → 1.0 across multiple temperature sweeps
- Temperature range: 5 °C → 46 °C
- R₀ range: 0.014 Ω → 0.045 Ω (U-shaped, rises at low SoC and low T)
- Model applies at the **per-cell** level; for pack sag multiply by 100 (Nseries) and by current

## Caveats

- OCV is at 25 °C only. Outside 20–30 °C the OCV shifts and the prediction drifts.
- DCIR is charge-direction. Discharging R₀ is similar for Li-ion but technically different.
- The OCV top end is cut at SoC 0.949; the model clamps to that max.
- Per-cell R₀ at 5 °C is ~3× the 25 °C value — the cold-launch sag is real and this curve captures it.
