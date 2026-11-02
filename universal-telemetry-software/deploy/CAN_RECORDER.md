# CAN Recorder

`can-recorder.service` is the car's complete, permanent record of the CAN bus. Base-station logging (CSV and TimescaleDB) stays in place for now, but it only holds what reached it over the link.

It runs separately from `car-telemetry.service`, opens its own socket on `can0`, and uses only the Python standard library. Restarting or crashing telemetry does not interrupt recording.

## What a power cut costs

Software can't save frames that are still in RAM when power disappears. It can only keep that window short and make sure everything before it survives.

| Situation | Frames lost at a power cut | Evidence |
|---|---|---|
| Nothing else writing to the card | About the last 0.1-0.2 s | Longest gap between commits: 165 ms at full bus rate |
| Another process wrote a 200 MiB burst | Up to about 0.5 s with `99-can-recorder.conf`, 3.6 s without | Measured |
| Another process writes continuously | Up to about 4.5 s with the conf file, 18 s without | Measured with 1 GiB |
| Storage acknowledges a flush it did not complete | Unknown | **Only the power-cut test below can tell** |
| Power-fail detection and hold-up power (not built yet) | None expected | Design target |

Recordings made before the lost window stay readable. The format has no footer, so there is nothing to close, and damage is limited to the block being written.

Measured on 2026-11-01 on a Pi 5 (16 GB) with its 58 GB SD card, using vcan and 30-second runs:

| Frame rate | Frames lost | CPU (one core) | Disk use |
|---|---|---:|---:|
| 1,500/s | 0 of 45,000 | 1.5% | 149 MB/h |
| 4,500/s (500 kbps bus at 100%) | 0 of 135,000 | 3.1% | 444 MB/h |
| 20,000/s | 0 of 300,000 | 10.1% | 1,771 MB/h |

