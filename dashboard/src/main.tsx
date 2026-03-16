import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { UserProvider } from "./components/UserProvider";
import { VMHeaderProvider } from "./components/VMHeaderContext";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <UserProvider>
        <BrowserRouter>
          <VMHeaderProvider>
            <App />
          </VMHeaderProvider>
        </BrowserRouter>
      </UserProvider>
    </ToastProvider>
  </StrictMode>
);
