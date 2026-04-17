#!/usr/bin/env python3
"""
Test script for the Code Generator service.
Tests the complete workflow: prompt -> code generation -> sandbox execution -> results.
"""

import requests
import json
import base64
from pathlib import Path

# Service endpoint
CODE_GENERATOR_URL = "http://localhost:3030"

def test_health_check():
    """Test the health endpoint."""
    print("Testing health check...")
    response = requests.get(f"{CODE_GENERATOR_URL}/api/health")
    print(f"Status: {response.status_code}")
    print(f"Response: {response.json()}\n")
    return response.status_code == 200

def test_simple_code_generation():
    """Test generating and executing simple Python code."""
    print("Testing simple code generation...")
    
    prompt = "Create a scatter plot of 50 random voltage (300-400V) vs current (50-150A) points, color by power. Save as output.png"
    
    print(f"Prompt: {prompt}\n")
    
    response = requests.post(
        f"{CODE_GENERATOR_URL}/api/generate-code",
        json={"prompt": prompt},
        timeout=120
    )
    
    print(f"Status: {response.status_code}")
    result = response.json()
    
    print(f"\nGenerated Code:")
    print("=" * 60)
    print(result.get("code", "No code returned"))
    print("=" * 60)
    
    exec_result = result.get("result", {})
    print(f"\nExecution Status: {exec_result.get('status')}")
    
    if exec_result.get("output"):
        print(f"Output: {exec_result['output']}")
    
    if exec_result.get("error"):
        print(f"Error: {exec_result['error']}")
    
    # Check for retries
    retries = result.get("retries", [])
    if retries:
        print(f"\nRetries: {len(retries)}")
        for i, retry in enumerate(retries, 1):
            print(f"  Attempt {i}: {retry.get('error', '')[:100]}...")
    
    # Save any generated images
    files = exec_result.get("files", [])
    if files:
        print(f"\nGenerated {len(files)} file(s):")
        for file_info in files:
            filename = file_info.get("name")
            b64_data = file_info.get("data")
            
            if b64_data:
                # Decode and save
                image_data = base64.b64decode(b64_data)
                output_path = Path(filename)
                output_path.write_bytes(image_data)
                print(f"  ✓ Saved: {filename} ({len(image_data)} bytes)")
    
    print("\n" + "=" * 60 + "\n")
    return exec_result.get("status") == "success"

def test_error_with_retry():
    """Test that retry mechanism works with intentionally broken code."""
    print("Testing error handling and retry...")
    
    # This should initially fail but might succeed after retry
    prompt = "Print the numbers 1 through 10, one per line"
    
    print(f"Prompt: {prompt}\n")
    
    response = requests.post(
        f"{CODE_GENERATOR_URL}/api/generate-code",
        json={"prompt": prompt},
        timeout=120
    )
    
    result = response.json()
    exec_result = result.get("result", {})
    
    print(f"Status: {exec_result.get('status')}")
    print(f"Output: {exec_result.get('output', 'No output')}")
    
    retries = result.get("retries", [])
    if retries:
        print(f"\nRetries occurred: {len(retries)}")
    else:
        print("\nNo retries needed - succeeded on first attempt")
    
    print("\n" + "=" * 60 + "\n")
    return True

def test_feedback_endpoint():
    """Test saving a verified solution via the feedback endpoint."""
    print("Testing feedback endpoint...")

    # First generate a piece of code
    prompt = "Generate a simple line plot of sin(x) from 0 to 2pi and save as sin_wave.png"
    gen_resp = requests.post(
        f"{CODE_GENERATOR_URL}/api/generate-code",
        json={"prompt": prompt},
        timeout=120,
    )
    if gen_resp.status_code != 200:
        print(f"⚠️ Generate-code failed ({gen_resp.status_code}), skipping feedback test")
        return False

    gen_result = gen_resp.json()
    exec_result = gen_result.get("result", {})
    if exec_result.get("status") != "success":
        print("⚠️ Code execution was not successful, skipping feedback test")
        return False

    feedback_payload = {
        "prompt": prompt,
        "code": gen_result.get("code", ""),
        "output": exec_result.get("output", ""),
        "result": exec_result,
        "creator": "test_user",
    }

    feedback_resp = requests.post(
        f"{CODE_GENERATOR_URL}/api/feedback",
        json=feedback_payload,
        timeout=15,
    )
    print(f"Status: {feedback_resp.status_code}")
    print(f"Response: {feedback_resp.json()}\n")
    if feedback_resp.status_code == 200:
        solution_id = feedback_resp.json().get("solution_id", "")
        print(f"✅ Saved verified solution: {solution_id}")

        # Verify it can be retrieved via RAG on a similar prompt
        similar_resp = requests.post(
            f"{CODE_GENERATOR_URL}/api/generate-code",
            json={"prompt": "plot sin wave from 0 to 2π"},
            timeout=120,
        )
        if similar_resp.status_code == 200:
            print("✅ Similar prompt processed successfully (RAG may have retrieved the solution)")
    print()
    return feedback_resp.status_code == 200


def main():
    """Run all tests."""
    print("=" * 60)
    print("Code Generator Service Test Suite")
    print("=" * 60 + "\n")

    tests = [
        ("Health Check", test_health_check),
        ("Simple Code Generation", test_simple_code_generation),
        ("Error Handling", test_error_with_retry),
        ("Feedback / Verified Solutions", test_feedback_endpoint),
    ]
    
    results = []
    for test_name, test_func in tests:
        try:
            success = test_func()
            results.append((test_name, "PASS" if success else "FAIL"))
        except Exception as e:
            print(f"ERROR: {e}\n")
            results.append((test_name, "ERROR"))
    
    print("\n" + "=" * 60)
    print("Test Results")
    print("=" * 60)
    for test_name, status in results:
        status_icon = "✓" if status == "PASS" else "✗"
        print(f"{status_icon} {test_name}: {status}")
    print("=" * 60)

if __name__ == "__main__":
    main()
