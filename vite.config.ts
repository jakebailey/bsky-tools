import { resolve } from "node:path";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
    base: "./",
    plugins: [
        solidPlugin(),
    ],
    server: {
        port: 3000,
    },
    build: {
        target: "esnext",
        rollupOptions: {
            input: {
                main: resolve(import.meta.dirname, "index.html"),
                "modlist-finder": resolve(import.meta.dirname, "modlist-finder/index.html"),
                "network-overlap": resolve(import.meta.dirname, "network-overlap/index.html"),
            },
        },
    },
});
