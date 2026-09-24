# Real free-provider failover status

The packaged dogfood run selected hosted `codeforge-cloud` route `groq::openai/gpt-oss-120b`. A free-capacity event paused the task for 60 seconds and it continued on the same route. This proves capacity waiting, not cross-provider failover.

Read-only live catalog checks found `openai/gpt-oss-120b` on direct OpenRouter as `paid` and on direct Groq as `unknown` free status. Those records cannot form a ForgeZero-eligible pair for a same-model free failover experiment. R29 did not force a real provider failure on the hosted cloud service. Cross-provider failover is therefore unproven; no paid route was used as a substitute.
