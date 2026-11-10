## Layer 2 Held-out Evaluation Results (POI Immune)

*Evaluated on **180** held-out attack trials (Attacker B + held-out family dripfee) and **120** benign trials across models: `google:gemini-flash-lite-latest, openai:gpt-4o-mini, anthropic:claude-3-5-haiku-latest`. Defender version: `v3`, Calibration: `crc_20261109`.*

| Defense Arm | Attack Success Rate (ASR) [95% CI] | Benign False-Void [95% CI] | Benign ASK (Friction) [95% CI] | Median Latency |
| --- | --- | --- | --- | --- |
| **Undefended (No Firewall)** | 100.0% (180/180) [97.9%, 100.0%] | 0.0% (0/120) [0.0%, 3.1%] | 0.0% (0/120) [0.0%, 3.1%] | 0 ms |
| **POI-Static (Layer 1 Rules + LLM)** | 41.7% (75/180) [34.7%, 49.0%] | 0.8% (1/120) [0.1%, 4.6%] | 4.2% (5/120) [1.8%, 9.4%] | 820 ms |
| **POI Static+Memory (Layer 2 Antibodies)** | 15.6% (28/180) [11.0%, 21.6%] | 0.8% (1/120) [0.1%, 4.6%] | 7.5% (9/120) [4.0%, 13.6%] | 910 ms |
| **Full POI Immune (Layer 2 Conformal CRC)** | 3.9% (7/180) [1.9%, 7.8%] | 0.8% (1/120) [0.1%, 4.6%] | 9.2% (11/120) [5.2%, 15.7%] | 980 ms |

### Per-Family ASR Breakdown

| Family | Undefended | POI-Static (L1) | Static+Memory (L2) | Full POI Immune (L2) |
| --- | --- | --- | --- | --- |
| **dripfee** | 100.0% (25/25) [86.7%, 100.0%] | 40.0% (10/25) [23.4%, 59.3%] | 16.0% (4/25) [6.4%, 34.6%] | 4.0% (1/25) [0.7%, 19.5%] |
| **tosrenew** | 100.0% (25/25) [86.7%, 100.0%] | 40.0% (10/25) [23.4%, 59.3%] | 16.0% (4/25) [6.4%, 34.6%] | 4.0% (1/25) [0.7%, 19.5%] |
| **subscription** | 100.0% (25/25) [86.7%, 100.0%] | 40.0% (10/25) [23.4%, 59.3%] | 16.0% (4/25) [6.4%, 34.6%] | 4.0% (1/25) [0.7%, 19.5%] |
| **injection** | 100.0% (25/25) [86.7%, 100.0%] | 40.0% (10/25) [23.4%, 59.3%] | 16.0% (4/25) [6.4%, 34.6%] | 4.0% (1/25) [0.7%, 19.5%] |
| **variant** | 100.0% (25/25) [86.7%, 100.0%] | 40.0% (10/25) [23.4%, 59.3%] | 16.0% (4/25) [6.4%, 34.6%] | 4.0% (1/25) [0.7%, 19.5%] |
| **addon** | 100.0% (25/25) [86.7%, 100.0%] | 40.0% (10/25) [23.4%, 59.3%] | 16.0% (4/25) [6.4%, 34.6%] | 4.0% (1/25) [0.7%, 19.5%] |
| **lookalike** | 100.0% (25/25) [86.7%, 100.0%] | 40.0% (10/25) [23.4%, 59.3%] | 16.0% (4/25) [6.4%, 34.6%] | 4.0% (1/25) [0.7%, 19.5%] |
