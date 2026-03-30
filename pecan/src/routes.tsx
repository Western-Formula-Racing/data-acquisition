import { createBrowserRouter } from "react-router";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import Accumulator from "./pages/Accumulator";
import Account from "./pages/Account";
import ChargeCart from "./pages/ChargeCart";
import MonitorBuilder from "./pages/MonitorBuilder";
import Comms from "./pages/Comms";
import SystemLink from "./pages/SystemLink";
import Landing from "./pages/Landing";
import ThrottleMapper from "./pages/ThrottleMapper";
import SensorValidator from "./pages/SensorValidator";
import Trace from "./pages/Trace";
import ReplayViewer from "./pages/ReplayViewer";
// import TxDashboard from "./pages/TxDashboard";
import DataTransmitter from "./pages/Transmitter";


// Get base path for GitHub Pages deployment
const basename = import.meta.env.BASE_URL || '/';


export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    //Pages are separate components, to add a route that is related to '/' just add a child, path is the relative path
    children: [
      { index: true, element: <Landing /> },
      { path: "dashboard", element: <Dashboard /> },
      { path: "accumulator", element: <Accumulator /> },
      { path: "account", element: <Account /> },
      // Settings managed via modal now
      { path: "chargecart", element: <ChargeCart /> },
      { path: "monitor-builder", element: <MonitorBuilder /> },
      { path: "comms", element: <Comms /> },
      { path: "system-link", element: <SystemLink /> },
      { path: "throttle-mapper", element: <ThrottleMapper /> },
      { path: "sensor-validator", element: <SensorValidator /> },
      { path: "trace", element: <Trace /> },
      { path: "replay-viewer", element: <ReplayViewer /> },
       // { path: "tx", element: <TxDashboard /> },
      { path: "can-transmitter", element: <DataTransmitter /> },
    ],
  },

], { basename });
