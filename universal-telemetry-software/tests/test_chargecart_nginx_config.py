"""Regression checks for the chargecart nginx site."""

from pathlib import Path


DEPLOY_DIR = Path(__file__).resolve().parents[1] / "deploy"
NGINX_CONF = DEPLOY_DIR / "chargecart-nginx.conf"


def _server_names() -> list[str]:
    for line in NGINX_CONF.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("server_name "):
            return stripped.removeprefix("server_name ").rstrip(";").split()
    raise AssertionError("chargecart nginx config is missing server_name")


def test_chargecart_nginx_serves_only_localhost_names():
    assert _server_names() == ["localhost", "chargecart.local"]
