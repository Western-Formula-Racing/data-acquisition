"""
Helper utilities for integration testing of the telemetry system.
"""
import time
import json
import redis
import asyncio
import websockets
import requests
import subprocess
import logging
from typing import List, Dict, Any, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class RedisHelper:
    """Helper for interacting with Redis during tests."""
    
    def __init__(self, host='localhost', port=6379, db=0):
        self.client = redis.Redis(host=host, port=port, db=db, decode_responses=True)
        self.pubsub = None
    
    def ping(self) -> bool:
        """Check if Redis is accessible."""
        try:
            return self.client.ping()
        except Exception as e:
            logger.error(f"Redis ping failed: {e}")
            return False
    
    def subscribe(self, channel: str):
        """Subscribe to a Redis channel."""
        self.pubsub = self.client.pubsub()
        self.pubsub.subscribe(channel)
        # Wait for subscription confirmation message
        time.sleep(0.1)  # Give subscription time to establish
        self.pubsub.get_message()  # Skip the subscription confirmation
    
    def get_message(self, timeout: float = 5.0) -> Optional[Dict[str, Any]]:
        """Get a message from subscribed channel."""
        if not self.pubsub:
            return None
        
        start_time = time.time()
        while time.time() - start_time < timeout:
            msg = self.pubsub.get_message(timeout=0.1)
            if msg and msg['type'] == 'message':
                try:
                    return json.loads(msg['data'])
                except json.JSONDecodeError:
                    return msg['data']
            # Continue waiting if we got a non-message type (subscribe, pong, etc.)
            time.sleep(0.1)
        return None
    
    def close(self):
        """Close Redis connection."""
        if self.pubsub:
            self.pubsub.close()
        self.client.close()


class WebSocketHelper:
    """Helper for testing WebSocket connections."""
    
    def __init__(self, url: str):
        self.url = url
        self.websocket = None
        self.messages = []
    
    async def connect(self):
        """Connect to WebSocket server."""
        self.websocket = await websockets.connect(self.url)
        logger.info(f"Connected to WebSocket at {self.url}")
    
    async def receive_message(self, timeout: float = 5.0) -> Optional[Dict[str, Any]]:
        """Receive a message from WebSocket."""
        try:
            msg = await asyncio.wait_for(self.websocket.recv(), timeout=timeout)
            data = json.loads(msg)
            self.messages.append(data)
            return data
        except asyncio.TimeoutError:
            logger.warning("WebSocket receive timeout")
            return None
        except Exception as e:
            logger.error(f"WebSocket receive error: {e}")
            return None
    
    async def send_message(self, data: dict):
        """Send a JSON message to WebSocket server."""
        if self.websocket:
            await self.websocket.send(json.dumps(data))

    async def close(self):
        """Close WebSocket connection."""
        if self.websocket:
            await self.websocket.close()


class DockerHelper:
    """Helper for managing Docker containers during tests."""
    
    @staticmethod
    def get_container_logs(container_name: str, tail: int = 50) -> str:
        """Get logs from a Docker container."""
        try:
            result = subprocess.run(
                ['docker', 'logs', '--tail', str(tail), container_name],
                capture_output=True,
                text=True,
                timeout=10
            )
            return result.stdout + result.stderr
        except Exception as e:
            logger.error(f"Failed to get logs for {container_name}: {e}")
            return ""
    
    @staticmethod
    def is_container_running(container_name: str) -> bool:
        """Check if a container is running."""
        try:
            result = subprocess.run(
                ['docker', 'inspect', '-f', '{{.State.Running}}', container_name],
                capture_output=True,
                text=True,
                timeout=5
            )
            return result.stdout.strip() == 'true'
        except Exception as e:
            logger.error(f"Failed to check container {container_name}: {e}")
            return False
    
    @staticmethod
    def exec_in_container(container_name: str, command: List[str]) -> str:
        """Execute a command inside a container."""
        try:
            result = subprocess.run(
                ['docker', 'exec', container_name] + command,
                capture_output=True,
                text=True,
                timeout=10
            )
            return result.stdout
        except Exception as e:
            logger.error(f"Failed to exec in {container_name}: {e}")
            return ""


class NetworkHelper:
    """Helper for network manipulation (packet drops, etc.)."""
    
    @staticmethod
    def drop_udp_packets(container_name: str, port: int, count: int = 5):
        """
        Drop UDP packets using iptables inside a container.
        This simulates network packet loss.
        """
        try:
            # Add iptables rule to drop packets
            cmd = [
                'iptables', '-A', 'OUTPUT',
                '-p', 'udp', '--dport', str(port),
                '-m', 'statistic', '--mode', 'random',
                '--probability', str(count / 100.0),
                '-j', 'DROP'
            ]
            
            result = subprocess.run(
                ['docker', 'exec', '--privileged', container_name] + cmd,
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                logger.info(f"Added packet drop rule in {container_name}")
                return True
            else:
                logger.error(f"Failed to add iptables rule: {result.stderr}")
                return False
        except Exception as e:
            logger.error(f"Failed to configure packet drops: {e}")
            return False
    
    @staticmethod
    def clear_packet_drops(container_name: str):
        """Clear iptables rules to restore normal network."""
        try:
            cmd = ['iptables', '-F', 'OUTPUT']
            subprocess.run(
                ['docker', 'exec', '--privileged', container_name] + cmd,
                capture_output=True,
                timeout=5
            )
            logger.info(f"Cleared packet drop rules in {container_name}")
        except Exception as e:
            logger.error(f"Failed to clear iptables rules: {e}")


def wait_for_service(check_func, timeout: float = 30.0, interval: float = 1.0) -> bool:
    """
    Wait for a service to become available.
    
    Args:
        check_func: Function that returns True when service is ready
        timeout: Maximum time to wait in seconds
        interval: Time between checks in seconds
    
    Returns:
        True if service became available, False if timeout
    """
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            if check_func():
                return True
        except Exception as e:
            logger.debug(f"Service check failed: {e}")
        time.sleep(interval)
    
    return False


def check_http_endpoint(url: str, expected_status: int = 200) -> bool:
    """Check if an HTTP endpoint is responding."""
    try:
        response = requests.get(url, timeout=5)
        return response.status_code == expected_status
    except Exception:
        return False
