import os
import base64
import json
import datetime
from pathlib import Path
from threading import Event

import requests
from slack_sdk.web import WebClient
from slack_sdk.socket_mode import SocketModeClient
from slack_sdk.socket_mode.request import SocketModeRequest
from slack_sdk.socket_mode.response import SocketModeResponse

processed_messages = set()

# Track recent successful interactions per user for the !approve command
# Key: user_id, Value: dict with prompt/code/output/rag_context
_recent_success: dict[str, dict] = {}

# Track pending approvals keyed by user_id
# Value: dict with prompt/code/output/result/creator + bot_message_ts + channel
pending_approvals: dict[str, dict] = {}

# --- Logging Configuration ---
LOG_DIR = Path("/app/logs")
LOG_DIR.mkdir(parents=True, exist_ok=True)

# --- Slack App Configuration ---
app_token = os.environ["SLACK_APP_TOKEN"]
bot_token = os.environ["SLACK_BOT_TOKEN"]

print(f"DEBUG: Loaded SLACK_APP_TOKEN: {app_token[:9]}...{app_token[-4:]} (Length: {len(app_token)})")
print(f"DEBUG: Loaded SLACK_BOT_TOKEN: {bot_token[:9]}...{bot_token[-4:]} (Length: {len(bot_token)})")

web_client = WebClient(token=bot_token)
socket_client = SocketModeClient(
    app_token=app_token,
    web_client=web_client,
    trace_enabled=True,  # Enable debug logging
    ping_interval=30,    # Send ping every 30 seconds
    auto_reconnect_enabled=True
)

WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL")
DEFAULT_CHANNEL = os.environ.get("SLACK_DEFAULT_CHANNEL", "C08NTG6CXL5")
CODE_GENERATOR_URL = os.environ.get("CODE_GENERATOR_URL", "http://code-generator:3030")


# --- Public helper functions ---
def send_slack_message(channel: str, text: str, **kwargs):
    """Send a text message to a Slack channel."""
    return web_client.chat_postMessage(channel=channel, text=text, **kwargs)


def send_slack_image(channel: str, file_path: str, **kwargs):
    """Upload an image/file to a Slack channel."""
    upload_kwargs = {
        "channel": channel,
        "file": file_path,
        "filename": os.path.basename(file_path),
    }
    upload_kwargs.update(kwargs)
    return web_client.files_upload_v2(**upload_kwargs)

def log_interaction(user, instructions, result, status, error=None):
    """Log the entire interaction to a file."""
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    log_entry_dir = LOG_DIR / f"{timestamp}_{user}"
    log_entry_dir.mkdir(parents=True, exist_ok=True)

    log_data = {
        "timestamp": timestamp,
        "user": user,
        "instructions": instructions,
        "status": status,
        "error": error,
        "generated_code": result.get("code", ""),
        "output": result.get("result", {}).get("output", "")
    }

    # Save textual log
    with open(log_entry_dir / "interaction.json", "w") as f:
        json.dump(log_data, f, indent=4)

    # Save generated files (images)
    exec_result = result.get("result", {})
    files = exec_result.get("files", [])
    for file_info in files:
        filename = file_info.get("name")
        b64_data = file_info.get("data")
        file_type = file_info.get("type")
        
        if file_type == "image" and b64_data:
            try:
                image_data = base64.b64decode(b64_data)
                (log_entry_dir / filename).write_bytes(image_data)
            except Exception as e:
                print(f"Error saving log image {filename}: {e}")

    print(f"📝 Logged interaction to {log_entry_dir}")


# --- Slack Command Handlers ---
# Not currently used: handle_location
def handle_location(user, thread_ts=None, channel=None):
    channel = channel or DEFAULT_CHANNEL
    try:
        response = requests.get("http://lap-detector-server:8050/api/track?type=location", timeout=5)
        response.raise_for_status()
        loc = response.json().get("location", {})
        lat, lon = loc.get("lat"), loc.get("lon")
        if lat is None or lon is None:
            raise ValueError("Location payload missing lat/lon")
        map_url = f"https://www.google.com/maps/@{lat},{lon},17z"
        send_slack_message(
            channel,
            text=(
                f"📍 <@{user}> Current :daqcar: location:\n"
                f"<{map_url}|View on Map>\nLatitude: {lat}\nLongitude: {lon}"
            ),
            thread_ts=thread_ts,
        )
    except Exception as exc:
        print("Error fetching location:", exc)
        send_slack_message(
            channel,
            text=f"❌ <@{user}> Failed to retrieve car location. Error: {exc}",
            thread_ts=thread_ts,
        )


