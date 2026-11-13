# Build from backend/ (not from this directory), so both packages this
# server needs are in the build context:
#   docker build -f verity_dam_mcp/Dockerfile -t verity-media-mcp .
# Run with the MCP client attached to stdin/stdout, e.g.:
#   docker run -i --rm --env-file .env verity-media-mcp
FROM python:3.11-slim

ARG VERITY_RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision="${VERITY_RELEASE_SHA}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/verity

WORKDIR /app
COPY requirements-mcp.txt requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements-mcp.txt

RUN addgroup --system --gid 10001 verity \
    && adduser --system --uid 10001 --ingroup verity --home /home/verity --no-create-home verity \
    && mkdir -p /home/verity \
    && chown verity:verity /home/verity

# `verity_dam_mcp` reuses the native PostgreSQL repository, R2 boundary,
# embedding API client, and search intelligence package (Vietnamese
# normalizer, fuzzy channel, canonical ranking contract used by library_search).
COPY --chown=verity:verity app ./app
COPY --chown=verity:verity search_intelligence ./search_intelligence
COPY --chown=verity:verity verity_dam_mcp ./verity_dam_mcp
RUN printf '%s\n' "$VERITY_RELEASE_SHA" > /app/RELEASE_SHA \
    && chown verity:verity /app/RELEASE_SHA
USER verity
CMD ["python", "-m", "verity_dam_mcp", "streamable-http"]
