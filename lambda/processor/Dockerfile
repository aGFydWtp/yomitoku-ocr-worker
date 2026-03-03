FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.12

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# OpenCV headless の実行に必要なシステムライブラリ
RUN dnf install -y libxcb libglvnd-glx mesa-libGL && dnf clean all

COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

COPY index.py ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
