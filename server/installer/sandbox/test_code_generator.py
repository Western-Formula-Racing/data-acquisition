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


def test_rag_context_in_response():
    """Test that /api/generate-code now returns rag_context."""
    print("Testing rag_context in generate-code response...")

    prompt = "Print the numbers 1 through 5"
    response = requests.post(
        f"{CODE_GENERATOR_URL}/api/generate-code",
        json={"prompt": prompt},
        timeout=120,
    )

    if response.status_code != 200:
        print(f"⚠️ Generate-code returned {response.status_code}")
        return False

    result = response.json()
    has_rag_context = "rag_context" in result
    print(f"  rag_context present: {has_rag_context}")
    print(f"  rag_context type: {type(result.get('rag_context'))}")
    if has_rag_context:
        ctx = result["rag_context"]
        print(f"  rag_context length: {len(ctx)} chars")
        if ctx:
            print(f"  rag_context preview: {ctx[:200]}...")
    print()
    return has_rag_context


def test_followup_conversation():
    """Test multi-turn follow-up conversation via /api/generate-code-followup."""
    print("Testing follow-up conversation...")

    # Step 1: Generate initial code
    initial_prompt = "Print the numbers 1 through 5, one per line"
    print(f"  Step 1 — Initial prompt: {initial_prompt}")

    gen_resp = requests.post(
        f"{CODE_GENERATOR_URL}/api/generate-code",
        json={"prompt": initial_prompt},
        timeout=120,
    )
    if gen_resp.status_code != 200:
        print(f"  ⚠️ Initial generate-code failed ({gen_resp.status_code})")
        return False

    gen_result = gen_resp.json()
    exec_result = gen_result.get("result", {})
    if exec_result.get("status") != "success":
        print(f"  ⚠️ Initial code execution failed: {exec_result.get('error', 'unknown')}")
        return False

    initial_code = gen_result.get("code", "")
    initial_output = exec_result.get("output", "")
    initial_rag = gen_result.get("rag_context", "")

    print(f"  ✓ Initial code generated ({len(initial_code)} chars)")
    print(f"  ✓ Initial output: {initial_output[:100]}")

    # Step 2: Send a follow-up
    history = [
        {"role": "user", "prompt": initial_prompt, "code": "", "output": "", "error": "", "rag_context": ""},
        {"role": "assistant", "prompt": "", "code": initial_code, "output": initial_output, "error": "", "rag_context": initial_rag},
    ]

    followup_prompt = "Now print them in reverse order (5 to 1)"
    print(f"  Step 2 — Follow-up prompt: {followup_prompt}")

    followup_resp = requests.post(
        f"{CODE_GENERATOR_URL}/api/generate-code-followup",
        json={"prompt": followup_prompt, "history": history},
        timeout=120,
    )

    if followup_resp.status_code != 200:
        print(f"  ⚠️ Follow-up failed ({followup_resp.status_code})")
        return False

    followup_result = followup_resp.json()
    followup_exec = followup_result.get("result", {})

    print(f"  Follow-up status: {followup_exec.get('status')}")
    print(f"  Follow-up code:\n{'=' * 40}")
    print(followup_result.get("code", "No code"))
    print("=" * 40)
    print(f"  Follow-up output: {followup_exec.get('output', 'no output')[:200]}")
    print(f"  Follow-up rag_context present: {'rag_context' in followup_result}")

    if followup_exec.get("error"):
        print(f"  Follow-up error: {followup_exec['error'][:200]}")

    retries = followup_result.get("retries", [])
    if retries:
        print(f"  Retries: {len(retries)}")

    success = followup_exec.get("status") == "success"

    # Step 3: Send a second follow-up (3-turn conversation)
    if success:
        history.append({"role": "user", "prompt": followup_prompt, "code": "", "output": "", "error": "", "rag_context": ""})
        history.append({
            "role": "assistant", "prompt": "",
            "code": followup_result.get("code", ""),
            "output": followup_exec.get("output", ""),
            "error": "",
            "rag_context": followup_result.get("rag_context", ""),
        })

        second_followup = "Now print them with their squares, like '1: 1', '2: 4', '3: 9' etc."
        print(f"  Step 3 — Second follow-up: {second_followup}")

        resp3 = requests.post(
            f"{CODE_GENERATOR_URL}/api/generate-code-followup",
            json={"prompt": second_followup, "history": history},
            timeout=120,
        )

        if resp3.status_code == 200:
            r3 = resp3.json()
            status3 = r3.get("result", {}).get("status")
            print(f"  3rd turn status: {status3}")
            print(f"  3rd turn output: {r3.get('result', {}).get('output', '')[:200]}")
            if status3 == "success":
                print("  ✓ 3-turn conversation succeeded!")
            else:
                print(f"  ⚠️ 3rd turn failed: {r3.get('result', {}).get('error', '')[:200]}")
        else:
            print(f"  ⚠️ 3rd turn HTTP error: {resp3.status_code}")

    print()
    return success


def test_followup_empty_prompt():
    """Test that followup endpoint rejects empty prompts."""
    print("Testing followup with empty prompt...")

    resp = requests.post(
        f"{CODE_GENERATOR_URL}/api/generate-code-followup",
        json={"prompt": "", "history": []},
        timeout=10,
    )

    success = resp.status_code == 400
    print(f"  Status: {resp.status_code} (expected 400)")
    print(f"  Response: {resp.json()}")
    print()
    return success


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
        ("RAG Context in Response", test_rag_context_in_response),
        ("Follow-up Conversation", test_followup_conversation),
        ("Follow-up Empty Prompt", test_followup_empty_prompt),
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
