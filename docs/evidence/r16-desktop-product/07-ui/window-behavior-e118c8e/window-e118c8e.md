# window-e118c8e

| Check | Status | Detail |
|---|---|---|
| initialLayout | PASS | Initial window 1488x816 at DPR 2.5: no horizontal overflow; composer visible. |
| maximize | PASS | Maximized: viewport 1536x842, no overflow. |
| restore | PASS | Restore returns to the previous size (1488x816). |
| minimize | PASS | Minimize applies. |
| restoreFromMinimize | PASS | Restores from the taskbar. |
| smallLaptop | PASS | 1280x720 CSS viewport: no overflow, composer and send visible. |
| minimumSize | PASS | At the smallest allowed size the composer stays reachable and nothing overflows horizontally (viewport 1020x610). |
| secondMonitor | WARN | Second monitor move: onSecond=False overflow=False composer=True. |
| windowStatePersists | PASS | Window size restored across relaunch (1112x688 vs 1109x686). |

Verdict: **PASS**
