export type TxSample = {
  msgID: string;
  messageName: string;
  rawData: string;
  timestamp: number;
  data: Record<string, { sensorReading: number; unit: string }>;
};

class TxDataStore {
  private latest = new Map<string, TxSample>();

  ingestTx(msg: TxSample) {
    this.latest.set(msg.msgID, msg);
  }

  getAllLatest() {
    return this.latest;
  }
}

export const txDataStore = new TxDataStore();