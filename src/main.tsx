import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import "./index.css";
import { beforeSend } from "./sentry-before-send";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  initialScope: { tags: { repo: "hq-installer-web" } },
  release: `hq-installer-web@${__APP_VERSION__}`,
  beforeSend,
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
