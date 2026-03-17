# PECAN Components Documentation

This directory contains reusable React components for the PECAN dashboard.

## TracePanel

The `TracePanel` component is a floating, draggable, and resizable window designed to monitor CAN traffic in real-time. It is highly reusable and can be integrated into any page within the application to provide a compact view of the CAN bus.

#### Use Case: Throttle Mapper
In the `ThrottleMapper` page, the `TracePanel` could be used to:
- Monitor the `TX` messages being sent to the ECU.
- Verify that the `RX` signals from sensors are being received as expected.
- Debug the interaction between the mapper logic and the physical/simulated CAN bus without navigating away from the tuning interface.

### Functionality and Props

#### Props (`TracePanelProps`)

| Prop | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `direction` | `"all" \| "rx" \| "tx"` | `"tx"` | Filters traffic by direction. |
| `maxRows` | `number` | `80` | Maximum number of rows to display in the buffer. |
| `filter` | `string` | `undefined` | Optional search term to filter message IDs or names. |
| `onClose` | `() => void` | `undefined` | Callback function executed when the panel is closed. |
| `initialOffset` | `{ x: number; y: number }` | `{ x: 0, y: 0 }` | Offset from the default bottom-right position. |

#### Core Functions

- **`handlePause()`**: Freezes the live stream of CAN frames. It takes a snapshot of the current frames in the buffer so the user can inspect them without the table scrolling as new data arrives.
- **`handleClear()`**: Resets the trace buffer in the global data store and clears the local snapshot.
- **`formatTimestamp(ts: number)`**: Utility function that converts a numeric timestamp into a human-readable string format: `HH:MM:SS.mmm`.

### Component Features

- **Draggable Header**: Users can move the panel by clicking and dragging the top header bar.
- **Resize Handle**: A small handle in the bottom-right corner allows for manual resizing of the window.
- **Onboarding Tour**: Integrated with `TourGuide` to explain the features to new users.
- **Collapsible State**: The panel can be closed to a small floating "CAN TRACE" button and reopened at any time.

### Example Usage

```tsx
import TracePanel from "../components/TracePanel";

function YourPage() {
  return (
    <div>
      {/* Page Content */}
      <h1>My Content</h1>
      
      {/* Floating Trace Window */}
      <TracePanel 
        direction="all" 
        maxRows={100} 
        filter="ECU" 
      />
    </div>
  );
}
```
