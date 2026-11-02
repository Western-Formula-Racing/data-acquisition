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

`sudo ./setup.sh --car` does all of this on a new Pi, along with the rest of the car's setup. On a Pi that is already set up, run these from `universal-telemetry-software/`, starting with the HAT:

```bash
sudo ./setup-socketcan.sh
```

That script sets the overlay in `/boot/firmware/config.txt` and installs `deploy/can0.service`. If it says a reboot is needed, reboot before continuing. It replaces any older CAN lines and backs up the file first. This is the line it sets:

```
dtoverlay=mcp2515-can0,oscillator=12000000,interrupt=17,spimaxfrequency=4000000
```

Then install the recorder:

```bash
sudo cp deploy/can-recorder.service /etc/systemd/system/
sudo cp deploy/99-can-recorder.conf /etc/sysctl.d/
sudo sysctl --system
sudo systemctl daemon-reload
sudo systemctl enable --now can-recorder
```

Then stop the things that write to the card during a session. These timers catch up soon after boot on a Pi that is usually off, which on a car means the start of every session:

```bash
sudo systemctl mask --now apt-daily.timer apt-daily-upgrade.timer man-db.timer \
  fstrim.timer dpkg-db-backup.timer e2scrub_all.timer
```

Run `sudo fstrim -av` between events instead, because SD cards still benefit from it.

