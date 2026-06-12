# Slackbot

The Slack bot listens in Socket Mode and delivers notifications about data imports, telemetry status, and manual commands.

## Requirements

- `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` must be set in `.env`.
- Ensure Socket Mode is enabled in your Slack app configuration.

## Behavior

- Sends webhook notifications when file uploads complete.
- Provides command handlers defined in `installer/slackbot/slack_bot.py`.
- Reads the optional `SLACK_DEFAULT_CHANNEL` to determine where to post updates.

## Development tips

- Run `docker compose logs -f slackbot` to see Socket Mode connection status.
- Use `docker compose exec slackbot python slack_bot.py` for interactive debugging.
- Leave Slack credentials blank to skip starting the service in development.
