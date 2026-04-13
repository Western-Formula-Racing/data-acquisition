#!/usr/bin/env python3
"""
backup-dashboards.py — Export all user-built Grafana dashboards to a directory.

Usage:
    python backup-dashboards.py [--url URL] [--output DIR] [--git-push]

Options:
    --url       Grafana base URL (default: http://localhost:8087)
    --output    Directory to save dashboard JSON files (default: ./grafana/dashboards)
    --git-push  After saving, git add + commit + push in the output directory's repo

Authentication (in order of preference):
    1. GRAFANA_API_TOKEN env var (service account token)
    2. Basic auth: admin / GRAFANA_ADMIN_PASSWORD env var (default: password)

Skips dashboards tagged 'pecan' (auto-generated ephemeral dashboards).
Sets "id": null in each exported JSON so they import cleanly on any instance.

Cron example (daily at 2am, push to daq-internal):
    0 2 * * * cd /path/to/daq-internal && \
        python /path/to/daq-server-components/installer/backup-dashboards.py \
        --output ./grafana-dashboards --git-push >> /var/log/grafana-backup.log 2>&1
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass  # python-dotenv optional


def get_auth_headers(api_token: str | None, admin_password: str) -> dict:
    if api_token:
        return {"Authorization": f"Bearer {api_token}"}
    creds = base64.b64encode(f"admin:{admin_password}".encode()).decode()
    return {"Authorization": f"Basic {creds}"}


def grafana_get(url: str, headers: dict) -> dict | list:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def main():
    parser = argparse.ArgumentParser(description="Backup Grafana dashboards to JSON files.")
    parser.add_argument("--url", default="http://localhost:8087", help="Grafana base URL")
    parser.add_argument("--output", default="./grafana/dashboards", help="Output directory")
    parser.add_argument("--git-push", action="store_true", help="git add + commit + push after saving")
    args = parser.parse_args()

    api_token = os.getenv("GRAFANA_API_TOKEN")
    admin_password = os.getenv("GRAFANA_ADMIN_PASSWORD", "password")
    headers = get_auth_headers(api_token, admin_password)
    headers["Content-Type"] = "application/json"

    base_url = args.url.rstrip("/")
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Connecting to Grafana at {base_url}")
    print(f"Saving dashboards to {output_dir.resolve()}")

    # List all dashboards
    search_url = f"{base_url}/api/search?type=dash-db&limit=500"
    try:
        results = grafana_get(search_url, headers)
    except Exception as e:
        print(f"Error connecting to Grafana: {e}", file=sys.stderr)
        sys.exit(1)

    if not results:
        print("No dashboards found.")
        return

    saved = []
    skipped = []

    for item in results:
        uid = item.get("uid")
        title = item.get("title", uid)
        tags = item.get("tags", [])

        if "pecan" in tags:
            skipped.append(title)
            continue

        try:
            detail = grafana_get(f"{base_url}/api/dashboards/uid/{uid}", headers)
        except Exception as e:
            print(f"  WARN: Could not fetch '{title}' ({uid}): {e}", file=sys.stderr)
            continue

        dashboard = detail.get("dashboard", {})
        dashboard["id"] = None  # Clear ID to avoid collisions on import

        out_path = output_dir / f"{uid}.json"
        out_path.write_text(json.dumps(dashboard, indent=2))
        print(f"  Saved: {title} → {out_path.name}")
        saved.append(str(out_path))

    print(f"\nDone: {len(saved)} saved, {len(skipped)} skipped (pecan).")

    if skipped:
        print(f"Skipped: {', '.join(skipped)}")

    if not saved:
        return

    if args.git_push:
        repo_dir = output_dir.resolve()
        # Walk up to find the git repo root
        check = repo_dir
        while check != check.parent:
            if (check / ".git").exists():
                repo_dir = check
                break
            check = check.parent
        else:
            print("WARN: --git-push specified but no git repo found. Skipping push.", file=sys.stderr)
            return

        rel_output = output_dir.resolve().relative_to(repo_dir)
        cmds = [
            ["git", "-C", str(repo_dir), "add", str(rel_output)],
            ["git", "-C", str(repo_dir), "commit", "-m", f"chore: backup grafana dashboards ({len(saved)} dashboards)"],
            ["git", "-C", str(repo_dir), "push"],
        ]
        for cmd in cmds:
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                # "nothing to commit" is not a real error
                if "nothing to commit" in result.stdout + result.stderr:
                    print("Git: nothing new to commit.")
                    break
                print(f"Git error: {result.stderr.strip()}", file=sys.stderr)
                sys.exit(1)
            elif result.stdout.strip():
                print(result.stdout.strip())

        print("Git push complete.")


if __name__ == "__main__":
    main()
