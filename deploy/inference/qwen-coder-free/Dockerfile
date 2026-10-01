FROM vllm/vllm-openai:v0.30.0

WORKDIR /opt/codeforge-worker
COPY worker.py /opt/codeforge-worker/worker.py

ENV CODEFORGE_MODEL_ID=codeforge/qwen-coder-free \
    CODEFORGE_MODEL_REVISION=dcaee4d4dfc5ee71ad501f01f530e5652438fde0 \
    CODEFORGE_MODEL_SOURCE=Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 \
    CODEFORGE_MAX_MODEL_LEN=32768 \
    CODEFORGE_MAX_CONCURRENT_SEQUENCES=4 \
    CODEFORGE_MAX_BATCH_TOKENS=4096 \
    CODEFORGE_TENSOR_PARALLEL_SIZE=1 \
    VLLM_API_PORT=8001

EXPOSE 8000
ENTRYPOINT ["python", "/opt/codeforge-worker/worker.py"]
