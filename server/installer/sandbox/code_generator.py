"""
Code Generation Service - Orchestrator for Cohere + Sandbox execution.
Receives requests from Slackbot, generates code using Cohere, and executes in sandbox.
"""

from __future__ import annotations

import os
import base64
from pathlib import Path
from typing import Dict, Any

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS
import cohere
import requests

# Load environment variables
load_dotenv()

# ---------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------
COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError(
        "COHERE_API_KEY not found in environment. Add it to your .env or export it as an env var."
    )

COHERE_MODEL = os.getenv("COHERE_MODEL", "command-a-reasoning-08-2025")
SANDBOX_URL = os.getenv("SANDBOX_URL", "http://sandbox-runner:9090")
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "2"))

# Configure Cohere client
co = cohere.Client(COHERE_API_KEY)

# Paths
BASE_DIR = Path(__file__).resolve().parent
PROMPT_GUIDE_PATH = BASE_DIR / "prompt-guide.txt"
GENERATED_CODE_PATH = BASE_DIR / "generated_sandbox_code.py"

# ---------------------------------------------------------------------
# Flask App Setup
# ---------------------------------------------------------------------
app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------------------
def load_prompt_guide() -> str:
    """Reads the prompt guide file."""
    if PROMPT_GUIDE_PATH.exists():
        return PROMPT_GUIDE_PATH.read_text().strip()
    
    # Minimal fallback if file doesn't exist
    return """You are an expert Python data analyst. Generate clean, executable Python code.
Rules:
- No user input (no input(), sys.stdin)
- Save visualizations to files (plt.savefig())
- Include all necessary imports
- Return only executable code"""


def extract_python_code(raw_output: str) -> str:
    """
    Extract ```python ...``` fenced code if present.
    Falls back to raw text if no fence.
    """
    text = raw_output.strip()
    if "```" not in text:
        return text

    segments = text.split("```")
    for idx, segment in enumerate(segments):
        if idx % 2 == 0:
            continue
        stripped = segment.strip()
        if not stripped:
            continue
        if stripped.lower().startswith("python"):
            lines = stripped.splitlines()
            return "\n".join(lines[1:]) if len(lines) > 1 else ""
        return stripped

    return text


def request_python_code(guide: str, prompt: str) -> str:
    """Request Python code from Cohere."""
    # Combine guide and user prompt
    full_prompt = f"{guide}\n\n{prompt}"

    response = co.chat(
        message=full_prompt,
        model=COHERE_MODEL,
        temperature=0.2,
    )

    # Extract Python code from response
    raw_output = response.text
    python_code = extract_python_code(raw_output)

    # Save generated code
    GENERATED_CODE_PATH.write_text(python_code, encoding="utf-8")
    print(f"Generated code written to {GENERATED_CODE_PATH}")

    return python_code


def submit_code_to_sandbox(code: str) -> Dict[str, Any]:
    """Submit code to the custom sandbox for execution."""
    try:
        response = requests.post(
            SANDBOX_URL,
            json={"code": code},
            timeout=60
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error submitting to sandbox: {e}")
        return {
            "ok": False,
            "std_err": str(e),
            "std_out": "",
            "return_code": -1,
            "output_files": []
        }


def format_error_for_retry(sandbox_result: Dict[str, Any]) -> str:
    """Format sandbox error for retry prompt."""
    error_parts = []
    
    if sandbox_result.get("std_err"):
        error_parts.append(f"ERROR_TRACE: {sandbox_result['std_err'].strip()}")
    
    if sandbox_result.get("std_out"):
        error_parts.append(f"OUTPUT: {sandbox_result['std_out'].strip()}")
    
    return_code = sandbox_result.get("return_code")
    if return_code != 0:
        error_parts.insert(0, f"STATUS: ERROR (return code: {return_code})")
    
    return "\n".join(error_parts)


def format_sandbox_result(sandbox_result: Dict[str, Any]) -> Dict[str, Any]:
    """Format sandbox result for response."""
    # Process output files from custom sandbox
    files_info = []
    for file_data in sandbox_result.get("output_files", []):
        file_info = {
            "name": file_data.get("filename"),
            "data": file_data.get("b64_data"),
            "type": "image" if file_data.get("filename", "").endswith((".png", ".jpg", ".jpeg", ".gif", ".svg")) else "file"
        }
        files_info.append(file_info)
    
    result = {
        "status": "success" if sandbox_result.get("ok") else "error",
        "output": sandbox_result.get("std_out", "").strip(),
        "error": sandbox_result.get("std_err", "").strip(),
        "return_code": sandbox_result.get("return_code"),
        "files": files_info
    }
    return result


# ---------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------
@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "service": "code-generator"})


