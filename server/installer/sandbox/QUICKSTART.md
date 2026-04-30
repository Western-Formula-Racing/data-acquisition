# Quick Start Guide: AI Code Generation Integration

This guide helps you set up and test the AI-powered code generation feature for the DAQ telemetry system.

## Prerequisites

- Docker and Docker Compose installed
- Cohere API key (get one at https://cohere.com)
- TimescaleDB with telemetry data (or use the sample data)

## Setup Steps

### 1. Configure Environment Variables

Edit `installer/.env` and add:

```bash
# Enable Slack integration (optional but recommended)
ENABLE_SLACK=true
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
SLACK_DEFAULT_CHANNEL=C0123456789

# AI Code Generation (required)
COHERE_API_KEY=your-cohere-api-key-here
COHERE_MODEL=command-r-plus
MAX_RETRIES=2
DEFAULT_SEASON_TABLE=telemetry
```

### 1.5. Set Up Custom Prompt (Recommended)

```bash
cd installer/sandbox
cp prompt-guide.txt.example prompt-guide.txt
# Edit prompt-guide.txt with your custom prompt engineering
```

**Note:** `prompt-guide.txt` is gitignored to keep your prompt engineering private.

### 2. Start the Services

From the `installer/` directory:

```bash
# Start all services
docker compose up -d

# Or start only the AI/sandbox services for testing
docker compose up -d postgresdb3 sandbox code-generator
```

### 3. Verify Services are Running

```bash
# Check all containers are up
docker compose ps

# Check code-generator logs
docker compose logs -f code-generator

# Test health endpoint
curl http://localhost:3030/api/health
```

Expected response:
```json
{"status": "ok", "service": "code-generator"}
```

## Testing

### Option 1: Test via HTTP API

```bash
curl -X POST http://localhost:3030/api/generate-code \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a scatter plot showing 50 random data points of voltage (300-400V) vs current (50-150A), colored by power. Save as output.png"
  }'
```

### Option 2: Test via Python Script

```bash
cd installer/sandbox
python3 test_code_generator.py
```

This will run a test suite and save generated images.

### Option 3: Test via Slack (if enabled)

In your Slack channel:
```
!agent create a random scatter plot of voltage vs current
```

## Example Queries for Telemetry Data

Once you have telemetry data in TimescaleDB, try these prompts:

**Basic Queries:**
```
!agent show me the latest 100 battery voltage readings
!agent plot motor temperature over the last hour
!agent what is the average inverter current today
```

**Visualizations:**
```
!agent create a line plot of battery voltage vs time for the last 2 hours
!agent scatter plot of motor RPM vs torque with color by temperature
!agent show battery state of charge trend over the last 24 hours
```

**Analysis:**
```
!agent calculate correlation between motor temperature and RPM
!agent find peak power consumption in the last race
!agent analyze inverter efficiency over time
```

## How It Works

1. **User sends prompt** via Slack (`!agent`) or HTTP API
2. **Code Generator**:
   - Receives prompt
   - Loads system prompt with TimescaleDB connection details
   - Calls Cohere AI to generate Python code
3. **Custom Sandbox**:
   - Receives generated code
   - Executes in isolated Python subprocess
   - Has internet access for TimescaleDB queries and API calls
   - Returns stdout, stderr, and generated files
4. **On Success**:
   - Returns output text and generated files (plots, data)
   - Slackbot uploads images to Slack
5. **On Failure**:
   - Error message appended to original prompt
   - Cohere generates corrected code
   - Retries up to MAX_RETRIES times

## Monitoring and Debugging

### View Logs

```bash
# All sandbox services
docker compose logs -f sandbox code-generator

# Just code generator
docker compose logs -f code-generator

# Just sandbox
docker compose logs -f sandbox

# View generated code
docker compose exec code-generator cat generated_sandbox_code.py
```

### Common Issues

**"COHERE_API_KEY not found"**
- Make sure `.env` has `COHERE_API_KEY=your-key`
- Restart services: `docker compose up -d --force-recreate code-generator`

**"Connection refused to sandbox"**
- Check sandbox is running: `docker ps | grep sandbox`
- Restart: `docker compose restart sandbox`

**"Code execution keeps failing"**
- Check the error message in Slack or API response
- Increase retries: `MAX_RETRIES=3` in `.env`
- View the system prompt: `cat installer/sandbox/prompt-guide.txt`

**"No data returned from TimescaleDB"**
- Verify database name: `DEFAULT_SEASON_TABLE=telemetry` in `.env`
- Check TimescaleDB has data: http://localhost:8888
- Verify token is correct: `POSTGRES_PASSWORD` in `.env`

## Architecture

```
┌─────────────┐
│ User (Slack)│
└──────┬──────┘
       │ !agent plot voltage
       ▼
┌──────────────────┐
│ Slackbot (Lappy) │
└────────┬─────────┘
         │ POST /api/generate-code
         ▼
┌───────────────────────┐
│  Code Generator       │
│  (Cohere AI)          │ ← System Prompt + User Prompt
└──────────┬────────────┘
           │ Generated Python Code
           ▼
┌─────────────────────────────┐
│  Custom Sandbox             │
│  • Execute code             │
│  • Query TimescaleDB (remote)  │
│  • Generate plots           │
└──────────┬────────────────┘
           │ Results (stdout, files)
           ▼
┌─────────────────────┐
│  Slackbot           │
│  • Show output      │
│  • Upload images    │
└─────────────────────┘
```

## Next Steps

1. **Customize System Prompt**: Edit `installer/sandbox/prompt-guide.txt` with your domain-specific guidance (file is gitignored)
2. **Add More Libraries**: Update `requirements-docker.txt` if you need additional Python packages in the sandbox
3. **Integrate with Grafana**: Generate Grafana-compatible dashboard JSON
4. **Add Authentication**: Implement API key or OAuth for code-generator endpoint
5. **Scale Up**: Use separate Docker Compose file for production with proper resource limits

## Security Notes

- Code executes in isolated Python subprocess with configurable timeout
- **Has internet access** for TimescaleDB queries via `slicks` and API calls
- Maximum runtime: 30 seconds (configurable via SANDBOX_TIMEOUT)
- Maximum file size: 5 MB per file (configurable via SANDBOX_MAX_FILE_MB)
- Maximum files: 10 files (configurable via SANDBOX_MAX_FILES)
- TimescaleDB credentials passed via environment only (consumed by `slicks` automatically)
- Generated code is logged for audit purposes

## Resources

- Cohere Documentation: https://docs.cohere.com
- Custom Sandbox Source: /Users/hz/GitHub/sandbox
- TimescaleDB Docs: https://docs.postgresdata.com/postgresdb/
- Slack API: https://api.slack.com

## Support

For issues or questions:
1. Check `docker compose logs <service-name>`
2. Review README files in each service directory
3. Test individual components using test scripts
4. Verify environment variables are set correctly