vcan tests the software and the SD card only. It says nothing about the CAN controller, which is the weak point (see [Known gaps](#known-gaps)).

## How it works

```
can0 -> reader thread -> in-memory queue -> writer thread -> write + fdatasync
```

- **Reader:** never touches the disk, so a stalled card only grows the queue, which holds about 7 minutes at full bus rate. It stores kernel receive timestamps and the raw `struct can_frame`, including the DLC and the extended, RTR and error flags that the UDP format discards. Error frames are recorded too, so bus-off events and controller overflows are timestamped.
- **Writer:** commits one block every 100 ms (`--commit-ms`). Each block has a CRC, starts on a 4 KiB boundary and is padded to one, so committed sectors are never rewritten and a torn write can't reach earlier data.
- **Files:** `/var/lib/can-recorder/run-NNNNNN/seg-NNNNNN.wcan`. Each process start is a new run, numbered from what is on disk because the clock can't be trusted at boot. Each minute is a new segment. Old files are never reopened.
- **Faults:** after a failed write or sync, the block is written again to a new segment, and readers ignore the duplicate. If `can0` is missing or bounces, the recorder keeps retrying. If the writer hangs, the systemd watchdog restarts it.

Parquet would be the wrong format here: its footer is written last, so a power cut could lose the whole file.

## Install

`/boot/firmware/config.txt` on the car Pi needs this line, followed by a reboot. The setup scripts don't set it, so this is the repo's only record of it:

```
dtoverlay=mcp2515-can0,oscillator=12000000,interrupt=17,spimaxfrequency=4000000
```

Then run these from `universal-telemetry-software/`:

```bash
sudo cp deploy/can0.service deploy/can-recorder.service /etc/systemd/system/
sudo cp deploy/99-can-recorder.conf /etc/sysctl.d/
sudo sysctl --system
sudo systemctl daemon-reload
sudo systemctl enable can-recorder can0
sudo systemctl restart can0        # briefly takes the CAN interface down
sudo systemctl start can-recorder
```

Then stop the things that write to the card during a session. These timers catch up soon after boot on a Pi that is usually off, which on a car means the start of every session:

```bash
sudo systemctl mask --now apt-daily.timer apt-daily-upgrade.timer man-db.timer \
  fstrim.timer dpkg-db-backup.timer e2scrub_all.timer
```

Run `sudo fstrim -av` between events instead, because SD cards still benefit from it.

The unit assumes user `base` and `/home/base/data-acquisition`. Change `User=` and `WorkingDirectory=` if the Pi differs.

## Check the SPI link

Run this after any change to the SPI clock or the HAT. SPI has no error checking, and the CAN CRC is checked before a frame crosses SPI, so a bad link corrupts frames silently and the recording's own CRCs would not catch it. This test needs no bus: the controller's loopback mode reads every sent frame back over SPI, and the two copies are compared.

Confirm the clock took effect. The expected output is `0 61 9 0`, which is 4,000,000:

```bash
od -An -tu1 /sys/bus/spi/devices/spi0.0/of_node/spi-max-frequency
```

Then run the loopback test. It takes about a minute, and `can0` is off the bus for that time:

```bash
sudo systemctl stop can-recorder car-telemetry
sudo ip link set can0 down
sudo ip link set can0 up type can bitrate 500000 loopback on
candump -L -x can0 > loop.log &
cangen can0 -g 2 -n 20000 -I 123 -L 8 -D r
sleep 1; kill %1
awk '$4=="T"{print $3}' loop.log > sent; awk '$4=="R"{print $3}' loop.log > back
wc -l sent back                    # both should be 20000
cmp sent back && echo SPI OK
sudo ip link set can0 down
sudo ip link set can0 up type can bitrate 500000 loopback off
sudo systemctl start car-telemetry can-recorder
```

If the files differ, lower `spimaxfrequency` and test again.

## Day to day

```bash
cat /run/can-recorder/status.json              # state, frames, drops, last commit, free space
journalctl -u can-recorder -f
python3 -m src.canlog verify /var/lib/can-recorder
python3 -m src.canlog export /var/lib/can-recorder ~/export --run 12
```

`verify` exits 1 if frames were lost. A torn tail after a power cut is expected and is not counted as a problem.

`export` writes a CSV for the server file uploader. It takes time from the ECU's `VCU_Timestamp` frames when they are present, because the Pi has no RTC battery and has been seen booting 8 days behind. Check the printed time source: `pi-clock` means the exported dates may be wrong. The uploader keeps one row per message per millisecond, so the raw recording remains the complete copy.

Before each session, check that `state` is `recording`, that `last_commit_age_s` is under 1, and that `free_bytes` is sufficient. The recorder never deletes anything. It stops writing when only the ext4 root reserve is left (about 2.5 GB on this card), which keeps the OS running, and holds frames in RAM until the queue fills.

## Power-cut test

This is the only test of whether the card keeps what it acknowledged, and it needs a person to pull the power. The recorder reports each completed commit over the network, then after the reboot `verify` checks that every reported commit is on disk. It needs only a laptop on the same network.

On the laptop:

```bash
nc -ul 5999 | tee -a acks.txt      # macOS: nc -u -l 5999
```

On the Pi, from `universal-telemetry-software/`:

```bash
sudo modprobe vcan
sudo ip link add vcan0 type vcan && sudo ip link set up vcan0
cangen vcan0 -g 1 -I 200 -L 8 &
python3 -m src.can_recorder --iface vcan0 --dir ~/power-cut-test --ack-udp <laptop-ip>:5999
```

Pull the power mid-run. After it boots, copy `acks.txt` to the Pi and run:

```bash
python3 -m src.canlog verify ~/power-cut-test --acks acks.txt
```

Repeat at least 30 times. Any `DURABILITY FAILURE` means the card lied about a flush, so replace it and test again. Run the test once more on every card model the car will use.

## Known gaps

- **The CAN controller can lose frames before Linux sees them.** The MCP2515 has only 2 receive buffers. At the 4 MHz SPI clock, a rough estimate is about 45 µs of SPI time per frame (about 350 µs at the previous 500 kHz), against about 222 µs per 8-byte frame on a full 500 kbps bus. SPI should no longer be the limit, which probably leaves interrupt latency. None of this has been measured. Flood the bus from a second node and watch `hw_overruns_since_boot` to find the real limit.
- **Frames sent before the Pi boots are not recorded.** `can0` currently comes up about 6 s after the kernel starts (1.4 s kernel, 4.5 s userspace), plus firmware time before that. The new `can0.service` should bring this forward. Measure power-on to first frame with a stopwatch.
- **A sustained competing writer still stalls commits for seconds.** A raw device flush alone took up to 3.2 s under a saturating load, so tuning has a floor. A read-only root filesystem with a separate recording partition would remove other writers, and a separate drive would remove the card from the equation. A loop-device test of a dedicated filesystem was inconclusive.
- **One card holds the only copy.** Segments are immutable once rotated, so copying them off the car after each session is simple, but nothing does it yet.
- **No operator indicator yet.** `status.json` has what an LED needs, but `leds.py` does not read it.
- **Run `setup.sh` and `setup-socketcan.sh` with care.** They overwrite `can0.service` and configure the wrong HAT (`mcp251xfd`, 20 MHz, GPIO 25).

## Getting to no loss on power-off

This is not planned for now. The car normally errors out or leaves ready-to-drive and goes idle before low-voltage power is cut, so the lost 0.1-0.2 s normally holds nothing important. It would only matter if low-voltage power drops while driving.

To close the remaining window, use hardware: detect the loss of LV power on a GPIO, and hold the Pi up long enough to finish. That needs something like 30 J (about 8 W for 3 s, plus conversion losses), for example a supercap bank behind a converter. On detection, stop the recorder with SIGTERM, which commits everything queued, then power off. The car has no shutdown path today, so every key-off is a power cut.
