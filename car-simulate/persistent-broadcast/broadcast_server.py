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
CSV_FILE = os.getenv('CSV_FILE', '2025-01-01-00-00-00.csv')
SSL_CERT = os.getenv('SSL_CERT', '/app/ssl/cert.pem')
SSL_KEY = os.getenv('SSL_KEY', '/app/ssl/key.pem')
DOMAIN = os.getenv('DOMAIN', 'ws-wfr.0001200.xyz')

# Feature flags
# Default to simulation-only for standard IDs; CSV replay can still be
# enabled explicitly via ENABLE_CSV=true if desired.
ENABLE_CSV = os.getenv('ENABLE_CSV', 'false').lower() == 'true'
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


class StandardCanSimulator:
    """
    Simulates core vehicle CAN messages defined in example.dbc using standard
    11-bit IDs:

      - 192  VCU_Status
      - 193  Pedal_Sensors
      - 512  BMS_Status
      - 768  Wheel_Speeds

    Encoding follows the DBC scale/offset so PECAN and Influx decoding remain
    consistent with the rest of the system.
    """

    VCU_ID = 192
    PEDAL_ID = 193
    BMS_ID = 512
    WHEEL_ID = 768

    def __init__(self) -> None:
        self.start_time = time.time()

    def _elapsed(self) -> float:
        return time.time() - self.start_time

    def _encode_vcu_status(self) -> list[int]:
        # Simple state machine over time: 0=Idle, 3=Drive enabled, etc.
        t = self._elapsed()
        if t % 60 < 5:
            vcu_state = 0  # idle
        elif t % 60 < 10:
            vcu_state = 2  # precharge
        else:
            vcu_state = 5  # drive
        safety_loop = 0
        inverter_enabled = 1 if vcu_state >= 5 else 0
        b0 = (vcu_state & 0x0F) | ((safety_loop & 0x01) << 4) | (
            (inverter_enabled & 0x01) << 5
        )
        return [b0] + [0x00] * 7

    def _encode_pedal_sensors(self) -> list[int]:
        # Pedal position oscillates between 0–100 % over ~10 s
        period = 10.0
        phase = (self._elapsed() % period) / period
        apps1 = 100.0 * phase
        apps2 = max(0.0, apps1 - 5.0)  # second sensor slightly lower

        def to_raw(percent: float) -> int:
            # factor 0.1 %, 16-bit
            raw = int(max(0.0, min(100.0, percent)) / 0.1)
            return max(0, min(65535, raw))

        raw1 = to_raw(apps1)
        raw2 = to_raw(apps2)
        b0 = raw1 & 0xFF
        b1 = (raw1 >> 8) & 0xFF
        b2 = raw2 & 0xFF
        b3 = (raw2 >> 8) & 0xFF
        # Simple fixed brake pressures
        raw_front = int(50.0 / 0.1)  # 50 bar
        raw_rear = int(30.0 / 0.1)   # 30 bar
        b4 = raw_front & 0xFF
        b5 = (raw_front >> 8) & 0xFF
        b6 = raw_rear & 0xFF
        b7 = (raw_rear >> 8) & 0xFF
        return [b0, b1, b2, b3, b4, b5, b6, b7]

    def _encode_bms_status(self) -> list[int]:
        # PackVoltage around 380–420 V, PackCurrent around -50–150 A
        t = self._elapsed()
        import math

        pack_v = 400.0 + 20.0 * math.sin(t / 15.0)
        pack_i = 50.0 * math.sin(t / 5.0)  # positive during charge, negative discharge
        soc = 50.0 + 30.0 * math.sin(t / 60.0)

        # factor 0.1 V / 0.1 A / 0.5 %
        raw_v = int(max(0.0, min(600.0, pack_v)) / 0.1)
        raw_i = int(max(-300.0, min(300.0, pack_i)) / 0.1) & 0xFFFF
        raw_soc = int(max(0.0, min(100.0, soc)) / 0.5)

        b0 = raw_v & 0xFF
        b1 = (raw_v >> 8) & 0xFF
        b2 = raw_i & 0xFF
        b3 = (raw_i >> 8) & 0xFF
        b4 = raw_soc & 0xFF
        b5 = 0x00  # Fault_Code low
        b6 = 0x00
        b7 = 0x00
        return [b0, b1, b2, b3, b4, b5, b6, b7]

    def _encode_wheel_speeds(self) -> list[int]:
        # Speed oscillates between 0–120 km/h (converted to ~0–3000 rpm)
        import math

        t = self._elapsed()
        speed_rpm = 1500.0 + 1500.0 * math.sin(t / 8.0)
        speed_rpm = max(0.0, min(3000.0, speed_rpm))

        raw = int(speed_rpm)  # factor 1 rpm/bit

        def pack(raw_val: int) -> tuple[int, int]:
            rv = max(0, min(65535, int(raw_val)))
            return rv & 0xFF, (rv >> 8) & 0xFF

        fl0, fl1 = pack(raw)
        fr0, fr1 = pack(raw)
        rl0, rl1 = pack(raw * 0.98)
        rr0, rr1 = pack(raw * 1.02)
        return [fl0, fl1, fr0, fr1, rl0, rl1, rr0, rr1]

    def generate_messages(self, now_ms: int) -> list[dict]:
        return [
            {"time": now_ms, "canId": self.VCU_ID, "data": self._encode_vcu_status()},
            {"time": now_ms, "canId": self.PEDAL_ID, "data": self._encode_pedal_sensors()},
            {"time": now_ms, "canId": self.BMS_ID, "data": self._encode_bms_status()},
            {"time": now_ms, "canId": self.WHEEL_ID, "data": self._encode_wheel_speeds()},
        ]


