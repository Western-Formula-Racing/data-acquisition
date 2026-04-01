import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router";
import App from "./App";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Accumulator = lazy(() => import("./pages/Accumulator"));
const Account = lazy(() => import("./pages/Account"));
const ChargeCart = lazy(() => import("./pages/ChargeCart"));
const MonitorBuilder = lazy(() => import("./pages/MonitorBuilder"));
const Comms = lazy(() => import("./pages/Comms"));
const SystemLink = lazy(() => import("./pages/SystemLink"));
const Landing = lazy(() => import("./pages/Landing"));
const ThrottleMapper = lazy(() => import("./pages/ThrottleMapper"));
const SensorValidator = lazy(() => import("./pages/SensorValidator"));
const Trace = lazy(() => import("./pages/Trace"));
const DataTransmitter = lazy(() => import("./pages/Transmitter"));

// Get base path for GitHub Pages deployment
const basename = import.meta.env.BASE_URL || '/';

const Fallback = () => null;

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    //Pages are separate components, to add a route that is related to '/' just add a child, path is the relative path
    children: [
      { index: true, element: <Suspense fallback={<Fallback />}><Landing /></Suspense> },
      { path: "dashboard", element: <Suspense fallback={<Fallback />}><Dashboard /></Suspense> },
      { path: "accumulator", element: <Suspense fallback={<Fallback />}><Accumulator /></Suspense> },
      { path: "account", element: <Suspense fallback={<Fallback />}><Account /></Suspense> },
      { path: "chargecart", element: <Suspense fallback={<Fallback />}><ChargeCart /></Suspense> },
      { path: "monitor-builder", element: <Suspense fallback={<Fallback />}><MonitorBuilder /></Suspense> },
      { path: "comms", element: <Suspense fallback={<Fallback />}><Comms /></Suspense> },
      { path: "system-link", element: <Suspense fallback={<Fallback />}><SystemLink /></Suspense> },
      { path: "throttle-mapper", element: <Suspense fallback={<Fallback />}><ThrottleMapper /></Suspense> },
      { path: "sensor-validator", element: <Suspense fallback={<Fallback />}><SensorValidator /></Suspense> },
      { path: "trace", element: <Suspense fallback={<Fallback />}><Trace /></Suspense> },
      { path: "replay-viewer", element: <Suspense fallback={<Fallback />}><Dashboard /></Suspense> },
      { path: "can-transmitter", element: <Suspense fallback={<Fallback />}><DataTransmitter /></Suspense> },
    ],
  },

], { basename });
