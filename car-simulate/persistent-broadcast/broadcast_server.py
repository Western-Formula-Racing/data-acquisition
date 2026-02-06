import asyncio
import websockets
import json
import csv
import os
import ssl
import math
import random
import time
from typing import List, Set
from websockets.server import WebSocketServerProtocol

# Configuration from environment variables
WS_PORT = int(os.getenv('WS_PORT', '9080'))
WSS_PORT = int(os.getenv('WSS_PORT', '9443'))
CSV_FILE = os.getenv('CSV_FILE', '2025-01-01-00-07-00.csv')
SSL_CERT = os.getenv('SSL_CERT', '/app/ssl/cert.pem')
SSL_KEY = os.getenv('SSL_KEY', '/app/ssl/key.pem')
DOMAIN = os.getenv('DOMAIN', 'ws-wfr.0001200.xyz')

# Feature flags
ENABLE_CSV = os.getenv('ENABLE_CSV', 'true').lower() == 'true'
ENABLE_ACCU = os.getenv('ENABLE_ACCU', 'true').lower() == 'true'

# Global set to track connected clients
connected_clients: Set[WebSocketServerProtocol] = set()

# ============================================================================
# Accumulator Simulation Parameters
# ============================================================================

NUM_MODULES = 5
CELLS_PER_MODULE = 20
THERMISTORS_PER_MODULE = 18
MIN_VOLTAGE = 3.0
MAX_VOLTAGE = 4.2
VOLTAGE_NOISE = 0.02
CELL_IMBALANCE = 0.05
AMBIENT_TEMP = 25.0
TEMP_NOISE = 1.0
MAX_TEMP = 55.0

VOLTAGE_MSG_IDS = {
    'M1': [1006, 1007, 1008, 1009, 1010],
    'M2': [1011, 1012, 1013, 1014, 1015],
    'M3': [1016, 1017, 1018, 1019, 1020],
    'M4': [1021, 1022, 1023, 1024, 1025],
    'M5': [1026, 1027, 1028, 1029, 1030],
}

TEMP_MSG_IDS = {
    'M1': [1031, 1032, 1033, 1034, 1035],
    'M2': [1036, 1037, 1038, 1039, 1040],
    'M3': [1041, 1042, 1043, 1044, 1045],
    'M4': [1046, 1047, 1048, 1049, 1050],
    'M5': [1051, 1052, 1053, 1054, 1055],
}


class AccumulatorSimulator:
    """Simulates FSAE EV accumulator with realistic charging behavior."""
    
    def __init__(self):
        self.soc = 0.5
        self.charging = True
        self.charge_rate = 0.001
        self.cell_offsets = {}
        for module in range(1, NUM_MODULES + 1):
            self.cell_offsets[module] = [
                random.uniform(-CELL_IMBALANCE/2, CELL_IMBALANCE/2)
                for _ in range(CELLS_PER_MODULE)
            ]
        self.module_temp_base = {1: 0.0, 2: 2.0, 3: 3.0, 4: 2.0, 5: 0.0}
        self.start_time = time.time()
    
    def update(self, dt: float):
        if self.charging:
            self.soc = min(1.0, self.soc + self.charge_rate * dt)
            if self.soc >= 0.98:
                self.charging = False
        else:
            self.soc = max(0.0, self.soc - self.charge_rate * dt * 0.5)
            if self.soc <= 0.2:
                self.charging = True
    
    def get_cell_voltage(self, module: int, cell: int) -> float:
        base_voltage = MIN_VOLTAGE + (MAX_VOLTAGE - MIN_VOLTAGE) * self.soc
        offset = self.cell_offsets[module][cell - 1]
        noise = random.gauss(0, VOLTAGE_NOISE)
        elapsed = time.time() - self.start_time
        drift = 0.01 * math.sin(elapsed / 30 + module + cell * 0.1)
        return max(MIN_VOLTAGE, min(MAX_VOLTAGE, base_voltage + offset + noise + drift))
    
    def get_thermistor_temp(self, module: int, thermistor: int) -> float:
        base = AMBIENT_TEMP + self.module_temp_base[module]
        activity_heat = 5.0 if self.charging else 2.0
        position_factor = 1.0 - abs(thermistor - 9) / 9
        position_heat = position_factor * 3.0
        noise = random.gauss(0, TEMP_NOISE)
        elapsed = time.time() - self.start_time
        drift = 2.0 * math.sin(elapsed / 60 + module * 0.5)
        return max(10.0, min(MAX_TEMP + 10, base + activity_heat + position_heat + noise + drift))
    
    def encode_voltage_message(self, module: int, msg_idx: int) -> list:
        start_cell = msg_idx * 4 + 1
        data = []
        for i in range(4):
            cell = start_cell + i
            if cell <= CELLS_PER_MODULE:
                voltage = self.get_cell_voltage(module, cell)
                raw = int(voltage / 0.0001)
                raw = max(0, min(65535, raw))
            else:
                raw = 0
            data.append(raw & 0xFF)
            data.append((raw >> 8) & 0xFF)
        return data
    
    def encode_temp_message(self, module: int, msg_idx: int) -> list:
        start_therm = msg_idx * 4 + 1
        data = []
        for i in range(4):
            therm = start_therm + i
            if therm <= THERMISTORS_PER_MODULE:
                temp = self.get_thermistor_temp(module, therm)
                raw = int(temp / 0.001)
                raw = max(0, min(65535, raw))
            else:
                raw = 0
            data.append(raw & 0xFF)
            data.append((raw >> 8) & 0xFF)
        return data
    
    def generate_messages(self) -> List[dict]:
        messages = []
        current_time = int(time.time() * 1000)
        for module_num in range(1, NUM_MODULES + 1):
            module_key = f'M{module_num}'
            for msg_idx, can_id in enumerate(VOLTAGE_MSG_IDS[module_key]):
                data = self.encode_voltage_message(module_num, msg_idx)
                messages.append({'time': current_time, 'canId': can_id, 'data': data})
            for msg_idx, can_id in enumerate(TEMP_MSG_IDS[module_key]):
                data = self.encode_temp_message(module_num, msg_idx)
                messages.append({'time': current_time, 'canId': can_id, 'data': data})
        return messages


