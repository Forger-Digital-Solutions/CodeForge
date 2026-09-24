# 8-Bit live health observations

The installed package initially showed 47 verified routes but zero healthy qualified routes, and ForgeAuto correctly refused to start a task. After the production package was rebuilt and relaunched, the picker showed two qualified free coding models. The successful task selected `codeforge-cloud` / `groq::openai/gpt-oss-120b` and later emitted a free-capacity wait before completion. The route badge could revert to `No Free Route` when no capacity was currently admitted.

These observations support live qualification/admission and fail-closed routing for this session. They do not establish long-run route freshness, automatic requalification under degradation, or cross-provider failover.
