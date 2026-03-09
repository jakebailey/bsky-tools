import type { AppBskyActorDefs } from "@atcute/bluesky";
import { Client, ok, simpleFetchHandler } from "@atcute/client";
import { isActorIdentifier } from "@atcute/lexicons/syntax";
import type { ActorIdentifier } from "@atcute/lexicons/syntax";

export type { ActorIdentifier } from "@atcute/lexicons/syntax";
export type ProfileView = AppBskyActorDefs.ProfileView;
export type ProfileViewDetailed = AppBskyActorDefs.ProfileViewDetailed;

export const rpc = new Client({
    handler: simpleFetchHandler({ service: "https://public.api.bsky.app" }),
});

export function chunked<A>(array: A[], size: number): A[][] {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

export async function getProfile(handle: string): Promise<ProfileViewDetailed> {
    if (!isActorIdentifier(handle)) {
        throw new Error(`Invalid handle: ${handle}`);
    }
    return ok(rpc.get("app.bsky.actor.getProfile", { params: { actor: handle } }));
}

export async function getProfiles(actors: ActorIdentifier[]): Promise<Map<string, ProfileViewDetailed>> {
    const map = new Map<string, ProfileViewDetailed>();
    const chunks = chunked(actors, 25);
    const results = await Promise.all(
        chunks.map((chunk) => ok(rpc.get("app.bsky.actor.getProfiles", { params: { actors: chunk } }))),
    );
    for (const { profiles } of results) {
        for (const profile of profiles) {
            map.set(profile.did, profile);
        }
    }
    return map;
}