def load_can_data(file_path: str) -> List[dict]:
    """Load CAN data from CSV file and format as JSON objects."""
    data = []
    if not os.path.exists(file_path):
        print(f"Warning: File {file_path} not found. CSV replay disabled.")
        return data
    
    print(f"Loading CAN data from {file_path}...")
    with open(file_path, 'r') as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 11 or row[1] != 'CAN':
                continue
            try:
                message = {
                    'time': int(row[0]),
                    'canId': int(row[2]),
                    'data': [int(x) for x in row[3:11]]
                }
                data.append(message)
            except ValueError:
                # Skip rows with invalid numeric values but continue processing other rows
                print(f"Warning: Skipping malformed CAN row due to ValueError: {row}")
    
    print(f"Loaded {len(data)} CAN messages")
    return data


async def handle_client(websocket: WebSocketServerProtocol):
    connected_clients.add(websocket)
    client_info = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
    print(f"Client connected: {client_info} (Total: {len(connected_clients)})")
    
    try:
        async for message in websocket:
            print(f"Received from {client_info}: {message[:100]}")
    except websockets.exceptions.ConnectionClosed:
        # Connection closed by client; ignore and proceed to cleanup in finally block
        print(f"Connection closed by client: {client_info}")
    finally:
        connected_clients.discard(websocket)
        print(f"Client disconnected: {client_info} (Total: {len(connected_clients)})")


async def broadcast_data(can_data: List[dict], accu_sim: AccumulatorSimulator):
    """Continuously broadcast CAN data + accumulator data to all connected clients."""
    batch_size = 100
    csv_interval = 0.2  # 5 Hz for CSV
    accu_interval = 0.1  # 10 Hz for accumulator
    
    index = 0
    last_csv_time = time.time()
    last_accu_time = time.time()
    msg_count = 0
    
    print(f"Starting broadcast (CSV: {ENABLE_CSV}, Accu: {ENABLE_ACCU})")
    
    while True:
        now = time.time()
        messages = []
        
        # CSV replay at 5 Hz
        if ENABLE_CSV and can_data and (now - last_csv_time) >= csv_interval:
            last_csv_time = now
            batch = can_data[index:index + batch_size]
            if len(batch) < batch_size:
                batch += can_data[:batch_size - len(batch)]
            messages.extend(batch)
            index = (index + batch_size) % len(can_data)
        
        # Accumulator at 10 Hz
        if ENABLE_ACCU and (now - last_accu_time) >= accu_interval:
            dt = now - last_accu_time
            last_accu_time = now
            accu_sim.update(dt)
            messages.extend(accu_sim.generate_messages())
        
        # Broadcast if we have clients and messages
        if connected_clients and messages:
            message_json = json.dumps(messages)
            disconnected = set()
            
            for client in connected_clients:
                try:
                    await client.send(message_json)
                except Exception:
                    disconnected.add(client)
            
            for client in disconnected:
                connected_clients.discard(client)
            
            msg_count += len(messages)
            if msg_count % 1000 < 100:
                print(f"Broadcasted {len(messages)} msgs to {len(connected_clients)} clients | Total: {msg_count}")
        
        await asyncio.sleep(0.05)


async def start_ws_server():
    """Start the WebSocket server (ws://)."""
    print(f"Starting WebSocket server on port {WS_PORT}...")
    async with websockets.serve(handle_client, "0.0.0.0", WS_PORT):
        print(f"WebSocket server (ws) running on port {WS_PORT}")
        await asyncio.Future()


async def start_wss_server():
    """Start the secure WebSocket server (wss://)."""
    if not os.path.exists(SSL_CERT) or not os.path.exists(SSL_KEY):
        print(f"Warning: SSL certs not found. WSS disabled.")
        return
    
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain(SSL_CERT, SSL_KEY)
    
    print(f"Starting secure WebSocket server on port {WSS_PORT}...")
    async with websockets.serve(handle_client, "0.0.0.0", WSS_PORT, ssl=ssl_context):
        print(f"Secure WebSocket server (wss) running on port {WSS_PORT}")
        await asyncio.Future()


async def main():
    """Main entry point."""
    can_data = load_can_data(CSV_FILE) if ENABLE_CSV else []
    accu_sim = AccumulatorSimulator()
    
    print(f"\n{'='*60}")
    print("PECAN Broadcast Server")
    print(f"{'='*60}")
    print(f"Domain: {DOMAIN}")
    print(f"CSV Replay: {'Enabled' if ENABLE_CSV and can_data else 'Disabled'}")
    print(f"Accumulator Sim: {'Enabled' if ENABLE_ACCU else 'Disabled'}")
    print(f"WS: ws://0.0.0.0:{WS_PORT}")
    print(f"WSS: wss://0.0.0.0:{WSS_PORT}")
    print()
    
    tasks = [
        asyncio.create_task(start_ws_server()),
        asyncio.create_task(broadcast_data(can_data, accu_sim)),
    ]
    
    if os.path.exists(SSL_CERT) and os.path.exists(SSL_KEY):
        tasks.append(asyncio.create_task(start_wss_server()))
    
    await asyncio.gather(*tasks)


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutting down...")