@app.route('/api/generate-code', methods=['POST'])
def generate_code():
    """Generate and execute Python code based on user prompt with automatic retries on failure."""
    try:
        data = request.get_json()
        user_prompt = data.get('prompt', '').strip()
        
        if not user_prompt:
            return jsonify({"error": "Prompt is required"}), 400

        # Load the prompt guide
        guide = load_prompt_guide()
        
        retry_info = []
        current_prompt = user_prompt
        python_code = None
        
        # Try up to MAX_RETRIES + 1 times (initial attempt + retries)
        for attempt in range(MAX_RETRIES + 1):
            print(f"\n{'='*60}")
            print(f"Attempt {attempt + 1}/{MAX_RETRIES + 1}")
            print(f"{'='*60}\n")
            
            # Generate Python code using Cohere
            python_code = request_python_code(guide, current_prompt)

            # Execute the code in sandbox
            sandbox_result = submit_code_to_sandbox(python_code)
            
            # Check if execution was successful
            if sandbox_result.get("ok"):
                # Success! Format and return result
                result = format_sandbox_result(sandbox_result)
                
                response = {
                    "code": python_code,
                    "result": result
                }
                
                # Include retry information if any retries were made
                if retry_info:
                    response["retries"] = retry_info
                    print(f"✅ Success after {len(retry_info)} retry/retries")
                
                return jsonify(response)
            
            # Execution failed
            if attempt < MAX_RETRIES:
                # We have retries left
                error_message = format_error_for_retry(sandbox_result)
                retry_info.append({
                    "attempt": attempt + 1,
                    "error": error_message
                })
                
                print(f"\n{'='*60}")
                print(f"RETRY {attempt + 1}/{MAX_RETRIES} - Code execution failed")
                print(f"{'='*60}")
                print(error_message)
                print(f"\n{'='*60}")
                print("Retrying with error feedback...")
                print(f"{'='*60}\n")
                
                # Append error to prompt for retry
                current_prompt = f"""{user_prompt}

The previous code generated had the following error:

{error_message}

Please fix the code to address this error."""
            else:
                # No more retries left, return the error
                print(f"\n{'='*60}")
                print(f"❌ All {MAX_RETRIES} retries exhausted - returning error")
                print(f"{'='*60}\n")
                result = format_sandbox_result(sandbox_result)
                
                return jsonify({
                    "code": python_code,
                    "result": result,
                    "retries": retry_info,
                    "max_retries_reached": True
                })

    except Exception as e:
        print(f"Error in generate_code: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            "error": str(e),
            "code": None,
            "result": {
                "status": "error",
                "error": str(e),
                "output": "",
                "files": []
            }
        }), 500


# ---------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------
def main():
    """Start the code generation service."""
    port = int(os.getenv("CODE_GEN_PORT", "3030"))
    debug = os.getenv("DEBUG", "false").lower() == "true"
    
    print(f"Starting code generation service on http://0.0.0.0:{port}")
    print(f"Cohere Model: {COHERE_MODEL}")
    print(f"Sandbox URL: {SANDBOX_URL}")
    print(f"Max Retries: {MAX_RETRIES}")
    
    app.run(host='0.0.0.0', port=port, debug=debug)


if __name__ == "__main__":
    main()