The unit assumes user `base` and `/home/base/data-acquisition`. `setup.sh` fills in the right values automatically. If you install by hand on a Pi that differs, change `User=` and `WorkingDirectory=`.

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
sudo ip link set can0 up type can bitrate 500000 restart-ms 100 loopback on
candump -L can0 > loop.log &
cangen can0 -g 2 -n 20000 -I 123 -L 8 -D r
sleep 1; kill %1
wc -l loop.log                     # should be 40000
awk '{print $3}' loop.log | sort | uniq -c | awk '$1%2{n++} END{print n+0, "frames without a matching copy"}'
sudo ip link set can0 down
sudo ip link set can0 up type can bitrate 500000 restart-ms 100 loopback off
sudo systemctl start car-telemetry can-recorder
```

Each frame should appear twice, once from the local echo and once read back over SPI. If any frame has no matching copy, lower `spimaxfrequency` and test again. Don't compare using the `T` and `R` labels from `candump -x`: frames still queued when `cangen` exits get labelled `R` twice.

Result on 2026-11-01 at 4 MHz: 40,000 frames across this test and a faster one with random IDs and lengths, with no corrupted frames and no controller overruns. This doesn't test the limit on a busy bus, because in loopback the controller only receives what it just sent. It peaked at about 2,400 frames/s.

## Day to day

```bash
cat /run/can-recorder/status.json              # state, frames, drops, last commit, free space
journalctl -u can-recorder -f
python3 -m src.canlog verify /var/lib/can-recorder
python3 -m src.canlog export /var/lib/can-recorder ~/export --run 12
```

`verify` exits 1 if frames were lost. A torn tail after a power cut is expected and is not counted as a problem.

`export` writes a CSV for the server file uploader. It takes time from the ECU's `VCU_Timestamp` frames when they are present, because the Pi has no RTC battery and has been seen booting 8 days behind. Check the printed time source: `pi-clock` means the exported dates may be wrong. The uploader keeps one row per message per millisecond, so the raw recording remains the complete copy.

Before each session, check that `state` is `recording`, that `last_commit_age_s` is under 1, and that `free_bytes` is sufficient. `state` stays `waiting` until the first frame arrives, and `/var/lib/can-recorder` stays empty until then too. The recorder never deletes anything. It stops writing when only the ext4 root reserve is left (about 2.5 GB on this card), which keeps the OS running, and holds frames in RAM until the queue fills.

## Power-cut test

This is the only test of whether the card keeps what it acknowledged. The recorder reports each completed commit to a laptop over the network, and `verify` later checks that every reported commit is still on disk. Someone has to be at the Pi to pull the power.

Repeated power cuts can corrupt or kill an SD card, so push your work and back up anything that only exists on the card first. Test the same card model the car will use.

### 1. Collect the reports on the laptop

Any network path to the Pi works, including Tailscale through a relay. A report still in transit when the power goes is simply lost, which only makes the test a little less strict. On 2026-11-01 the relayed path took about 17 ms, much less than the seconds a card's cache can hold.

**Windows:** in an Administrator PowerShell, let the reports through the firewall. Use the Pi's IP, which `tailscale ip -4` prints on the Pi:

```powershell
New-NetFirewallRule -DisplayName "CAN power-cut test" -Direction Inbound -Protocol UDP -LocalPort 5999 -RemoteAddress <pi-ip> -Action Allow
```

Then paste this into a normal PowerShell window and leave it open for the whole test. It keeps listening while the Pi reboots:

```powershell
$udp = New-Object System.Net.Sockets.UdpClient 5999
$from = New-Object System.Net.IPEndPoint ([System.Net.IPAddress]::Any, 0)
$out = New-Object System.IO.StreamWriter "$HOME\acks.txt", $true
$out.AutoFlush = $true
while ($true) {
    $line = [System.Text.Encoding]::ASCII.GetString($udp.Receive([ref]$from)).Trim()
    $out.WriteLine($line)
    Write-Host -NoNewline "`r$line   "
}
```

**macOS or Linux:** `nc` stops listening to a recorder that restarts, so use this instead:

```bash
python3 -c 'import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(("",5999));[print(s.recv(256).decode().strip(),flush=True) for _ in iter(int,1)]' | tee -a ~/acks.txt
```

### 2. Start the test on the Pi

From `universal-telemetry-software/`, using the laptop's IP (`tailscale status` lists it):

```bash
sudo deploy/power-cut-test.sh start <laptop-ip>
```

Lines like `run=1 frames=900 recorder=ab12cd34` should appear on the laptop within a few seconds. Don't pull the power until they do. If nothing appears, check the IP and the firewall rule.

The test records generated traffic from a virtual CAN interface into `~/power-cut-test`. It starts itself on every boot and doesn't touch `can0`, the real recorder or `/var/lib/can-recorder`.

### 3. Pull the power, at least 30 times

1. Pull the power at the Pi. Remote desktop will drop, which is expected.
2. Wait about 5 seconds, then plug it back in.
3. Watch the laptop until the `run=` number goes up. This usually takes under a minute, and you don't need to log in to the Pi.
4. Wait a varied time, from 5 seconds to 2 minutes, so pulls land at different points in the card's write cycle. Then pull again.

A pull made before the new run number appears still counts as a power cut, but that run isn't checked. Finish with a few cuts using the car's real low-voltage switch, because a slowly sagging supply can behave differently from a clean pull.

### 4. Check the result

Do this after the first few pulls, and again at the end. Copy the reports to the Pi. From Windows:

```powershell
scp $HOME\acks.txt base@<pi-ip>:power-cut-acks.txt
```

The Pi only accepts SSH keys, so this needs the laptop's key in `~/.ssh/authorized_keys`. If it's refused, use Tailscale instead: run `tailscale file cp $HOME\acks.txt base:` on the laptop, then `sudo tailscale file get ~/` on the Pi, and use `~/acks.txt` below. If Windows says the file is in use, close the listener window, copy the file, then paste the listener back in. It appends to the same file.

Then on the Pi, from `universal-telemetry-software/`:

```bash
python3 -m src.canlog verify ~/power-cut-test --acks ~/power-cut-acks.txt; echo "exit $?"
sudo tune2fs -l /dev/mmcblk0p2 | grep -E 'Filesystem state|FS Error count'
journalctl -b -k | grep -iE 'ext4.*(error|corrupt)|mmc.*error|I/O error'
```

| Result | Meaning |
|---|---|
| Exit 0, a run listed for each pull | Every reported commit survived. `torn tail` is expected after a pull. |
| `DURABILITY FAILURE` | The card lost data it said was saved. Replace it and test again. |
| Other `PROBLEM` lines | Data was lost or damaged somewhere else in the run. Keep the card and the files, and investigate before trusting it. |
| Filesystem errors from the last two commands | The cuts damaged the filesystem. Treat the card as failed, even if `verify` passed. |

A passing test only covers that card model, so run it again for any other model the car will use.

### 5. Clean up

Don't skip this. The test otherwise keeps running on every boot and writes about 140 MB/h.

```bash
sudo deploy/power-cut-test.sh stop
rm -rf ~/power-cut-test ~/power-cut-acks.txt
```

On Windows, close the listener window, then run this in an Administrator PowerShell:

```powershell
Remove-NetFirewallRule -DisplayName "CAN power-cut test"
```

## Known gaps

- **The CAN controller can lose frames before Linux sees them.** The MCP2515 has only 2 receive buffers. At the 4 MHz SPI clock, a rough estimate is about 45 µs of SPI time per frame (about 350 µs at the previous 500 kHz), against about 222 µs per 8-byte frame on a full 500 kbps bus. SPI should no longer be the limit, which probably leaves interrupt latency. None of this has been measured. Flood the bus from a second node and watch `hw_overruns_since_boot` to find the real limit.
- **Frames sent before the Pi boots are not recorded.** With `can0.service`, `can0` comes up about 3.4 s after the kernel starts and the recorder is listening at about 3.7 s, plus firmware time before that. Measure power-on to first frame with a stopwatch.
- **A sustained competing writer still stalls commits for seconds.** A raw device flush alone took up to 3.2 s under a saturating load, so tuning has a floor. A read-only root filesystem with a separate recording partition would remove other writers, and a separate drive would remove the card from the equation. A loop-device test of a dedicated filesystem was inconclusive.
- **One card holds the only copy.** Segments are immutable once rotated, so copying them off the car after each session is simple, but nothing does it yet.
- **No operator indicator yet.** `status.json` has what an LED needs, but `leds.py` does not read it.

## Getting to no loss on power-off

This is not planned for now. The car normally errors out or leaves ready-to-drive and goes idle before low-voltage power is cut, so the lost 0.1-0.2 s normally holds nothing important. It would only matter if low-voltage power drops while driving.

To close the remaining window, use hardware: detect the loss of LV power on a GPIO, and hold the Pi up long enough to finish. That needs something like 30 J (about 8 W for 3 s, plus conversion losses), for example a supercap bank behind a converter. On detection, stop the recorder with SIGTERM, which commits everything queued, then power off. The car has no shutdown path today, so every key-off is a power cut.
