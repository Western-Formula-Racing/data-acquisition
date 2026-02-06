#!/usr/bin/env python3
"""
Fake Accumulator Data Generator for FSAE EV Testing

Simulates 5 accumulator modules with realistic FSAE EV battery parameters:
- 20 cells per module (LiFePO4/NMC @ ~3.0-4.2V nominal)
- 18 thermistors per module
- Realistic voltage variations and temperature gradients

Sends data via WebSocket in the expected CAN format.

Usage:
  python accumulator_simulator.py           # Local dev (ws://localhost:9080)
  python accumulator_simulator.py --remote  # Remote server (wss://ws-wfr.0001200.xyz)
"""

import asyncio
import json
import math
import random
import time
import sys
import os

# WebSocket server URL - supports both local dev and remote
# Local dev: connects to Vite's WebSocket server on port 9080
# Remote: connects to the cloud WebSocket server
WS_URL_LOCAL = 'ws://localhost:9080'
WS_URL_REMOTE = os.getenv('WSS_URL', 'wss://ws-wfr.0001200.xyz')

# Determine which URL to use
USE_REMOTE = '--remote' in sys.argv or os.getenv('USE_REMOTE', '').lower() == 'true'
WS_URL = WS_URL_REMOTE if USE_REMOTE else WS_URL_LOCAL

# ============================================================================
# FSAE EV Battery Parameters (Realistic values)
# ============================================================================

# Battery cell configuration (assumes NMC or LFP cells)
NOMINAL_VOLTAGE = 3.6      # V (nominal cell voltage)
MIN_VOLTAGE = 3.0          # V (fully discharged)
MAX_VOLTAGE = 4.2          # V (fully charged)
VOLTAGE_NOISE = 0.02       # V (random variation)
CELL_IMBALANCE = 0.05      # V (max difference between cells)

# Temperature parameters
AMBIENT_TEMP = 25.0        # °C
TEMP_NOISE = 1.0           # °C (random variation)
MAX_TEMP = 55.0            # °C (warning threshold)

# Module configuration
NUM_MODULES = 5
CELLS_PER_MODULE = 20
THERMISTORS_PER_MODULE = 18

# CAN Message IDs from DBC (TORCH BMS format)
# Voltages: 4 cells per message, 5 messages per module
VOLTAGE_MSG_IDS = {
    'M1': [1006, 1007, 1008, 1009, 1010],  # TORCH_M1_V1-V5
    'M2': [1011, 1012, 1013, 1014, 1015],  # TORCH_M2_V1-V5
    'M3': [1016, 1017, 1018, 1019, 1020],  # TORCH_M3_V1-V5
    'M4': [1021, 1022, 1023, 1024, 1025],  # TORCH_M4_V1-V5
    'M5': [1026, 1027, 1028, 1029, 1030],  # TORCH_M5_V1-V5
}

# Temperatures: 4 thermistors per message, 5 messages per module (last one has 2)
TEMP_MSG_IDS = {
    'M1': [1031, 1032, 1033, 1034, 1035],  # TORCH_M1_T1-T5
    'M2': [1036, 1037, 1038, 1039, 1040],  # TORCH_M2_T1-T5
    'M3': [1041, 1042, 1043, 1044, 1045],  # TORCH_M3_T1-T5
    'M4': [1046, 1047, 1048, 1049, 1050],  # TORCH_M4_T1-T5
    'M5': [1051, 1052, 1053, 1054, 1055],  # TORCH_M5_T1-T5
}


