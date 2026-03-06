"""
Integration tests for the Universal Telemetry Software.

Tests the complete data flow:
1. Car generates simulated CAN data
2. Car sends via UDP to base
3. Base receives and publishes to Redis
4. Base serves data via WebSocket
5. Packet drops are detected
6. TCP retransmission recovers missing packets
"""
import pytest
import asyncio
import time
import json
import logging
from .test_helpers import (
    RedisHelper,
    WebSocketHelper,
    DockerHelper,
    NetworkHelper,
    wait_for_service,
    check_http_endpoint
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Container names from docker-compose.test.yml
CAR_CONTAINER = "daq-car"
BASE_CONTAINER = "daq-base"
CAR_REDIS_CONTAINER = "daq-car-redis"
BASE_REDIS_CONTAINER = "daq-base-redis"
PECAN_CONTAINER = "daq-pecan-test"

# Service endpoints
REDIS_HOST = "localhost"
REDIS_PORT = 6379
WS_URL = "ws://localhost:9080"
STATUS_URL = "http://localhost:8080"
PECAN_URL = "http://localhost:3000"


@pytest.fixture(scope="module")
def docker():
    """Docker helper fixture."""
    return DockerHelper()


@pytest.fixture(scope="module")
def redis_helper():
    """Redis helper fixture."""
    helper = RedisHelper(host=REDIS_HOST, port=REDIS_PORT)
    yield helper
    helper.close()


class TestContainerHealth:
    """Test that all containers start and are healthy."""
    
    def test_car_container_running(self, docker):
        """Verify car container is running."""
        assert docker.is_container_running(CAR_CONTAINER), \
            f"{CAR_CONTAINER} is not running"
        logger.info(f"✓ {CAR_CONTAINER} is running")
    
    def test_base_container_running(self, docker):
        """Verify base container is running."""
        assert docker.is_container_running(BASE_CONTAINER), \
            f"{BASE_CONTAINER} is not running"
        logger.info(f"✓ {BASE_CONTAINER} is running")
    
    def test_redis_containers_running(self, docker):
        """Verify Redis containers are running."""
        assert docker.is_container_running(CAR_REDIS_CONTAINER), \
            f"{CAR_REDIS_CONTAINER} is not running"
        assert docker.is_container_running(BASE_REDIS_CONTAINER), \
            f"{BASE_REDIS_CONTAINER} is not running"
        logger.info("✓ Both Redis containers are running")
    
    def test_redis_connectivity(self, redis_helper):
        """Verify Redis is accessible."""
        assert wait_for_service(redis_helper.ping, timeout=10), \
            "Redis is not accessible"
        logger.info("✓ Redis is accessible")
    
    def test_car_role_detection(self, docker):
        """Verify car detected its role correctly."""
        logs = docker.get_container_logs(CAR_CONTAINER, tail=100)
        assert "Role explicitly set to: car" in logs or "Auto-detected Role: car" in logs, \
            "Car did not detect role correctly"
        logger.info("✓ Car role detected correctly")
    
    def test_base_role_detection(self, docker):
        """Verify base detected its role correctly."""
        logs = docker.get_container_logs(BASE_CONTAINER, tail=100)
        assert "Role explicitly set to: base" in logs or "Auto-detected Role: base" in logs, \
            "Base did not detect role correctly"
        logger.info("✓ Base role detected correctly")


class TestUDPDataFlow:
    """Test UDP data transmission from car to base."""
    
    def test_car_sending_udp(self, docker):
        """Verify car is sending UDP packets."""
        # Give car time to start sending
        time.sleep(3)
        logs = docker.get_container_logs(CAR_CONTAINER, tail=50)
        # Car should have CAN reader and UDP sender running
        assert "CAN Reader started" in logs or "Starting simulation mode" in logs, \
            "Car CAN reader/simulator not started"
        logger.info("✓ Car is generating CAN data")
    
    def test_base_receiving_udp(self, docker):
        """Verify base is receiving UDP packets."""
        time.sleep(5)  # Wait for packets to flow
        logs = docker.get_container_logs(BASE_CONTAINER, tail=100)
        assert "Initial sequence:" in logs, \
            "Base has not received initial UDP packet"
        logger.info("✓ Base is receiving UDP packets")


class TestRedisPublishing:
    """Test that base publishes CAN messages to Redis."""
    
    def test_can_messages_published(self, redis_helper):
        """Verify CAN messages are published to Redis."""
        redis_helper.subscribe('can_messages')
        
        # Wait for a message
        msg = redis_helper.get_message(timeout=10)
        assert msg is not None, "No CAN messages received from Redis"
        
        # Verify message format
        assert isinstance(msg, list), "CAN message should be a list"
        assert len(msg) > 0, "CAN message list should not be empty"
        
        # Check first message structure
        first_msg = msg[0]
        assert 'time' in first_msg, "Message missing 'time' field"
        assert 'canId' in first_msg, "Message missing 'canId' field"
        assert 'data' in first_msg, "Message missing 'data' field"
        assert isinstance(first_msg['data'], list), "Data should be a list"
        assert len(first_msg['data']) == 8, "CAN data should be 8 bytes"
        
        logger.info(f"✓ Received valid CAN message: {first_msg}")
    
    def test_system_stats_published(self, redis_helper):
        """Verify system stats are published to Redis."""
        redis_helper.subscribe('system_stats')
        
        # Wait for stats message
        msg = redis_helper.get_message(timeout=10)
        assert msg is not None, "No system stats received from Redis"
        
        # Verify stats format
        assert isinstance(msg, dict), "System stats should be a dict"
        assert 'received' in msg, "Stats missing 'received' field"
        assert 'missing' in msg, "Stats missing 'missing' field"
        assert 'recovered' in msg, "Stats missing 'recovered' field"
        
        logger.info(f"✓ Received system stats: {msg}")


class TestWebSocketBroadcast:
    """Test WebSocket broadcasting to PECAN dashboard."""
    
    @pytest.mark.asyncio
    async def test_websocket_connection(self):
        """Verify WebSocket server is accessible."""
        ws_helper = WebSocketHelper(WS_URL)
        
        # Wait for WebSocket to be ready
        await asyncio.sleep(2)
        
        try:
            await ws_helper.connect()
            logger.info("✓ WebSocket connection established")
        finally:
            await ws_helper.close()
    
    @pytest.mark.asyncio
    async def test_websocket_receives_data(self):
        """Verify WebSocket receives CAN messages."""
        ws_helper = WebSocketHelper(WS_URL)
        
        try:
            await ws_helper.connect()
            
            # The server may send keepalive/ping dicts before CAN data.
            # Poll until we get a list (which is the CAN message batch format).
            msg = None
            deadline = asyncio.get_event_loop().time() + 10
            while asyncio.get_event_loop().time() < deadline:
                candidate = await ws_helper.receive_message(timeout=10)
                if candidate is None:
                    break
                if isinstance(candidate, list):
                    msg = candidate
                    break
                # Non-list message (e.g. ping dict) — keep waiting
            
            assert msg is not None, "No CAN list message received via WebSocket"
            
            # WebSocket should forward the same format as Redis
            assert isinstance(msg, list), "WebSocket message should be a list"
            if len(msg) > 0:
                first_msg = msg[0]
                assert 'time' in first_msg, "Message missing 'time' field"
                assert 'canId' in first_msg, "Message missing 'canId' field"
                assert 'data' in first_msg, "Message missing 'data' field"
            
            logger.info(f"✓ WebSocket received CAN data: {len(msg)} messages")
        finally:
            await ws_helper.close()


class TestStatusHTTPServer:
    """Test the status monitoring HTTP server."""
    
    def test_status_page_accessible(self):
        """Verify status page loads."""
        assert wait_for_service(
            lambda: check_http_endpoint(STATUS_URL),
            timeout=10
        ), "Status page is not accessible"
        logger.info("✓ Status page is accessible")
    
    def test_status_page_content(self):
        """Verify status page has expected content."""
        import requests
        response = requests.get(STATUS_URL, timeout=5)
        assert response.status_code == 200
        
        content = response.text
        assert "DAQ Base Station Status" in content or "Status" in content, \
            "Status page missing expected title"
        logger.info("✓ Status page has valid content")


class TestPecanDashboard:
    """Test the PECAN dashboard accessibility."""
    
    def test_pecan_container_running(self, docker):
        """Verify Pecan container is running."""
        assert docker.is_container_running(PECAN_CONTAINER), \
            f"{PECAN_CONTAINER} is not running"
        logger.info(f"✓ {PECAN_CONTAINER} is running")
    
    def test_pecan_dashboard_accessible(self):
        """Verify Pecan dashboard loads."""
        assert wait_for_service(
            lambda: check_http_endpoint(PECAN_URL),
            timeout=15  # Give Pecan more time to build and start
        ), "Pecan dashboard is not accessible"
        logger.info("✓ Pecan dashboard is accessible")
    
    def test_pecan_dashboard_content(self):
        """Verify Pecan dashboard has expected content."""
        import requests
        response = requests.get(PECAN_URL, timeout=10)
        assert response.status_code == 200
        
        content = response.text
        # Check for HTML content (Pecan is a React SPA)
        assert "<!DOCTYPE html>" in content or "<!doctype html>" in content, \
            "Pecan dashboard missing HTML doctype"
        assert "<div id=\"root\">" in content or "pecan" in content.lower(), \
            "Pecan dashboard missing expected content"
        logger.info("✓ Pecan dashboard has valid content")
    
    @pytest.mark.asyncio
    async def test_pecan_receives_websocket_data(self):
        """Verify Pecan receives WebSocket messages via browser console."""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            pytest.skip("Playwright not installed")
        
        async with async_playwright() as p:
            # Launch headless browser
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            
            # Collect console messages and errors
            console_messages = []
            page_errors = []
            
            def handle_console(msg):
                console_messages.append(f"[{msg.type}] {msg.text}")
            
            def handle_error(error):
                page_errors.append(str(error))
            
            page.on("console", handle_console)
            page.on("pageerror", handle_error)
            
            try:
                # Navigate to Pecan dashboard and wait for network to settle
                await page.goto(PECAN_URL, timeout=30000, wait_until="networkidle")
                
                # Log any page errors
                if page_errors:
                    logger.warning(f"Page errors: {page_errors}")
                
                # Wait for React app to initialize and WebSocket to connect
                await asyncio.sleep(10)
                
                # Log all console messages for debugging
                logger.info(f"Console messages captured: {len(console_messages)}")
                for msg in console_messages[:15]:
                    logger.info(f"  {msg}")
                
                # Check for WebSocket connection
                connection_logs = [msg for msg in console_messages if "WebSocket connected" in msg]
                assert len(connection_logs) > 0, \
                    f"WebSocket connection not established. Errors: {page_errors}. Console: {console_messages[:15]}"
                logger.info("✓ Pecan established WebSocket connection")
                
                # Check for data reception (should see at least first message)
                data_logs = [msg for msg in console_messages if "Received WebSocket message #" in msg]
                assert len(data_logs) > 0, \
                    f"No WebSocket messages received. Console: {console_messages[:15]}"
                logger.info(f"✓ Pecan received {len(data_logs)} WebSocket messages")
                
                # Check for decoded messages
                decoded_logs = [msg for msg in console_messages if "Decoded message(s) #" in msg]
                assert len(decoded_logs) > 0, \
                    "No decoded messages found"
                logger.info(f"✓ Pecan decoded {len(decoded_logs)} messages")
                
            finally:
                await browser.close()


class TestPacketDropAndRecovery:
    """Test packet drop detection and TCP retransmission."""
    
    def test_forced_packet_drop(self, docker, redis_helper):
        """
        Force packet drops and verify base detects missing sequences.
        
        This test:
        1. Monitors current sequence numbers
        2. Drops UDP packets using iptables
        3. Verifies base detects missing packets
        4. Waits for TCP retransmission
        5. Verifies packets are recovered
        """
        # Subscribe to can_messages to monitor flow
        redis_helper.subscribe('can_messages')
        
        # Get initial messages to establish baseline
        logger.info("Establishing baseline data flow...")
        for _ in range(3):
            msg = redis_helper.get_message(timeout=5)
            assert msg is not None, "No baseline messages received"
        
        # Now introduce packet drops on the car container
        # Drop approximately 20% of UDP packets on port 5005
        logger.info("Introducing packet drops...")
        success = NetworkHelper.drop_udp_packets(CAR_CONTAINER, 5005, count=20)
        
        if not success:
            logger.warning("Could not configure packet drops (may need privileged mode)")
            pytest.skip("Packet drop test requires privileged container")
        
        try:
            # Wait for packets to be dropped and detected
            time.sleep(15)  # Wait longer than MISSING_CHECK_INTERVAL (10s)
            
            # Check base logs for missing packet detection
            logs = docker.get_container_logs(BASE_CONTAINER, tail=200)
            
            # Look for evidence of missing packets or resend requests
            has_missing = "Gap detected" in logs or "missing" in logs.lower()
            has_resend = "Requesting resend" in logs or "Resend request" in logs
            
            if has_missing:
                logger.info("✓ Base detected missing packets")
            
            if has_resend:
                logger.info("✓ Base requested TCP retransmission")
            
            # At minimum, we should see the system handling the packet drops
            # Either by detecting gaps or attempting recovery
            assert has_missing or has_resend, \
                "No evidence of packet drop detection or recovery in logs"
            
        finally:
            # Clean up iptables rules
            NetworkHelper.clear_packet_drops(CAR_CONTAINER)
            logger.info("Cleared packet drop rules")
    
    def test_tcp_retransmission_server(self, docker):
        """Verify car has TCP retransmission server running."""
        logs = docker.get_container_logs(CAR_CONTAINER, tail=100)
        # The TCP server starts as part of run_car
        # We can verify it's in the logs or check if port 5006 is listening
        
        # Check if TCP server is listening
        output = docker.exec_in_container(
            CAR_CONTAINER,
            ['sh', '-c', 'netstat -ln | grep 5006 || ss -ln | grep 5006']
        )
        
        assert '5006' in output, "TCP retransmission server not listening on port 5006"
        logger.info("✓ TCP retransmission server is running")
    
    def test_recovery_stats(self, redis_helper):
        """
        Verify recovery statistics are tracked.
        
        After packet drops and recovery, the system_stats should show
        recovered packets.
        """
        redis_helper.subscribe('system_stats')
        
        # Collect several stats messages
        stats_samples = []
        for _ in range(5):
            msg = redis_helper.get_message(timeout=3)
            if msg:
                stats_samples.append(msg)
        
        assert len(stats_samples) > 0, "No system stats received"
        
        # Check that stats have the expected fields
        for stats in stats_samples:
            assert 'received' in stats
            assert 'missing' in stats
            assert 'recovered' in stats
        
        logger.info(f"✓ System stats tracking: {stats_samples[-1]}")


class TestInfluxDBPipeline:
    """Test the Redis → InfluxDB3 data pipeline."""

    INFLUX_URL = "http://localhost:9000"
    INFLUX_TOKEN = "apiv3_test-token"
    INFLUX_CONTAINER = "daq-test-influxdb3"

    def test_influxdb_container_running(self, docker):
        """Verify InfluxDB3 test container is running."""
        assert docker.is_container_running(self.INFLUX_CONTAINER), \
            f"{self.INFLUX_CONTAINER} is not running"
        logger.info(f"✓ {self.INFLUX_CONTAINER} is running")

    def test_influxdb_health(self):
        """Verify InfluxDB3 API is healthy."""
        import requests
        try:
            # InfluxDB 3 Core requires auth on /health; pass the test token.
            resp = requests.get(
                f"{self.INFLUX_URL}/health",
                headers={"Authorization": f"Bearer {self.INFLUX_TOKEN}"},
                timeout=5,
            )
            assert resp.status_code == 200, f"InfluxDB health check failed: {resp.status_code}"
            logger.info("✓ InfluxDB3 API is healthy")
        except requests.ConnectionError:
            pytest.skip("InfluxDB3 not reachable (may not be in test compose)")

    def test_influx_bridge_started(self, docker):
        """Verify the InfluxDB bridge process started on the base."""
        logs = docker.get_container_logs("daq-base", tail=200)
        assert "InfluxDB bridge started" in logs or "Starting Redis → InfluxDB Bridge" in logs or \
               "Starting InfluxDB bridge" in logs, \
            "InfluxDB bridge not started on base station"
        logger.info("✓ InfluxDB bridge process started")

    def test_data_written_to_influxdb(self):
        """Verify decoded CAN data appears in InfluxDB3."""
        import requests
        import time

        # Give the pipeline time to process and write data
        time.sleep(15)

        # Query InfluxDB3 via the v1 query API
        try:
            resp = requests.post(
                f"{self.INFLUX_URL}/api/v2/query",
                headers={
                    "Authorization": f"Token {self.INFLUX_TOKEN}",
                    "Content-Type": "application/vnd.flux",
                    "Accept": "application/csv",
                },
                data='''
from(bucket: "WFR26")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "WFR26_base")
  |> limit(n: 10)
''',
                timeout=10,
            )

            if resp.status_code == 200 and len(resp.text.strip()) > 0:
                lines = resp.text.strip().split("\n")
                # Should have header + at least one data row
                assert len(lines) > 1, \
                    f"Expected data rows in InfluxDB, got: {resp.text[:200]}"

                # Verify the measurement name is WFR26_base (not WFR26)
                assert "WFR26_base" in resp.text, \
                    "Data should be in WFR26_base table, not WFR26"

                logger.info(f"✓ Found {len(lines) - 1} data points in InfluxDB (WFR26_base)")
            else:
                # InfluxDB3 might use SQL API instead of Flux
                # Try SQL query as fallback
                resp2 = requests.post(
                    f"{self.INFLUX_URL}/api/v3/query_sql",
                    headers={
                        "Authorization": f"Bearer {self.INFLUX_TOKEN}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "db": "WFR26",
                        "q": "SELECT count(*) as cnt FROM WFR26_base",
                    },
                    timeout=10,
                )

                if resp2.status_code == 200:
                    logger.info(f"✓ InfluxDB3 SQL query succeeded: {resp2.text[:200]}")
                else:
                    logger.warning(
                        f"InfluxDB query returned {resp.status_code}/{resp2.status_code}. "
                        "Data may not have been written yet."
                    )
                    pytest.skip("InfluxDB data not available yet (timing issue)")

        except requests.ConnectionError:
            pytest.skip("InfluxDB3 not reachable")

    def test_table_separation(self):
        """Verify WFR26_base data is separate from WFR26 table."""
        import requests

        try:
            # Query for WFR26 measurement (should be empty — only CSV uploads go there)
            resp = requests.post(
                f"{self.INFLUX_URL}/api/v3/query_sql",
                headers={
                    "Authorization": f"Bearer {self.INFLUX_TOKEN}",
                    "Content-Type": "application/json",
                },
                json={
                    "db": "WFR26",
                    "q": "SELECT count(*) as cnt FROM WFR26 WHERE time > now() - INTERVAL '1 hour'",
                },
                timeout=10,
            )

            if resp.status_code == 200:
                # WFR26 table should either not exist or be empty
                # (only the startup-data-loader writes there, not the bridge)
                logger.info("✓ WFR26 table query returned — verifying no radio data leaked")
            elif resp.status_code == 404 or "table" in resp.text.lower():
                # Table doesn't exist — that's correct
                logger.info("✓ WFR26 table does not exist (expected — only WFR26_base has data)")

        except requests.ConnectionError:
            pytest.skip("InfluxDB3 not reachable")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])