def handle_testimage(user, thread_ts=None, channel=None):
    channel = channel or DEFAULT_CHANNEL
    try:
        send_slack_image(
            channel,
            file_path="lappy_test_image.png",
            title="Lappy Test Image",
            initial_comment=f"🖼️ <@{user}> Here's the test image:",
            thread_ts=thread_ts,
        )
    except Exception as exc:
        print("Error uploading image:", exc)
        send_slack_message(
            channel,
            text=f"❌ <@{user}> Failed to upload image. Error: {exc}",
            thread_ts=thread_ts,
        )


def handle_agent(user, command_full, thread_ts=None, timeout=120, channel=None):
    """
    Handle !agent command - sends request to code-generator service.
    Supports AI-powered code generation and execution.
    """
    channel = channel or DEFAULT_CHANNEL
    parts = command_full.split(maxsplit=1)
    instructions = parts[1].strip() if len(parts) > 1 else ""
    if not instructions:
        send_slack_message(
            channel,
            text=f"⚠️ <@{user}> Please provide instructions after `!agent`.",
            thread_ts=thread_ts,
        )
        return

    # Send initial acknowledgment
    timeout_msg = f" (extended timeout: {timeout}s)" if timeout > 120 else ""
    send_slack_message(
        channel,
        text=f"🤖 <@{user}> Processing your request: `{instructions[:100]}...`\nGenerating code with AI...{timeout_msg}",
        thread_ts=thread_ts,
    )

    try:
        # Call code-generator service
        response = requests.post(
            f"{CODE_GENERATOR_URL}/api/generate-code",
            json={"prompt": instructions},
            timeout=timeout
        )
        response.raise_for_status()
        result = response.json()
        
        # Check if retries occurred
        retries = result.get("retries", [])
        if retries:
            retry_msg = f"⚠️ Initial code had errors. Retried {len(retries)} time(s) with error feedback."
            send_slack_message(channel, text=retry_msg, thread_ts=thread_ts)
        
        # Get execution result
        exec_result = result.get("result", {})
        status = exec_result.get("status", "unknown")
        
        if status == "success":
            # Success - send output and files
            output = exec_result.get("output", "")
            files = exec_result.get("files", [])
            
            success_msg = f"✅ <@{user}> Code executed successfully!"
            if retries:
                success_msg += f" (after {len(retries)} retry/retries)"

            success_reply = send_slack_message(channel, text=success_msg, thread_ts=thread_ts)
            bot_ts = (success_reply.get("ts") if isinstance(success_reply, dict) else None) or thread_ts

            # Send output if any
            if output:
                output_msg = f"**Output:**\n```\n{output[:2000]}\n```"
                send_slack_message(channel, text=output_msg, thread_ts=thread_ts)
            
            # Send generated files (images, etc.)
            for file_info in files:
                filename = file_info.get("name")
                b64_data = file_info.get("data")
                file_type = file_info.get("type")
                
                if file_type == "image" and b64_data:
                    try:
                        # Decode base64 and save temporarily
                        temp_path = Path(f"/tmp/{filename}")
                        image_data = base64.b64decode(b64_data)
                        temp_path.write_bytes(image_data)
                        
                        # Upload to Slack
                        send_slack_image(
                            channel,
                            str(temp_path),
                            title=f"Generated: {filename}",
                            initial_comment=f"📊 <@{user}> Here's your visualization:",
                            thread_ts=thread_ts
                        )
                        
                        # Clean up
                        temp_path.unlink()
                    except Exception as e:
                        print(f"Error uploading image {filename}: {e}")
                        send_slack_message(
                            channel,
                            text=f"⚠️ Could not upload image {filename}: {e}",
                            thread_ts=thread_ts
                        )
            
            # Log successful interaction
            log_interaction(user, instructions, result, "success")

            # Store result so user can approve it later with !approve or :+1:
            exec_result = result.get("result", {})
            _recent_success[user] = {
                "prompt": instructions,
                "code": result.get("code", ""),
                "output": exec_result.get("output", ""),
                "result": exec_result,
                "creator": user,
            }
            pending_approvals[user] = _recent_success[user].copy()
            pending_approvals[user]["bot_ts"] = bot_ts
            pending_approvals[user]["channel"] = channel

            # Prompt user to approve via reaction or command
            send_slack_message(
                channel,
                text=(
                    f"_React with :+1: to save this as a verified example, "
                    f"or type `!approve` in this thread._"
                ),
                thread_ts=thread_ts,
            )
            print(f"✅ Result stored for user {user} — pending approval via reaction or !approve")
        
        else:
            # Execution failed
            error = exec_result.get("error", "Unknown error")
            max_retries_reached = result.get("max_retries_reached", False)
            
            error_msg = f"❌ <@{user}> Code execution failed"
            if max_retries_reached:
                error_msg += f" after {len(retries)} retries"
            error_msg += f":\n```\n{error[:1500]}\n```"
            
            send_slack_message(channel, text=error_msg, thread_ts=thread_ts)
            
            # Log failed interaction
            log_interaction(user, instructions, result, "failed", error)
    
    except requests.exceptions.Timeout:
        send_slack_message(
            channel,
            text=f"⏱️ <@{user}> Request timed out. The task might be too complex or the service is busy.",
            thread_ts=thread_ts,
        )
        log_interaction(user, instructions, {}, "timeout", "Request timed out")
    except requests.exceptions.RequestException as e:
        send_slack_message(
            channel,
            text=f"❌ <@{user}> Failed to connect to code generation service: {e}",
            thread_ts=thread_ts,
        )
        log_interaction(user, instructions, {}, "connection_error", str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        send_slack_message(
            channel,
            text=f"❌ <@{user}> Unexpected error: {e}",
            thread_ts=thread_ts,
        )
        log_interaction(user, instructions, {}, "unexpected_error", str(e))


def handle_wx(user, command_full, thread_ts=None, channel=None):
    """Handle !wx [ICAO] command - fetches METAR and TAF from NOAA Aviation Weather API."""
    channel = channel or DEFAULT_CHANNEL
    parts = command_full.split()
    icao = parts[1].strip().upper() if len(parts) > 1 else "CYXU"

    if len(icao) != 4 or not icao.isalpha():
        send_slack_message(
            channel,
            text=f"<@{user}> Invalid ICAO code `{icao}`. Must be 4 letters (e.g. `!wx CYYZ`).",
            thread_ts=thread_ts,
        )
        return

    base_url = "https://aviationweather.gov/api/data"
    try:
        metar_resp = requests.get(f"{base_url}/metar?ids={icao}&format=json", timeout=10)
        taf_resp = requests.get(f"{base_url}/taf?ids={icao}&format=json", timeout=10)
        metar_resp.raise_for_status()
        taf_resp.raise_for_status()
        metar_data = metar_resp.json()
        taf_data = taf_resp.json()
    except requests.exceptions.Timeout:
        send_slack_message(channel, text=f"<@{user}> Aviation Weather API timed out.", thread_ts=thread_ts)
        return
    except Exception as exc:
        send_slack_message(channel, text=f"<@{user}> Failed to fetch weather data: {exc}", thread_ts=thread_ts)
        return

    if not metar_data and not taf_data:
        send_slack_message(
            channel,
            text=f"<@{user}> No weather data found for `{icao}`. Is that a valid ICAO?",
            thread_ts=thread_ts,
        )
        return

    lines = [f"*Weather for {icao}*"]

    if metar_data:
        raw = metar_data[0].get("rawOb", "N/A")
        lines.append(f"\n*METAR*\n```{raw}```")
    else:
        lines.append(f"\n*METAR* — not available for `{icao}`")

    if taf_data:
        raw = taf_data[0].get("rawTAF", "N/A")
        lines.append(f"*TAF*\n```{raw}```")
    else:
        lines.append("*TAF* — not available")

    send_slack_message(channel, text="\n".join(lines), thread_ts=thread_ts)


def _do_approve(user, channel, pending, thread_ts=None):
    """Send pending result to /api/feedback and acknowledge in thread."""
    try:
        feedback_payload = {
            "prompt": pending["prompt"],
            "code": pending["code"],
            "output": pending.get("output", ""),
            "creator": user,
        }
        resp = requests.post(
            f"{CODE_GENERATOR_URL}/api/feedback",
            json=feedback_payload,
            timeout=15,
        )
        if resp.ok:
            solution_data = resp.json()
            solution_id = solution_data.get("solution_id", "")
            _recent_success[user] = pending.copy()
            _recent_success[user]["solution_id"] = solution_id
            send_slack_message(
                channel,
                text=f"✅ <@{user}> Saved as a verified example (id: `{solution_id}`). "
                     "Future similar queries will reference this solution.",
                thread_ts=thread_ts,
            )
        else:
            send_slack_message(
                channel,
                text=f"❌ <@{user}> Failed to save: {resp.status_code} {resp.text}",
                thread_ts=thread_ts,
            )
    except Exception as e:
        send_slack_message(
            channel,
            text=f"❌ <@{user}> Error saving verified example: {e}",
            thread_ts=thread_ts,
        )


def handle_approve(user, thread_ts=None, channel=None):
    """Re-save the most recent successful result as a verified solution (golden example)."""
    channel = channel or DEFAULT_CHANNEL
    recent = pending_approvals.get(user) or _recent_success.get(user)
    if not recent:
        send_slack_message(
            channel,
            text=f"⚠️ <@{user}> No recent successful result found to approve. "
                 "Run `!agent` first and make sure it succeeds.",
            thread_ts=thread_ts,
        )
        return

    _do_approve(user, channel, recent, thread_ts=thread_ts)
    pending_approvals.pop(user, None)



def handle_aistats(user, thread_ts=None, channel=None):
    """Fetch and display observability stats + dashboard PNG from code-generator."""
    channel = channel or DEFAULT_CHANNEL
    send_slack_message(
        channel,
        text=f"🤖 <@{user}> Fetching AI observability stats...",
        thread_ts=thread_ts,
    )
    try:
        resp = requests.get(f"{CODE_GENERATOR_URL}/api/metrics", timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        send_slack_message(
            channel,
            text=f"❌ <@{user}> Failed to fetch metrics: {e}",
            thread_ts=thread_ts,
        )
        return

    stats = data.get("stats", {})
    rag = stats.get("rag_stats", {})
    png_b64 = data.get("dashboard_png", "")

    # Build summary text
    total = stats.get("total_generations", 0)
    if total == 0:
        summary = (
            "*AI Observability — No data yet*\n"
            "Run `!agent` a few times to start collecting metrics."
        )
    else:
        def pct(v): return f"{v * 100:.1f}%"

        summary_lines = [
            "*AI Observability Stats*",
            "",
            f"*Total generations:* {total}",
            f"*Success rate:* {pct(stats.get('success_rate', 0))}  "
            f"({stats.get('success_count', 0)}/{total})",
            f"*Avg retry count:* {stats.get('avg_retry_count', 0):.2f}",
            f"*Avg sandbox duration:* {stats.get('avg_sandbox_ms', 0):.0f} ms",
            "",
            "*Cache hit rates:*",
            f"  LLM cache:  {pct(stats.get('llm_cache_hit_rate', 0))}",
            f"  Exec cache: {pct(stats.get('exec_cache_hit_rate', 0))}",
            "",
            "*RAG Vector Space:*",
        ]
        for coll, info in rag.items():
            label = coll.replace("_", " ").title()
            summary_lines.append(f"  {label}: {info.get('count', 0):,} vectors")

        summary = "\n".join(summary_lines)

    send_slack_message(channel, text=summary, thread_ts=thread_ts)

    if png_b64:
        try:
            img_data = base64.b64decode(png_b64)
            tmp_path = Path("/tmp/aistats_dashboard.png")
            tmp_path.write_bytes(img_data)
            send_slack_image(
                channel,
                str(tmp_path),
                title="AI Observability Dashboard",
                initial_comment=f"📊 <@{user}> Observability dashboard:",
                thread_ts=thread_ts,
            )
            tmp_path.unlink()
        except Exception as e:
            send_slack_message(
                channel,
                text=f"⚠️ Could not render dashboard: {e}",
                thread_ts=thread_ts,
            )

    rag_png_b64 = data.get("rag_viz_png", "")
    if rag_png_b64:
        try:
            img_data = base64.b64decode(rag_png_b64)
            tmp_path = Path("/tmp/aistats_rag_viz.png")
            tmp_path.write_bytes(img_data)
            send_slack_image(
                channel,
                str(tmp_path),
                title="RAG Vector Space",
                initial_comment=f"🔮 <@{user}> RAG vector space (PCA projection):",
                thread_ts=thread_ts,
            )
            tmp_path.unlink()
        except Exception as e:
            send_slack_message(
                channel,
                text=f"⚠️ Could not render RAG viz: {e}",
                thread_ts=thread_ts,
            )



    channel = channel or DEFAULT_CHANNEL
    help_text = (
        f"📘 <@{user}> Available Commands:\n"
        "```\n"
        "!help                      - Show this help message.\n"
        "!wx                        - METAR + TAF for CYXU (London Intl).\n"
        "!wx <ICAO>                 - METAR + TAF for a specific airport.\n"
        "                              Example: !wx CYYZ\n"
        "!location                  - Show the current :daqcar: location.\n"
        "!testimage                 - Upload the bundled Lappy test image.\n"
        "!agent <instructions>      - Generate and execute Python code using AI.\n"
        "                              Timeout: 120s (2 minutes)\n"
        "                              Example: !agent plot inverter voltage vs current\n"
        "!agent-debug <instructions> - Same as !agent but with extended timeout.\n"
        "                              Timeout: 1200s (20 minutes)\n"
        "                              Use for complex analysis or large datasets.\n"
        "                              Automatically retries up to 2 times if code fails.\n"
        "!approve                   - Save your most recent successful !agent result as a\n"
        "                              verified example (golden sample) for future queries.\n"
        "!aistats                   - Show AI code-generator observability dashboard:\n"
        "                              cache hit rates, success rate, sandbox duration,\n"
        "                              retry distribution, and RAG vector space stats.\n"
        "```\n"
        "💬 React with :+1: on the result message — same as !approve, just quicker.\n"
        "💬 Verified examples make future !agent queries smarter.\n"
        "💬 Tip: You can also DM me these commands directly!"
    )
    send_slack_message(channel, text=help_text, thread_ts=thread_ts)


# --- Event Processing Logic ---
def process_events(client: SocketModeClient, req: SocketModeRequest):
    try:
        if req.type != "events_api":
            return

        client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))
        event = req.payload.get("event", {})

        # ── Reaction added (thumbs-up to approve a result) ──────────────────────
        if event.get("type") == "reaction_added":
            reaction_user = event.get("user")
            reaction_name = event.get("reaction")
            item = event.get("item", {})
            reaction_channel = item.get("channel")
            reaction_ts = item.get("ts")

            if reaction_name == "thumbsup":
                pending = pending_approvals.get(reaction_user)
                if (
                    pending
                    and pending.get("channel") == reaction_channel
                    and pending.get("bot_ts") == reaction_ts
                ):
                    _do_approve(reaction_user, reaction_channel, pending)
                    del pending_approvals[reaction_user]
            return

        if event.get("type") != "message" or event.get("subtype") is not None:
            return

        # Get channel type - check if it's a DM or the default channel
        channel = event.get("channel")
        channel_type = event.get("channel_type")
        
        # Allow messages from default channel or DMs (im = direct message)
        is_dm = channel_type == "im"
        is_default_channel = channel == DEFAULT_CHANNEL
        
        if not (is_dm or is_default_channel):
            return

        msg_ts = event.get("ts")
        if msg_ts in processed_messages:
            print(f"Skipping already processed message: {msg_ts}")
            return

        processed_messages.add(msg_ts)
        if len(processed_messages) > 1000:
            oldest_ts = sorted(processed_messages)[0]
            processed_messages.remove(oldest_ts)

        user = event.get("user")
        bot_user_id = os.environ.get("SLACK_BOT_USER_ID", "U08P8KS8K25")
        if user == bot_user_id:
            print(f"Skipping message from bot itself ({bot_user_id}).")
            return

        text = event.get("text", "").strip()
        if not text.startswith("!"):
            return

        command_full = text[1:]
        command_parts = command_full.split()
        main_command = command_parts[0] if command_parts else ""

        print(
            f"Received command: '{command_full}' from user {user} "
            f"in {'DM' if is_dm else f'channel {channel}'}"
        )

        # Get thread_ts - use the message timestamp to create/reply to thread
        # For DMs, thread_ts is the same as msg_ts
        thread_ts = event.get("thread_ts") or msg_ts
        
        # For DM responses, use the DM channel; otherwise use DEFAULT_CHANNEL
        response_channel = channel if is_dm else DEFAULT_CHANNEL

        if main_command == "wx":
            handle_wx(user, command_full, thread_ts, response_channel)
        elif main_command == "location":
            handle_location(user, thread_ts, response_channel)
        elif main_command == "testimage":
            handle_testimage(user, thread_ts, response_channel)
        elif main_command == "agent":
            handle_agent(user, command_full, thread_ts, timeout=120, channel=response_channel)
        elif main_command == "agent-debug":
            handle_agent(user, command_full, thread_ts, timeout=1200, channel=response_channel)
        elif main_command == "help":
            handle_help(user, thread_ts, response_channel)
        elif main_command == "approve":
            handle_approve(user, thread_ts, response_channel)
        elif main_command == "aistats":
            handle_aistats(user, thread_ts, response_channel)
        else:
            send_slack_message(
                response_channel,
                text=f"❓ <@{user}> Unknown command: `{text}`. Try `!help`.",
                thread_ts=thread_ts,
            )
    except Exception as e:
        import traceback
        print(f"❌ Error processing event: {e}")
        traceback.print_exc()
        try:
            # Try to notify the user about the error
            if 'user' in locals() and 'response_channel' in locals():
                send_slack_message(
                    response_channel,
                    text=f"❌ <@{user}> An error occurred while processing your command. Please try again later.",
                    thread_ts=locals().get('thread_ts')
                )
        except Exception:
            # If even error notification fails, just log it
            print("Failed to send error notification to Slack")


