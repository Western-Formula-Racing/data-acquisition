# How to Import Custom Grafana Dashboards

## 📊 **Dashboard Provisioning Guide**

Grafana can automatically provision dashboards from JSON files on startup. Here's how to set it up:

### **Method 1: Direct JSON Import (Recommended)**

1. **Export your dashboard** from an existing Grafana instance:
   - Go to Dashboard → Share → Export
   - Save as JSON file (e.g., `my-custom-dashboard.json`)

2. **Place JSON file** in the dashboards directory:
   ```bash
   cp your-dashboard.json /path/to/installer/grafana/dashboards/
   ```

3. **Restart Grafana** to auto-import:
   ```bash
   docker-compose restart grafana
   ```

### **Method 2: Grafana.com Dashboard Import**

If you have a dashboard ID from grafana.com:

1. **Download the JSON**:
   ```bash
   curl -o grafana/dashboards/imported-dashboard.json \
     "https://grafana.com/api/dashboards/[DASHBOARD_ID]/revisions/[REVISION]/download"
   ```

2. **Edit the JSON** to fix datasource references (see below)

### **Method 3: Multiple Dashboard Setup**

Create multiple dashboard files:
```bash
grafana/dashboards/
├── wfr-daq-overview.json          # System overview
├── can-data-analysis.json         # CAN bus analysis  
├── engine-telemetry.json          # Engine monitoring
├── lap-timing-dashboard.json      # Lap analysis
└── system-health.json             # Infrastructure monitoring
```

## 🔧 **Dashboard JSON Preparation**

### **Required JSON Modifications**

When importing external dashboards, you need to update datasource references:

```json
{
  "dashboard": {
    "panels": [
      {
        "datasource": {
          "type": "influxdb",
          "uid": "influxdb-wfr-v2"    // Must match your datasource UID
        }
      }
    ]
  }
}
```

### **Datasource UID Reference**
Your current InfluxDB datasource UID: `influxdb-wfr-v2`


## 🚀 **Quick Setup Steps**

### **For Custom Dashboard:**

1. **Create your dashboard** in Grafana UI first
2. **Export as JSON**:
   ```bash
   # In Grafana: Dashboard Settings → JSON Model → Copy JSON
   ```

3. **Save to file**:
   ```bash
   # Paste JSON content into:
   nano grafana/dashboards/my-racing-dashboard.json
   ```

4. **Restart to apply**:
   ```bash
   docker-compose restart grafana
   ```

### **For Pre-made Dashboard:**

If you have a JSON file ready:

```bash
# Copy your dashboard JSON
cp ~/Downloads/racing-telemetry.json \\
   installer/grafana/dashboards/

# Restart Grafana
docker-compose restart grafana
```

## 🔍 **Verification**

After restart, check that dashboards are provisioned:

1. **Log into Grafana**: http://localhost:8087
2. **Check dashboards**: Should appear in "General" or "DAQ System" folder
3. **Verify data**: Ensure queries work with your InfluxDB data

## 📝 **Dashboard Development Workflow**

1. **Develop in UI**: Create/edit dashboards in Grafana web interface
2. **Export JSON**: Copy dashboard JSON model  
3. **Save to file**: Place in `grafana/dashboards/`
4. **Version control**: Commit JSON files to git
5. **Auto-deploy**: New instances get dashboards automatically

## 🎯 **Data Source Configuration**

All dashboard queries should reference your InfluxDB setup:
- **Bucket**: `ourCar` or `WFR2025` ...
- **Organization**: `WFR`
- **Datasource UID**: `influxdb-wfr-v2`

## 💡 **Pro Tips**

1. **Use template variables** for dynamic filtering
2. **Set appropriate time ranges** for racing sessions
3. **Configure alerts** for critical thresholds
4. **Use dashboard folders** to organize by category
5. **Include documentation** panels for context

This setup ensures your custom dashboards are automatically available on every deployment! 🏁
