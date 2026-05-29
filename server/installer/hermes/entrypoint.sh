#!/usr/bin/env bash
# Seed ~/.hermes/.env from injected env vars (only if not already present), then
# exec the requested hermes command. Keys are passed at `docker run` time and
# never baked into the image.
set -e

mkdir -p /root/.hermes
if [ ! -f /root/.hermes/.env ]; then
    : > /root/.hermes/.env
    [ -n "$ANTHROPIC_API_KEY" ]  && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"   >> /root/.hermes/.env
    [ -n "$ANTHROPIC_BASE_URL" ] && echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" >> /root/.hermes/.env
    [ -n "$MINIMAX_API_KEY" ]    && echo "MINIMAX_API_KEY=$MINIMAX_API_KEY"       >> /root/.hermes/.env
    [ -n "$OPENROUTER_API_KEY" ] && echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" >> /root/.hermes/.env
fi

exec "$@"
