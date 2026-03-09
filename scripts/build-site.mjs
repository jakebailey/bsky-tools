import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dirname, "..", "dist");
mkdirSync(distDir, { recursive: true });

// Copy each package's build output into the combined dist
const packages = ["modlist-finder", "network-overlap"];
for (const pkg of packages) {
    const src = join(import.meta.dirname, "..", "packages", pkg, "dist");
    const dest = join(distDir, pkg);
    cpSync(src, dest, { recursive: true });
}

// Create a root index.html that links to both tools
const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bluesky Tools</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/dark.min.css" />
    <style>
        h1 { text-align: center; }
        .tools { list-style: none; padding: 0; max-width: 600px; margin: 2rem auto; }
        .tools li { margin: 1rem 0; }
        .tools a { font-size: 1.2em; }
        .tools p { margin: 0.25rem 0 0 0; opacity: 0.7; }
    </style>
</head>
<body>
    <h1>Bluesky Tools</h1>
    <ul class="tools">
        <li>
            <a href="./modlist-finder/">Moderation List Finder</a>
            <p>Find moderation lists that include a given user, sorted by the list authors' follower count.</p>
        </li>
        <li>
            <a href="./network-overlap/">Network Overlap</a>
            <p>Compare the followers and follows of two Bluesky users to find shared connections.</p>
        </li>
    </ul>
</body>
</html>`;

writeFileSync(join(distDir, "index.html"), html);
console.log("Site built to dist/");
