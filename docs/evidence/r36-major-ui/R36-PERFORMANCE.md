# R36 — Performance

No regressions introduced: timeline projection stays O(events); grouping is a single linear pass
per turn; DiffViewer already bounds to 512k chars / 2k rendered lines; transcripts append in
place. No new polling or subscriptions were added. Formal long-run profiling is an open item.
