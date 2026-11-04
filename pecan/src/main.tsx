import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { ThemeProvider } from "next-themes";
import "./index.css";
import { router } from "./routes";
import { TimelineProvider } from "./context/TimelineContext";
import { loadBaseStationConfig } from "./lib/baseStation";

const defaultTheme = import.meta.env.VITE_INTERNAL ? "internal" : "dark";

// Routes and the sidebar depend on this, so it has to be known before first render.
void loadBaseStationConfig().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <ThemeProvider
      attribute="class"
      storageKey="pecan:theme"
      defaultTheme={defaultTheme}
      themes={["dark", "light", "internal", "local-can"]}
      value={{
        dark: "theme-dark",
        light: "theme-light",
        internal: "theme-internal",
        "local-can": "theme-local-can",
      }}
      enableSystem={false}
      disableTransitionOnChange
    >
      <TimelineProvider>
        <RouterProvider router={router} />
      </TimelineProvider>
    </ThemeProvider>
  );
});
