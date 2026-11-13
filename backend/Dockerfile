FROM python:3.11-slim

ARG VERITY_RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision="${VERITY_RELEASE_SHA}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/verity

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

RUN addgroup --system --gid 10001 verity \
    && adduser --system --uid 10001 --ingroup verity --home /home/verity --no-create-home verity \
    && mkdir -p /home/verity \
    && chown verity:verity /home/verity

COPY --chown=verity:verity app ./app
COPY --chown=verity:verity migrations ./migrations
COPY --chown=verity:verity scripts ./scripts
RUN printf '%s\n' "$VERITY_RELEASE_SHA" > /app/RELEASE_SHA \
    && chown verity:verity /app/RELEASE_SHA
USER verity
CMD ["python", "-m", "app.worker"]
