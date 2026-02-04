import asyncio
import websockets
import json
import csv
import os
import time

# WebSocket server URL
WS_URL = 'ws://localhost:9080/ws'

# Path to the CAN data file (CSV format: timestamp,CAN,canId,data1,data2,data3,data4,data5,data6,data7,data8)
DATA_FILE = '2025-01-01-00-07-00.csv'  # Replace with the exact filename if different

def load_can_data(file_path):
    """Load CAN data from CSV file and format as JSON objects."""
    data = []
    if not os.path.exists(file_path):
        print(f"Error: File {file_path} not found.")
        return data
    
    with open(file_path, 'r') as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 11 or row[1] != 'CAN':
                continue  # Skip invalid rows
            try:
                message = {
                    'time': int(row[0]),
                    'canId': int(row[2]),
                    'data': [int(x) for x in row[3:11]]  # 8 data bytes
                }
                data.append(message)
            except ValueError as e:
                print(f"Skipping invalid row: {row} - {e}")
    return data

async def send_batch_websocket(websocket, batch):
    """Send a batch of CAN messages via WebSocket."""
    try:
        message = json.dumps(batch)
        await websocket.send(message)
        print(f"Sent {len(batch)} messages successfully via WebSocket.")
    except Exception as e:
        print(f"Failed to send batch: {e}")
        raise

async def main():
    can_data = load_can_data(DATA_FILE)
    if not can_data:
        print("No CAN data loaded. Exiting.")
        return

    batch_size = 100
    interval = 1 / 5  # 5 Hz = 0.2 seconds

    try:
        # Connect to WebSocket server
        print(f"Connecting to WebSocket server at {WS_URL}...")
        async with websockets.connect(WS_URL) as websocket:
            print("Connected successfully!")
            
            index = 0
            while True:
                # Get the next batch of 100 messages, wrapping around if necessary
                batch = can_data[index:index + batch_size]
                if len(batch) < batch_size:
                    # If not enough, take from the start
                    batch += can_data[:batch_size - len(batch)]
                
                await send_batch_websocket(websocket, batch)
                index = (index + batch_size) % len(can_data)
                
                # Wait for the interval
                await asyncio.sleep(interval)
                
    except websockets.exceptions.ConnectionClosed:
        print("WebSocket connection closed.")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == '__main__':
    # Install required package: pip install websockets
    try:
        import websockets
    except ImportError:
        print("Please install websockets package: pip install websockets")
        exit(1)
    
    asyncio.run(main())