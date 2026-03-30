import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import "./index.css";
import { router } from "./routes";
import { TimelineProvider } from "./context/TimelineContext";


createRoot(document.getElementById("root")!).render(
  <TimelineProvider>
    <RouterProvider router={router} />
  </TimelineProvider>
);
