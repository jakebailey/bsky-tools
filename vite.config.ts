import solidPlugin from "@solidjs/vite-plugin";
import { resolve } from "node:path";
import { defineConfig } from "vite";

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
                "block-connections": resolve(import.meta.dirname, "block-connections/index.html"),
                "modlist-finder": resolve(import.meta.dirname, "modlist-finder/index.html"),
                "network-overlap": resolve(import.meta.dirname, "network-overlap/index.html"),
                "inner-circle": resolve(import.meta.dirname, "inner-circle/index.html"),
            },
        },
    },
});
