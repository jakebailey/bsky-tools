import { render } from "@solidjs/web";
import App from "./App";

const root = document.getElementById("root");
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
    throw new Error("Root element not found.");
}
render(() => <App />, root!);
