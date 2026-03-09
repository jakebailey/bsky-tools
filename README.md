# bsky-tools

A collection of Bluesky tools, deployed to
[jakebailey.dev/bsky-tools](https://jakebailey.dev/bsky-tools).

## Tools

- **[Moderation List Finder](https://jakebailey.dev/bsky-tools/modlist-finder/)**
  — Find moderation lists that include a given user, sorted by the list authors'
  follower count.
- **[Network Overlap](https://jakebailey.dev/bsky-tools/network-overlap/)** —
  Compare the followers and follows of two Bluesky users to find shared
  connections.

## Development

```bash
pnpm install
pnpm dev:modlist-finder
pnpm dev:network-overlap
```

## Build

```bash
pnpm build:site
```

This builds all packages and assembles a combined site in `dist/`.
