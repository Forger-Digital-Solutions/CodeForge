import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { installAuthenticatedControlPlaneFetch } from "./control-plane.js";
import "./styles.css";
import "./settings.css";

installAuthenticatedControlPlaneFetch();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