class AccumulatorSimulator:
    """Simulates FSAE EV accumulator with realistic charging behavior."""
    
    def __init__(self):
        # State of charge (0-1)
        self.soc = 0.5
        self.charging = True
        self.charge_rate = 0.001  # SOC per second
        
        # Per-module cell imbalances (persisted)
        self.cell_offsets = {}
        for module in range(1, NUM_MODULES + 1):
            self.cell_offsets[module] = [
                random.uniform(-CELL_IMBALANCE/2, CELL_IMBALANCE/2)
                for _ in range(CELLS_PER_MODULE)
            ]
        
        # Per-module thermal characteristics
        self.module_temp_base = {
            1: 0.0,   # Center modules run slightly hotter
            2: 2.0,
            3: 3.0,   # Middle module hottest
            4: 2.0,
            5: 0.0,
        }
        
        self.start_time = time.time()
    
    def update(self, dt: float):
        """Update simulation state."""
        if self.charging:
            self.soc = min(1.0, self.soc + self.charge_rate * dt)
            if self.soc >= 0.98:
                self.charging = False
        else:
            self.soc = max(0.0, self.soc - self.charge_rate * dt * 0.5)
            if self.soc <= 0.2:
                self.charging = True
    
    def get_cell_voltage(self, module: int, cell: int) -> float:
        """Get voltage for a specific cell."""
        # Base voltage from SOC
        base_voltage = MIN_VOLTAGE + (MAX_VOLTAGE - MIN_VOLTAGE) * self.soc
        
        # Add cell-specific offset
        offset = self.cell_offsets[module][cell - 1]
        
        # Add random noise
        noise = random.gauss(0, VOLTAGE_NOISE)
        
        # Add slight time-based drift
        elapsed = time.time() - self.start_time
        drift = 0.01 * math.sin(elapsed / 30 + module + cell * 0.1)
        
        voltage = base_voltage + offset + noise + drift
        return max(MIN_VOLTAGE, min(MAX_VOLTAGE, voltage))
    
    def get_thermistor_temp(self, module: int, thermistor: int) -> float:
        """Get temperature for a specific thermistor."""
        # Base temperature
        base = AMBIENT_TEMP + self.module_temp_base[module]
        
        # Temperature rises with charging/discharging
        activity_heat = 5.0 if self.charging else 2.0
        
        # Position-based variation (edges cooler than center)
        position_factor = 1.0 - abs(thermistor - 9) / 9  # 0 at edges, 1 at center
        position_heat = position_factor * 3.0
        
        # Random noise
        noise = random.gauss(0, TEMP_NOISE)
        
        # Slight time-based drift
        elapsed = time.time() - self.start_time
        drift = 2.0 * math.sin(elapsed / 60 + module * 0.5)
        
        temp = base + activity_heat + position_heat + noise + drift
        return max(10.0, min(MAX_TEMP + 10, temp))
    
    def encode_voltage_message(self, module: int, msg_idx: int) -> list[int]:
        """Encode 4 cell voltages into CAN message bytes.
        
        Format: 4x 16-bit unsigned, scale 0.0001V
        """
        start_cell = msg_idx * 4 + 1
        data = []
        
        for i in range(4):
            cell = start_cell + i
            if cell <= CELLS_PER_MODULE:
                voltage = self.get_cell_voltage(module, cell)
                # Scale: 0.0001V per bit
                raw = int(voltage / 0.0001)
                raw = max(0, min(65535, raw))
            else:
                raw = 0
            
            # Little-endian 16-bit
            data.append(raw & 0xFF)
            data.append((raw >> 8) & 0xFF)
        
        return data
    
    def encode_temp_message(self, module: int, msg_idx: int) -> list[int]:
        """Encode 4 thermistor temperatures into CAN message bytes.
        
        Format: 4x 16-bit unsigned, scale 0.001°C
        """
        start_therm = msg_idx * 4 + 1
        data = []
        
        for i in range(4):
            therm = start_therm + i
            if therm <= THERMISTORS_PER_MODULE:
                temp = self.get_thermistor_temp(module, therm)
                # Scale: 0.001°C per bit
                raw = int(temp / 0.001)
                raw = max(0, min(65535, raw))
            else:
                raw = 0
            
            # Little-endian 16-bit
            data.append(raw & 0xFF)
            data.append((raw >> 8) & 0xFF)
        
        return data
    
    def generate_messages(self) -> list[dict]:
        """Generate all CAN messages for one update cycle."""
        messages = []
        current_time = int(time.time() * 1000)
        
        for module_num in range(1, NUM_MODULES + 1):
            module_key = f'M{module_num}'
            
            # Voltage messages (5 per module)
            for msg_idx, can_id in enumerate(VOLTAGE_MSG_IDS[module_key]):
                data = self.encode_voltage_message(module_num, msg_idx)
                messages.append({
                    'time': current_time,
                    'canId': can_id,
                    'data': data
                })
            
            # Temperature messages (5 per module)
            for msg_idx, can_id in enumerate(TEMP_MSG_IDS[module_key]):
                data = self.encode_temp_message(module_num, msg_idx)
                messages.append({
                    'time': current_time,
                    'canId': can_id,
                    'data': data
                })
        
        return messages


async def main():
    """Main loop: simulate and send data."""
    simulator = AccumulatorSimulator()
    
    update_rate = 10  # Hz
    interval = 1.0 / update_rate
    
    print(f"Starting Accumulator Simulator")
    print(f"  Modules: {NUM_MODULES}")
    print(f"  Cells per module: {CELLS_PER_MODULE}")
    print(f"  Thermistors per module: {THERMISTORS_PER_MODULE}")
    print(f"  Update rate: {update_rate} Hz")
    print()
    
    while True:
        try:
            print(f"Connecting to WebSocket server at {WS_URL}...")
            async with websockets.connect(WS_URL) as websocket:
                print("Connected!")
                print()
                
                last_update = time.time()
                msg_count = 0
                
                while True:
                    now = time.time()
                    dt = now - last_update
                    last_update = now
                    
                    # Update simulation state
                    simulator.update(dt)
                    
                    # Generate and send messages
                    messages = simulator.generate_messages()
                    await websocket.send(json.dumps(messages))
                    
                    msg_count += len(messages)
                    
                    # Status every 5 seconds
                    if msg_count % (update_rate * 5 * len(messages)) < len(messages):
                        avg_v = sum(
                            simulator.get_cell_voltage(1, c)
                            for c in range(1, 5)
                        ) / 4
                        print(
                            f"SOC: {simulator.soc*100:.1f}% | "
                            f"Charging: {'Yes' if simulator.charging else 'No'} | "
                            f"Avg Cell V: {avg_v:.3f}V | "
                            f"Messages sent: {msg_count}"
                        )
                    
                    # Wait for next cycle
                    await asyncio.sleep(interval)
                    
        except websockets.exceptions.ConnectionClosed:
            print("WebSocket connection closed. Reconnecting in 2s...")
            await asyncio.sleep(2)
        except ConnectionRefusedError:
            print(f"Cannot connect to {WS_URL}. Retrying in 5s...")
            await asyncio.sleep(5)
        except Exception as e:
            print(f"Error: {e}. Retrying in 5s...")
            await asyncio.sleep(5)


if __name__ == '__main__':
    try:
        import websockets
    except ImportError:
        print("Please install websockets: pip install websockets")
        exit(1)
    
    print("=" * 60)
    print("FSAE EV Accumulator Simulator")
    print("=" * 60)
    print()
    
    asyncio.run(main())