class ChargerSimulator:
    """
    Simulates an off-board charger using the extended CAN IDs that are also
    defined in example.dbc and used throughout CI:

        0x1806E5F4  (403105268)  Charger_Command
        0x18FF50E5  (419385573)  Charger_Status

    Encoding matches the DBC scaling:
      - Max_charge_voltage / Output_voltage: factor 0.1 V/bit
      - Max_charge_current / Output_current: factor 0.1 A/bit
      - Flags packed into a single status byte.
    """

    CMD_ID = 0x1806E5F4
    STS_ID = 0x18FF50E5

    def __init__(self):
        self.start_time = time.time()
        self.base_voltage = 350.0
        self.amp = 100.0  # 350–450 V swing
        self.period_s = 60.0

    def _phase(self) -> float:
        elapsed = time.time() - self.start_time
        return (elapsed % self.period_s) / self.period_s

    @staticmethod
    def _encode_voltage_current(voltage: float, current: float) -> list[int]:
        # Factor 0.1 => raw = phys / 0.1, clamped to 16-bit for voltage, 8-bit for current.
        raw_v = int(max(0.0, min(6553.5, voltage)) / 0.1)
        raw_i = int(max(0.0, min(25.5, current)) / 0.1)
        v_lo = raw_v & 0xFF
        v_hi = (raw_v >> 8) & 0xFF
        i_byte = raw_i & 0xFF
        return [v_lo, v_hi, i_byte]

    @staticmethod
    def _encode_flags(
        hardware_failure: int,
        overheat: int,
        input_voltage: int,
        starting_state: int,
        comm_state: int,
    ) -> int:
        # Pack 5 boolean flags into the low bits of one byte.
        flags = 0
        flags |= (1 if hardware_failure else 0) << 0
        flags |= (1 if overheat else 0) << 1
        flags |= (1 if input_voltage else 0) << 2
        flags |= (1 if starting_state else 0) << 3
        flags |= (1 if comm_state else 0) << 4
        return flags & 0xFF

    def generate_messages(self, now_ms: int) -> list[dict]:
        phase = self._phase()
        cmd_voltage = self.base_voltage + self.amp * phase        # 350–450 V
        cmd_current = 10.0                                        # 10 A

        sts_voltage = cmd_voltage - 5.0                           # 5 V lower
        sts_current = 8.5                                         # 8.5 A

        # Command payload
        cmd_prefix = self._encode_voltage_current(cmd_voltage, cmd_current)
        cmd_data = cmd_prefix + [0x00] * (8 - len(cmd_prefix))

        # Status payload
        sts_prefix = self._encode_voltage_current(sts_voltage, sts_current)
        flags_byte = self._encode_flags(
            hardware_failure=0,
            overheat=0,
            input_voltage=0,
            starting_state=0,
            comm_state=0,
        )
        sts_data = sts_prefix + [flags_byte] + [0x00] * (8 - len(sts_prefix) - 1)

        return [
            {"time": now_ms, "canId": self.CMD_ID, "data": cmd_data},
            {"time": now_ms, "canId": self.STS_ID, "data": sts_data},
        ]


def load_can_data(file_path: str) -> List[dict]:
    """Load CAN data from CSV file and format as JSON objects."""
    data = []
    if not os.path.exists(file_path):
        print(f"Warning: File {file_path} not found. CSV replay disabled.")
        return data
    
    print(f"Loading CAN data from {file_path}...")
    skipped_count = 0
    max_individual_logs = 5  # Limit individual error logging to avoid log spam
    
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
                skipped_count += 1
                if skipped_count <= max_individual_logs:
                    print(f"Warning: Skipping malformed CAN row due to ValueError: {row}")
    
    print(f"Loaded {len(data)} CAN messages")
    if skipped_count > 0:
        print(f"Warning: Skipped {skipped_count} malformed row(s) with ValueError during CSV loading")
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
    """Continuously broadcast CAN data + accumulator + standard + charger data."""
    batch_size = 100
    csv_interval = 0.2      # 5 Hz for CSV (optional)
    accu_interval = 0.1     # 10 Hz for accumulator
    standard_interval = 0.05  # 20 Hz for standard IDs
    charger_interval = 0.2  # 5 Hz for charger extended IDs
    
    index = 0
    last_csv_time = time.time()
    last_accu_time = time.time()
    last_standard_time = time.time()
    last_charger_time = time.time()
    msg_count = 0
    standard_sim = StandardCanSimulator()
    charger_sim = ChargerSimulator()
    
    print(
        f"Starting broadcast "
        f"(CSV: {ENABLE_CSV}, Accu: {ENABLE_ACCU}, "
        f"Standard: enabled, Charger: extended IDs enabled)"
    )
    
    while True:
        now = time.time()
        messages = []
        
        # CSV replay at 5 Hz (optional)
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

        # Standard CAN IDs at 20 Hz (disabled when CSV replay is enabled)
        if not ENABLE_CSV and (now - last_standard_time) >= standard_interval:
            last_standard_time = now
            now_ms = int(time.time() * 1000)
            messages.extend(standard_sim.generate_messages(now_ms))

        # Charger extended CAN IDs at 5 Hz (disabled when CSV replay is enabled)
        if not ENABLE_CSV and (now - last_charger_time) >= charger_interval:
            last_charger_time = now
            now_ms = int(time.time() * 1000)
            messages.extend(charger_sim.generate_messages(now_ms))
        
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

