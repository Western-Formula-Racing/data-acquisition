import pytest
import asyncio
import time
import json
import logging
from .test_helpers import (
    RedisHelper,
    DockerHelper,
    wait_for_service,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PECAN_URL = "http://localhost:3000"
REDIS_CAN_CHANNEL = "can_messages"
PECAN_CONTAINER = "daq-pecan-test"

async def check_http_endpoint_async(url: str) -> bool:
    """Async check if an HTTP endpoint is responding."""
    import aiohttp
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=2) as response:
                return response.status == 200
    except Exception:
        return False

@pytest.mark.asyncio
async def test_can_to_ui_flow():
    """
    End-to-End Test: CAN Message -> UI Update.
    Verifies that a message published to Redis appears in the Pecan Dashboard DOM.
    """
    try:
        from playwright.async_api import async_playwright, expect
    except ImportError:
        pytest.skip("Playwright not installed")

    # Ensure environment is ready
    # Check for Docker OR local developer environment
    docker = DockerHelper()
    redis = RedisHelper()
    
    is_docker = docker.is_container_running(PECAN_CONTAINER)
    is_local_pecan = await check_http_endpoint_async(PECAN_URL)
    is_redis_ready = redis.ping()

    if not (is_docker or is_local_pecan):
        pytest.skip(f"Pecan Dashboard not found (checked Docker {PECAN_CONTAINER} and {PECAN_URL})")
    
    if not is_redis_ready:
        pytest.skip("Redis not found (checked localhost:6379). E2E test requires Redis.")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_page()
        
        # Navigate to Pecan dashboard
        logger.info(f"Navigating to {PECAN_URL}")
        await context.goto(PECAN_URL, wait_until="networkidle")
        
        # Wait for WebSocket connection (confirmed by console log usually, but we'll just wait)
        await asyncio.sleep(2)
        
        # 1. Measurement start
        t_start = time.monotonic()
        
        # 2. Inject CAN message through Redis (simulating arrival at Base Station)
        test_can_id = 0x123 # 291
        test_data = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11]
        test_data_hex = "AA BB CC DD EE FF 00 11"
        
        test_msg = [{
            "time": int(time.time() * 1000),
            "canId": test_can_id,
            "data": test_data
        }]
        
        redis = RedisHelper()
        logger.info(f"Injecting CAN ID 0x{test_can_id:X} into Redis")
        redis.client.publish(REDIS_CAN_CHANNEL, json.dumps(test_msg))
        
        # 3. Wait for DOM update
        # DataRow displays:
        # - ID: "291 (0x123)"
        # - Data: "AA BB CC DD EE FF 00 11"
        
        id_selector = f"text=291 (0x123)"
        data_selector = f"text={test_data_hex}"
        
        try:
            # Wait for the row to appear
            await expect(context.locator(id_selector)).to_be_visible(timeout=10000)
            logger.info("✓ CAN ID visible in UI")
            
            # Wait for the data to match
            await expect(context.locator(data_selector)).to_be_visible(timeout=5000)
            logger.info("✓ CAN data visible in UI")
            
            t_end = time.monotonic()
            latency_ms = (t_end - t_start) * 1000
            logger.info(f"✓ E2E Latency (Redis -> UI): {latency_ms:.1f}ms")
            
            # 4. Verify Frequency (Hz) updates
            # Since we only sent one message, Hz should be 1/2s = 0.5Hz eventually,
            # but it might take a moment to calculate.
            # We'll just check that it's NOT "STOPPED" if we send a burst.
            
            logger.info("Sending burst to verify Hz calculation...")
            for i in range(5):
                await asyncio.sleep(0.1)
                test_msg[0]["time"] = int(time.time() * 1000)
                redis.client.publish(REDIS_CAN_CHANNEL, json.dumps(test_msg))
            
            # Frequency should be > 0
            # locator for the Hz value in the same row
            # We can use sibling selectors or just search for "Hz"
            await expect(context.locator(f"div:has-text('291 (0x123)') >> text=Hz")).to_be_visible(timeout=5000)
            logger.info("✓ Frequency (Hz) visible in UI")
            
        except Exception as e:
            # Take screenshot on failure
            await context.screenshot(path="e2e_failure.png")
            logger.error(f"E2E Test Failed: {e}")
            raise
        finally:
            redis.close()
            await browser.close()

if __name__ == "__main__":
    # To run: pytest test_ui_e2e.py
    pass
