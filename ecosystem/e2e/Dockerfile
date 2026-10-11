FROM python:3.12-slim
RUN useradd -r -u 10001 e2e
WORKDIR /e2e
COPY e2e_stack.py .
USER e2e
ENTRYPOINT ["python", "-I", "/e2e/e2e_stack.py"]