# --- Main Execution ---
if __name__ == "__main__":
    print("🟢 Bot attempting to connect...")
    print("🔍 Testing Slack API connectivity...")
    
    # Test basic connectivity first
    try:
        response = requests.get("https://slack.com/api/api.test", timeout=10)
        print(f"✓ Slack API reachable: {response.status_code}")
    except requests.exceptions.Timeout:
        print("❌ Timeout connecting to Slack API - check firewall/network")
    except Exception as e:
        print(f"❌ Cannot reach Slack API: {e}")
    
    socket_client.socket_mode_request_listeners.append(process_events)
    try:
        print("🔌 Connecting to Slack WebSocket...")
        socket_client.connect()
        if WEBHOOK_URL:
            requests.post(
                WEBHOOK_URL,
                json={"text": "Lappy on duty! :lappy:"},
                timeout=5,
            )
        else:
            print("⚠️ SLACK_WEBHOOK_URL not configured - skipping webhook notification")
        print("🟢 Bot connected and listening for messages.")
        Event().wait()
    except KeyboardInterrupt:
        print("\n🛑 Bot shutting down...")
        socket_client.close()
    except Exception as exc:
        print(f"🔴 Bot failed to connect: {exc}")
        print("💡 Possible causes:")
        print("   - Firewall blocking outbound WebSocket connections (port 443)")
        print("   - Invalid tokens (check SLACK_APP_TOKEN and SLACK_BOT_TOKEN)")
        print("   - Network connectivity issues")
        import traceback

        traceback.print_exc()
