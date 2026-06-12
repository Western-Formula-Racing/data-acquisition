Slackbot
========

A lightweight Socket Mode Slack bot that listens to a single channel and responds to a minimal set of operational commands. The bot can also persist agent instructions to disk and trigger an external process so other services can react to user requests.

Features
--------
- Connects to Slack using the official `slack_sdk` client in Socket Mode.
- Responds to `!help`, `!location`, `!testimage`, and `!agent` commands posted in the configured channel.
- Persists `!agent` instructions to a text file and runs a configurable subprocess to kick off downstream automation.
- Exposes the helper functions `send_slack_message` and `send_slack_image` so other modules can send messages or images through the same Slack client.

Requirements
------------
- Python 3.12 (the Docker image uses `python:3.12-slim`).
- Dependencies listed in `requirements.txt` (`requests`, `slack_sdk`).
- Access to the Slack App-level Socket Mode token and Bot token.

Configuration
-------------
Set the following environment variables before running the bot:

- `SLACK_APP_TOKEN` (required): Socket Mode app-level token (`xapp-...`).
- `SLACK_BOT_TOKEN` (required): Bot token with chat:write, files:write, and related scopes (`xoxb-...`).
- `SLACK_WEBHOOK_URL` (optional): Incoming webhook URL to announce when the bot starts.
- `SLACK_DEFAULT_CHANNEL` (optional): Channel ID the bot monitors and posts to. Defaults to `C08NTG6CXL5`.
- `SLACK_BOT_USER_ID` (optional): Bot user ID. Used to avoid responding to itself. Default is `U08P8KS8K25`.
- `CODE_GENERATOR_URL` (optional): URL of the code-generator service. Defaults to `http://code-generator:3030`.

Local Development
-----------------
1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
2. Inject .env variables into your shell or IDE. .env file is in the installer/ directory.
The .env is written in Docker format; to load it in a bash shell, run:
    ```bash
    set -a
    source .env
    set +a
    ```
3. Export the required environment variables.
4. Run the bot:
   ```bash
   python slack_bot.py
   ```

Docker Usage
------------
Build and run inside a container, or use the provided `docker-compose.yml` service definition.:
```bash
docker build -t slackbot .
docker run --rm \
  -e SLACK_APP_TOKEN=xapp-your-token \
  -e SLACK_BOT_TOKEN=xoxb-your-token \
  -e SLACK_DEFAULT_CHANNEL=C1234567890 \
  slackbot
```
Mount a host directory or file if you need to share the agent payload with other services.

Slack Commands
--------------
- `!help`  
  Display the list of supported commands and short descriptions.

- `!location`  
  Fetch the current vehicle location from `http://lap-detector-server:8050/api/track?type=location` and post a Google Maps link plus raw coordinates.

- `!testimage`  
  Upload the bundled `lappy_test_image.png` to confirm file upload functionality.

- `!agent <instructions>`  
  Generate and execute Python code using AI via the code-generator service. Supports data visualization and analysis. Timeout: 120 seconds.

- `!agent-debug <instructions>`  
  Extended version of `!agent` with 1200 second (20 minute) timeout. Automatically retries up to 2 times if code fails. Use for complex analysis or large datasets.

Agent Workflow
--------------
1. User posts `!agent` or `!agent-debug` followed by freeform instructions.
2. Bot sends instructions to the code-generator service via HTTP.
3. Code-generator uses AI to create Python code based on the instructions.
4. Generated code executes in a sandboxed environment and returns results (output, images, etc.).
5. Bot reports success/failure and uploads any generated visualizations to Slack.

Helper Functions
----------------
The module exposes two utility functions for reuse:

- `send_slack_message(channel: str, text: str, **kwargs)` – thin wrapper around `chat_postMessage`.
- `send_slack_image(channel: str, file_path: str, **kwargs)` – helper that uploads a file via `files_upload_v2`.

Import these functions in other modules to send Slack updates without reinitializing the client.

Troubleshooting
---------------
- Ensure the Slack App is installed in the workspace with the necessary scopes and that Socket Mode is enabled.
- Verify the channel ID configured in `SLACK_DEFAULT_CHANNEL` matches the channel where commands are posted.
- If the agent trigger command fails, check container logs or standard error output for diagnostic information.
