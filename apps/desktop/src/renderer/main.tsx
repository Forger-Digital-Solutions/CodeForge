import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { markRendererLifecycle } from "./lifecycle.js";
import "./styles.css";
import "./settings.css";

markRendererLifecycle("bootstrap");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
