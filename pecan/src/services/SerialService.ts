import { dataStore } from '../lib/DataStore';
import { webSocketService } from './WebSocketService';
import { createCanProcessor, decodeAndIngestCanFrame, formatCanId } from '../utils/canProcessor';
import { Can } from 'candied';

// Polyfill types for Web Serial API if not installed
interface SerialOptions {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: 'none' | 'even' | 'odd';
    bufferSize?: number;
    flowControl?: 'none' | 'hardware';
}

interface SerialPort {
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
}

declare global {
    interface Navigator {
        serial: {
            requestPort(options?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<SerialPort>;
            getPorts(): Promise<SerialPort[]>;
        };
    }
}

export class SerialService {
    private port: SerialPort | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private inputBuffer: string = '';
    private processorPromise: Promise<unknown>;
    private isConnected: boolean = false;
    // Hold decoder instance to parse messages
    private canInstance: Can | null = null;
    // Track previous theme to restore on disconnect
    private previousTheme: string | null = null;

    // Callbacks for UI updates (legacy, use event listener for new code)
    public onConnectionChange: ((connected: boolean) => void) | null = null;

    private notifyConnectionChange(connected: boolean) {
        this.isConnected = connected;
        if (this.onConnectionChange) this.onConnectionChange(connected);
        window.dispatchEvent(new CustomEvent('serial-connection-changed', { detail: { connected } }));
    }

    constructor() {
        this.processorPromise = createCanProcessor().then(proc => {
            this.canInstance = proc.can;
            return proc;
        });
    }

    /**
     * Request a serial port and connect to it
     */
    async connect(): Promise<boolean> {
        if (!('serial' in navigator)) {
            console.error('Web Serial API is not supported in this browser. Use Chrome/Edge/Opera.');
            alert('Your browser does not support the Web Serial API. Please use Google Chrome or Microsoft Edge.');
            return false;
        }

        try {
            // Request a port and open it
            this.port = await navigator.serial.requestPort();
            // slcan typically uses 115200 or higher depending on the adapter.
            // E.g., CANable default slcan firmware uses 115200.
            await this.port.open({ baudRate: 115200 });

            this.notifyConnectionChange(true);

            // Save current theme and apply local CAN mode theme
            this.previousTheme = localStorage.getItem("pecan:theme");
            document.documentElement.classList.add("theme-local-can");

            console.log('Serial port opened');

            // Suppression and Clear
            webSocketService.setSuppressIngestion(true);
            dataStore.clear();

            // Initialize the CAN interface via slcan protocol
            await this.initSlcan();

            // Start the read loop
            this.readLoop();

            return true;
        } catch (error) {
            console.error('Error connecting to serial port:', error);
            this.notifyConnectionChange(false);
            return false;
        }
    }

    /**
     * Initializes Lawicel/slcan adapter (e.g., CANable)
     */
    private async initSlcan() {
        // Lawicel protocol (slcan) initialization sequence
        // First, send 'C' to close the CAN channel just in case it's open
        await this.writeCommand('C\r');
        // Send 'S6' to set CAN bitrate to 500 kbit/s. 
        // S0=10k, S1=20k, S2=50k, S3=100k, S4=125k, S5=250k, S6=500k, S7=800k, S8=1M
        await this.writeCommand('S6\r');
        // Open the CAN channel
        await this.writeCommand('O\r');
        console.log('Sent slcan initialization commands (500k baud)');
    }

    /**
     * Send a command to the serial port
     */
    private async writeCommand(cmd: string) {
        if (!this.port || !this.port.writable) return;

        if (!this.writer) {
            this.writer = this.port.writable.getWriter();
        }

        const encoder = new TextEncoder();
        const data = encoder.encode(cmd);

        try {
            await this.writer.write(data);
        } catch (e) {
            console.error('Failed to write to serial port:', e);
        } finally {
            this.writer.releaseLock();
            this.writer = null; // Ensure we get a fresh writer if we need to write again
        }
    }

    /**
     * Disconnect the serial port
     */
    async disconnect() {
        try {
            this.notifyConnectionChange(false);

            // Try to close CAN channel first
            if (this.port && this.port.writable) {
                await this.writeCommand('C\r');
            }

            if (this.reader) {
                await this.reader.cancel();
                this.reader = null;
            }

            if (this.writer) {
                this.writer.releaseLock();
                this.writer = null;
            }

            if (this.port) {
                await this.port.close();
                this.port = null;
            }

            // Revert local CAN mode theme and restore previous light/dark theme
            document.documentElement.classList.remove("theme-local-can");
            if (this.previousTheme === "light") {
                document.documentElement.classList.add("theme-light");
            }

            // Resume WebSocket ingestion
            webSocketService.setSuppressIngestion(false);

            console.log('Serial port disconnected');
        } catch (error) {
            console.error('Error disconnecting serial port:', error);
        }
    }

    /**
     * Read loop for incoming serial data
     */
    private async readLoop() {
        if (!this.port || !this.port.readable) return;

        // Use a TextDecoderStream if we wanted simple parsing, but buffering manually is safer for slcan
        this.reader = this.port.readable.getReader();
        const decoder = new TextDecoder();

        try {
            while (this.isConnected) {
                const { value, done } = await this.reader.read();

                if (done) {
                    // Reader has been canceled.
                    break;
                }

                if (value) {
                    const chunk = decoder.decode(value, { stream: true });
                    this.handleSerialChunk(chunk);
                }
            }
        } catch (error) {
            console.error('Serial read loop error:', error);
        } finally {
            if (this.reader) {
                this.reader.releaseLock();
                this.reader = null;
            }
            if (this.isConnected) {
                this.disconnect();
            }
        }
    }

    /**
     * Buffer incoming chunks and split by '\r' (Lawicel carriage return separator)
     */
    private handleSerialChunk(chunk: string) {
        this.inputBuffer += chunk;

        // slcan uses \r as message terminator (and sometimes \a for error)
        let crIndex = this.inputBuffer.indexOf('\r');

        while (crIndex !== -1) {
            const message = this.inputBuffer.substring(0, crIndex);
            this.inputBuffer = this.inputBuffer.substring(crIndex + 1);

            if (message.length > 0) {
                this.parseSlcanMessage(message);
            }

            crIndex = this.inputBuffer.indexOf('\r');
        }

        // Also handle '\a' (BELL) which indicates syntax error or buffer full in slcan
        const errIndex = this.inputBuffer.indexOf('\u0007');
        if (errIndex !== -1) {
            console.warn('slcan error received (BELL character)');
            this.inputBuffer = this.inputBuffer.substring(errIndex + 1);
        }
    }

    /**
     * Parses a complete slcan formatted string e.g. "t12341A2B3C4D" -> standard CAN frame
     */
    private async parseSlcanMessage(message: string) {
        // Lawicel Format:
        // tIIIL... (Standard 11-bit: 3 hex ID digits, 1 hex DLC, then DLC*2 hex data digits)
        // TIIIIIIIILL... (Extended 29-bit: 8 hex ID digits, 1 hex DLC, then DLC*2 hex data digits)

        if (message.startsWith('t') || message.startsWith('T')) {
            const isExtended = message.startsWith('T');
            const idLen = isExtended ? 8 : 3;

            if (message.length < 1 + idLen + 1) return; // Not enough chars to read DLC

            const hexId = message.substring(1, 1 + idLen);
            const dlcChar = message.substring(1 + idLen, 1 + idLen + 1);
            const dlc = parseInt(dlcChar, 16);

            if (isNaN(dlc) || dlc < 0 || dlc > 8) return;

            // Read data bytes
            const expectedDataChars = dlc * 2;
            const dataStr = message.substring(1 + idLen + 1, 1 + idLen + 1 + expectedDataChars);

            if (dataStr.length !== expectedDataChars) return; // Incomplete payload

            const canId = parseInt(hexId, 16);

            // Parse payload to numbers
            const data: number[] = [];
            for (let i = 0; i < expectedDataChars; i += 2) {
                data.push(parseInt(dataStr.substring(i, i + 2), 16));
            }

            this.ingestFrame(canId, data);
        } else {
            // Not a 't' or 'T' message, could be a command response ('\r', 'F', etc.)
            // We can usually ignore these in a read loop
        }
    }

    /**
     * Passes the decoded canId & data arrays into our existing telemetry ingestion system
     */
    private async ingestFrame(canId: number, data: number[]) {
        if (!this.canInstance) {
            // Ensure processor is initialized if we haven't loaded it yet
            await this.processorPromise;
        }

        if (this.canInstance) {
            const time = Date.now();
            decodeAndIngestCanFrame({
                canInstance: this.canInstance,
                time,
                canId,
                data
            });
        } else {
            // Fallback if decoding fails to initialize for some reason
            const hexId = formatCanId(canId);
            const rawData = data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            dataStore.ingestMessage({
                msgID: hexId,
                messageName: `LocalCAN_${hexId}`,
                data: {},
                rawData,
                timestamp: Date.now()
            });
        }
    }

    public getConnectionStatus(): boolean {
        return this.isConnected;
    }
}

export const serialService = new SerialService();
