"""Assert data-downloader-api uses an explicit env allowlist, not broad env_file."""
from __future__ import annotations

import re
from pathlib import Path


# Env names config.py reads; compose must set each explicitly.
REQUIRED_API_ENV = frozenset(
    {
        "DATA_DIR",
        "POSTGRES_DSN",
        "DEFAULT_SEASON_TABLE",
        "SEASONS",
        "SCANNER_BIN",
        "SCANNER_INCLUDE_COUNTS",
        "SCANNER_INITIAL_CHUNK_DAYS",
        "SENSOR_WINDOW_DAYS",
        "SENSOR_LOOKBACK_DAYS",
        "SCAN_INTERVAL_SECONDS",
        "SCAN_DAILY_TIME",
        "ALLOWED_ORIGINS",
        "GITHUB_DBC_TOKEN",
        "GITHUB_DBC_REPO",
        "GITHUB_DBC_BRANCH",
        "GITHUB_DBC_PATH",
        "DBC_FILE_PATH",
    }
)

# Stack secrets that must never land in the API container.
FORBIDDEN_API_ENV = (
    "GRAFANA_API_TOKEN",
    "SLACK_BOT_TOKEN",
    "ANTHROPIC_API_KEY",
)

_COMPOSE_DEFAULT_RE = re.compile(r"\$\{[A-Z0-9_]+:-(.*)\}$")


def _installer_compose_path() -> Path:
    # backend/tests -> backend -> data-downloader -> installer
    return Path(__file__).resolve().parents[3] / "docker-compose.yml"


def _service_block(compose_text: str, service: str) -> str:
    """Return the indented body of a top-level compose service (stdlib only)."""
    marker = f"  {service}:"
    lines = compose_text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line == marker:
            start = i + 1
            break
    if start is None:
        raise AssertionError(f"service {service!r} not found in compose file")

    body: list[str] = []
    for line in lines[start:]:
        # Next top-level key or sibling service (exactly two spaces + name:)
        if line.startswith("  ") and not line.startswith("    "):
            break
        if line and not line.startswith(" ") and not line.startswith("\t"):
            break
        body.append(line)
    return "\n".join(body)


def _environment_mapping(service_body: str) -> dict[str, str]:
    """Parse key/value pairs under the service's environment: mapping."""
    lines = service_body.splitlines()
    env_start = None
    for i, line in enumerate(lines):
        if line.strip() == "environment:" or line.rstrip() == "    environment:":
            env_start = i + 1
            break
    if env_start is None:
        return {}

    mapping: dict[str, str] = {}
    for line in lines[env_start:]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        # Left environment block when indentation returns to service-property level
        if line.startswith("    ") and not line.startswith("      "):
            break
        if ":" not in stripped:
            continue
        key, raw_value = stripped.split(":", 1)
        key = key.strip()
        if not key:
            continue
        mapping[key] = raw_value.strip().strip('"').strip("'")
    return mapping


def _compose_fallback(value: str) -> str | None:
    """Return the :-default from ${VAR:-default}, or None if not that form."""
    match = _COMPOSE_DEFAULT_RE.fullmatch(value.strip())
    return match.group(1) if match else None


def test_data_downloader_api_env_is_explicit_allowlist():
    compose_path = _installer_compose_path()
    assert compose_path.is_file(), f"missing compose file: {compose_path}"
    text = compose_path.read_text(encoding="utf-8")
    block = _service_block(text, "data-downloader-api")

    assert "env_file:" not in block, (
        "data-downloader-api must not use env_file; inject only an explicit allowlist"
    )

    for forbidden in FORBIDDEN_API_ENV:
        assert forbidden not in block, (
            f"data-downloader-api must not reference unrelated secret {forbidden}"
        )

    env_map = _environment_mapping(block)
    env_keys = set(env_map)
    assert env_keys == set(REQUIRED_API_ENV), (
        "data-downloader-api environment keys must exactly match config.py allowlist; "
        f"extra={sorted(env_keys - REQUIRED_API_ENV)} "
        f"missing={sorted(REQUIRED_API_ENV - env_keys)}"
    )

    lookback_fallback = _compose_fallback(env_map["SENSOR_LOOKBACK_DAYS"])
    assert lookback_fallback == "30", (
        "SENSOR_LOOKBACK_DAYS compose fallback must match config.py default of 30 "
        f"(got {lookback_fallback!r}); production .env may still set 365 explicitly"
    )
